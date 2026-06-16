import type { IMemoryRepository } from '../repository/interface.js';
import type { AddMemoryInput } from '../schema/memory.js';
import { Provenance, TrustClass, ReviewStatus, MemorySource, type TrustAction } from '../schema/memory.js';
import type { DedupResult } from './dedup.js';
import type { ValidationResult } from './validators.js';
import { sanitizeFTSQuery } from '../retrieval/lexical.js';
import { claimsRelated } from './claim-similarity.js';
import { isSingleValuedSubject } from './subject-cardinality.js';
import { isTestMode } from './test-mode.js';
import { recordDecision } from '../telemetry/index.js';

/**
 * Trust branching: deterministic classifier.
 * Zero LLM calls. Pure logic on input properties.
 *
 * Decision tree:
 * 1. Validation failed? → REJECT
 * 2. Duplicate? → REJECT
 * 3. User source + high confidence + only-supersedes? → AUTO-CONFIRM (with supersedes)
 * 4. User source + high confidence + genuine conflicts? → QUARANTINE (production) / AUTO-CONFIRM with conflicts surfaced (TEST_MODE)
 * 5. LLM source + above threshold + only-supersedes? → AUTO-STORE (with supersedes)
 * 6. LLM source + above threshold + genuine conflicts? → QUARANTINE
 * 7. Below confidence threshold? → QUARANTINE
 * 8. Import source? → QUARANTINE (untrusted until reviewed)
 *
 * S49: split conflicts into two buckets:
 *   - supersedes:  existing memories the new write should temporally replace
 *                  (older validFrom/validAt than the new write's validFrom).
 *                  Auto-process: write/index.ts sets invalid_at on these.
 *   - conflictsWith: genuine conflicts with no clear temporal ordering.
 *                  Route to consensus quarantine (production) as before.
 *
 * This fixes brain #1896 / #1908: "conflicts cause quarantine" and
 * "conflicts trigger supersession" can both fire correctly when we know
 * which kind of conflict it is.
 */

export interface TrustBranchResult {
  action: TrustAction;
  trustClass: TrustClass;
  provenance: Provenance;
  reviewStatus: ReviewStatus;
  reason: string;
  conflictsWith: string[];
  /**
   * S49: existing memory IDs the new write should temporally supersede.
   * write/index.ts sets invalid_at on these after the new memory is stored.
   * Empty when no temporal ordering is detectable.
   */
  supersedes: string[];
  needsConsensus: boolean;
  needsSpotCheck: boolean;
}

export interface TrustBranchConfig {
  confidenceThreshold: number;
  spotCheckRate: number;
  consensusThreshold: number;
}

/**
 * Result of conflict scan: existing memories split by temporal relationship
 * to the new input.
 */
interface ConflictScan {
  /** Existing IDs the new write should supersede (older validAt than new validFrom). */
  supersedes: string[];
  /** Existing IDs that conflict but have no clear temporal ordering. */
  conflicts: string[];
}

/**
 * Find existing memories that conflict with the new claim.
 * A conflict is defined as: same subject, different claim, claims related.
 * Then split the conflicts by temporal ordering vs the new input's validFrom.
 *
 * V1: simple subject-match check. V2: semantic contradiction
 * detection via LLM (part of consensus escalation).
 *
 * S49: also returns supersedes (older facts the new write replaces).
 */
async function findConflicts(
  repo: IMemoryRepository,
  subject: string,
  claim: string,
  userId: string,
  newValidFrom: string | undefined,
): Promise<ConflictScan> {
  // Sanitize subject for FTS5 (hyphens are NOT operators, not negation)
  const ftsSubject = sanitizeFTSQuery(subject);
  if (!ftsSubject) return { supersedes: [], conflicts: [] };

  // Cardinality gate (refusal-first): only single-valued subjects (one current
  // value per user, e.g. location, employer) may supersede or conflict.
  // Multi-valued and unknown subjects (languages, hobbies, likes) are additive:
  // same-subject related claims accumulate and must never supersede each other.
  // Unknown subjects default to multi-valued so a valid fact is never destroyed
  // on an unrecognized subject. Fixes lexical-Jaccard over-supersession, where
  // "speaks Spanish" would otherwise supersede "speaks English".
  if (!isSingleValuedSubject(subject)) return { supersedes: [], conflicts: [] };

  // Search for memories with the same subject (scoped to this user)
  const candidates = await repo.searchFTS(ftsSubject, 20, userId);

  const supersedes: string[] = [];
  const conflicts: string[] = [];
  const normalizedClaim = claim.toLowerCase().trim();

  // Anchor for temporal comparison: prefer explicit validFrom; if absent, no anchor.
  const newAnchor = newValidFrom ? Date.parse(newValidFrom) : NaN;

  for (const candidate of candidates) {
    const record = candidate.record;

    // Skip rejected/deleted memories
    if (record.trustClass === TrustClass.REJECTED) continue;

    // Same subject, different claim, AND claims are about the same topic
    if (
      record.subject.toLowerCase() === subject.toLowerCase() &&
      record.claim.toLowerCase().trim() !== normalizedClaim &&
      claimsRelated(claim, record.claim)
    ) {
      // S49: classify temporal relationship.
      // Existing fact's anchor: validAt (Packet A canonical) → validFrom (legacy) → createdAt
      const existingAnchorStr = record.validAt ?? record.validFrom ?? record.createdAt;
      const existingAnchor = existingAnchorStr ? Date.parse(existingAnchorStr) : NaN;

      // A conflict counts as supersede only when BOTH anchors are present
      // AND the existing fact is strictly older than the new one.
      // Without explicit ordering, treat as a genuine conflict (current behavior).
      if (Number.isFinite(newAnchor) && Number.isFinite(existingAnchor) && existingAnchor < newAnchor) {
        supersedes.push(record.id);
      } else {
        conflicts.push(record.id);
      }
    }
  }

  return { supersedes, conflicts };
}

/**
 * Determine the confidence for this input.
 * User-provided confidence takes priority.
 * Otherwise, source-based defaults.
 * S2: Exported so write pipeline uses the SAME resolved value for storage.
 */
export function resolveConfidence(input: AddMemoryInput): number {
  if (input.confidence !== undefined) return input.confidence;

  switch (input.source) {
    case MemorySource.USER:
      return 0.95;
    case MemorySource.LLM:
      return 0.7;
    case MemorySource.IMPORT:
      return 0.5;
    default:
      return 0.5;
  }
}

/**
 * 10% spot-check lottery. Deterministic-ish via Math.random().
 * In production, this means ~10% of auto-approved memories
 * get flagged for human review.
 */
function rollSpotCheck(rate: number): boolean {
  return Math.random() < rate;
}

/**
 * Main trust branching classifier.
 * Returns the branch decision with all metadata needed
 * for the write pipeline to proceed.
 */
export async function classifyTrust(
  input: AddMemoryInput,
  repo: IMemoryRepository,
  config: TrustBranchConfig,
  validation: ValidationResult,
  dedup: DedupResult,
  userId: string = 'system',
): Promise<TrustBranchResult> {
  const confidence = resolveConfidence(input);
  const result = await classifyTrustInner(input, repo, config, validation, dedup, userId, confidence);
  recordDecision({
    decision_type: 'trust_branch',
    branch_taken: result.action,
    confidence,
    outcome: result.action,
  });
  return result;
}

async function classifyTrustInner(
  input: AddMemoryInput,
  repo: IMemoryRepository,
  config: TrustBranchConfig,
  validation: ValidationResult,
  dedup: DedupResult,
  userId: string,
  confidence: number,
): Promise<TrustBranchResult> {
  const subject = input.subject || 'unknown';

  // --- Branch 4: REJECT (validation or dedup failure) ---

  if (!validation.valid) {
    // S83: injection-pattern hits on source=import are QUARANTINED, not
    // rejected. Quarantine preserves the S53 invariant (the row never enters
    // the retrieval pool) while the confirm ceremony adjudicates: technical
    // corpora (SQL notes, prompt-engineering and security lessons)
    // legitimately contain the screened patterns.
    // S84: content-quality heuristic hits on imports follow the same rule.
    // The S83 backfill silently dropped 523 legitimate long technical rows
    // to the length-confounded diversity check (brain #3534). Reviewable
    // reasons are enumerated; duplicates still reject (S75 dedup is
    // unconditional), and every other validation failure or source still
    // rejects outright.
    const importReviewable = [
      'Injection pattern:',
      'Rejected: extremely low character diversity',
      'Repetitive character pattern detected',
    ];
    if (
      input.source === MemorySource.IMPORT &&
      importReviewable.some((p) => validation.reason?.startsWith(p)) &&
      !dedup.isDuplicate
    ) {
      return {
        action: 'quarantined',
        trustClass: TrustClass.QUARANTINED,
        provenance: Provenance.IMPORTED,
        reviewStatus: ReviewStatus.PENDING,
        reason: `Held for review (import): ${validation.reason}`,
        conflictsWith: [],
        supersedes: [],
        needsConsensus: false,
        needsSpotCheck: false,
      };
    }
    return {
      action: 'rejected',
      trustClass: TrustClass.REJECTED,
      provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
      reviewStatus: ReviewStatus.REJECTED,
      reason: `Validation failed: ${validation.reason}`,
      conflictsWith: [],
      supersedes: [],
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // S75 (brain #2594): dedup is UNCONDITIONAL. Every bench, every fixture,
  // every commit runs dedup the same way production does. The previous
  // BENCH_SKIP_DEDUP escape made bench scores lie (brain #2123 + #2594)
  // and re-introduced the same cheat shape that S65 council reconciliation
  // was supposed to close. If a bench fixture collides at cosine 0.95,
  // rebuild the fixture with rejection sampling (see
  // src/benchmark/cross-session-temporal/bake.ts for the canonical pattern).
  if (dedup.isDuplicate) {
    return {
      action: 'rejected',
      trustClass: TrustClass.REJECTED,
      provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
      reviewStatus: ReviewStatus.REJECTED,
      reason: `Duplicate (${dedup.matchType}): existing ID ${dedup.existingId}`,
      conflictsWith: [],
      supersedes: [],
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Check for conflicts with existing memories (S49: split by temporal ordering) ---

  const { supersedes, conflicts } = await findConflicts(repo, subject, input.claim, userId, input.validFrom);

  // --- Branch 1: AUTO-CONFIRM (user source, high confidence) ---
  // S49: temporally-ordered supersedes never quarantine, they're explicit
  // updates. Genuine conflicts (no temporal ordering) still quarantine in
  // production. C1 council ruling preserved for non-temporal conflicts.

  if (input.source === MemorySource.USER && confidence >= config.confidenceThreshold) {
    // Genuine conflicts (no temporal ordering) → quarantine in production,
    // bypass in TEST_MODE for benchmark seeding throughput.
    // S49: conflictsWith is now POPULATED on TEST_MODE bypass too, fixes
    // the info-loss bug that prevented downstream supersession code from
    // firing under TEST_MODE.
    if (conflicts.length > 0 && !isTestMode()) {
      return {
        action: 'quarantined',
        trustClass: TrustClass.QUARANTINED,
        provenance: Provenance.USER_CONFIRMED,
        reviewStatus: ReviewStatus.PENDING,
        reason: `User memory conflicts with ${conflicts.length} existing memories, requires consensus`,
        conflictsWith: conflicts,
        supersedes,
        needsConsensus: true,
        needsSpotCheck: false,
      };
    }

    // Auto-confirm path: covers (a) no conflicts of any kind, (b) only
    // supersedes (no genuine conflicts), (c) TEST_MODE bypass.
    const reason =
      supersedes.length > 0
        ? `User-stated memory, auto-confirmed (supersedes ${supersedes.length} prior)`
        : conflicts.length > 0
          ? `User-stated memory, auto-confirmed (TEST_MODE; ${conflicts.length} non-temporal conflicts surfaced)`
          : 'User-stated memory, auto-confirmed';

    return {
      action: 'confirmed',
      trustClass: TrustClass.CONFIRMED,
      provenance: Provenance.USER_CONFIRMED,
      reviewStatus: ReviewStatus.APPROVED,
      reason,
      conflictsWith: conflicts,
      supersedes,
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Branch 3: QUARANTINE (genuine conflicts, low confidence, import) ---

  // Genuine conflicts (no temporal ordering) → quarantine + flag for consensus.
  // S49: temporally-ordered supersedes alone do NOT trigger quarantine; they're
  // an explicit update path.
  if (conflicts.length > 0) {
    return {
      action: 'quarantined',
      trustClass: TrustClass.QUARANTINED,
      provenance: input.source === MemorySource.LLM ? Provenance.LLM_EXTRACTED_QUARANTINE : Provenance.IMPORTED,
      reviewStatus: ReviewStatus.PENDING,
      reason: `Conflicts with ${conflicts.length} existing memories`,
      conflictsWith: conflicts,
      supersedes,
      needsConsensus: true,
      needsSpotCheck: false,
    };
  }

  // Below confidence threshold → quarantine
  if (confidence < config.confidenceThreshold) {
    return {
      action: 'quarantined',
      trustClass: TrustClass.QUARANTINED,
      provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
      reviewStatus: ReviewStatus.PENDING,
      reason: `Low confidence (${confidence.toFixed(2)} < ${config.confidenceThreshold})`,
      conflictsWith: [],
      supersedes,
      needsConsensus: confidence < config.consensusThreshold,
      needsSpotCheck: false,
    };
  }

  // Import source → always quarantine
  if (input.source === MemorySource.IMPORT) {
    return {
      action: 'quarantined',
      trustClass: TrustClass.QUARANTINED,
      provenance: Provenance.IMPORTED,
      reviewStatus: ReviewStatus.PENDING,
      reason: 'Imported memory requires review',
      conflictsWith: [],
      supersedes,
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Branch 2: AUTO-STORE + spot-check lottery ---
  // S49: LLM source with only-supersedes (no genuine conflicts) takes this
  // path with supersedes populated. write/index.ts will set invalid_at on
  // the prior facts.

  const needsSpotCheck = rollSpotCheck(config.spotCheckRate);

  return {
    action: 'stored',
    trustClass: TrustClass.AUTO_APPROVED,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    reviewStatus: ReviewStatus.APPROVED,
    reason: needsSpotCheck
      ? supersedes.length > 0
        ? `Auto-approved (flagged for spot-check; supersedes ${supersedes.length} prior)`
        : 'Auto-approved (flagged for spot-check)'
      : supersedes.length > 0
        ? `Auto-approved (supersedes ${supersedes.length} prior)`
        : 'Auto-approved',
    conflictsWith: [],
    supersedes,
    needsConsensus: false,
    needsSpotCheck,
  };
}
