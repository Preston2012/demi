import type { IMemoryRepository } from '../repository/interface.js';
import type { AddMemoryInput } from '../schema/memory.js';
import { Provenance, TrustClass, ReviewStatus, MemorySource, type TrustAction } from '../schema/memory.js';
import type { DedupResult } from './dedup.js';
import type { ValidationResult } from './validators.js';
import { sanitizeFTSQuery } from '../retrieval/lexical.js';
import { claimsRelated } from './claim-similarity.js';

/**
 * Trust branching: deterministic classifier.
 * Zero LLM calls. Pure logic on input properties.
 *
 * Decision tree:
 * 1. Validation failed? → REJECT
 * 2. Duplicate? → REJECT
 * 3. User source + high confidence? → AUTO-CONFIRM
 * 4. LLM source + above threshold? → AUTO-STORE (+ spot-check lottery)
 * 5. Conflicts with existing? → QUARANTINE
 * 6. Below confidence threshold? → QUARANTINE
 * 7. Import source? → QUARANTINE (untrusted until reviewed)
 */

export interface TrustBranchResult {
  action: TrustAction;
  trustClass: TrustClass;
  provenance: Provenance;
  reviewStatus: ReviewStatus;
  reason: string;
  conflictsWith: string[];
  needsConsensus: boolean;
  needsSpotCheck: boolean;
}

export interface TrustBranchConfig {
  confidenceThreshold: number;
  spotCheckRate: number;
  consensusThreshold: number;
}

/**
 * Find existing memories that conflict with the new claim.
 * A conflict is defined as: same subject, different claim.
 * Uses FTS to find memories about the same subject, then
 * checks if any make contradictory statements.
 *
 * V1: simple subject-match check. V2: semantic contradiction
 * detection via LLM (part of consensus escalation).
 */
async function findConflicts(repo: IMemoryRepository, subject: string, claim: string): Promise<string[]> {
  // Sanitize subject for FTS5 (hyphens are NOT operators, not negation)
  const ftsSubject = sanitizeFTSQuery(subject);
  if (!ftsSubject) return [];

  // Search for memories with the same subject
  const candidates = await repo.searchFTS(ftsSubject, 20);

  const conflicts: string[] = [];
  const normalizedClaim = claim.toLowerCase().trim();

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
      conflicts.push(record.id);
    }
  }

  return conflicts;
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
): Promise<TrustBranchResult> {
  const confidence = resolveConfidence(input);
  const subject = input.subject || 'unknown';

  // --- Branch 4: REJECT (validation or dedup failure) ---

  if (!validation.valid) {
    return {
      action: 'rejected',
      trustClass: TrustClass.REJECTED,
      provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
      reviewStatus: ReviewStatus.REJECTED,
      reason: `Validation failed: ${validation.reason}`,
      conflictsWith: [],
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  if (dedup.isDuplicate) {
    return {
      action: 'rejected',
      trustClass: TrustClass.REJECTED,
      provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
      reviewStatus: ReviewStatus.REJECTED,
      reason: `Duplicate (${dedup.matchType}): existing ID ${dedup.existingId}`,
      conflictsWith: [],
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Check for conflicts with existing memories ---

  const conflicts = await findConflicts(repo, subject, input.claim);

  // --- Branch 1: AUTO-CONFIRM (user source, high confidence, NO conflicts) ---
  // C1: User source with conflicts MUST go to consensus, not auto-confirm.
  // Without this, source="user" + high confidence bypasses conflict quarantine.

  if (input.source === MemorySource.USER && confidence >= config.confidenceThreshold) {
    // TEST_MODE bypass: enables benchmark seeding to write user-sourced facts
    // without conflict quarantine (d9a1e0b). Benchmark-only — production runs
    // do NOT set TEST_MODE, so conflict quarantine (C1 council ruling) applies
    // as intended. See S30 plan C6 for reasoning to keep this path.
    if (conflicts.length > 0 && process.env.TEST_MODE !== 'true') {
      // User memory conflicts with existing: quarantine + consensus
      return {
        action: 'quarantined',
        trustClass: TrustClass.QUARANTINED,
        provenance: Provenance.USER_CONFIRMED,
        reviewStatus: ReviewStatus.PENDING,
        reason: `User memory conflicts with ${conflicts.length} existing memories, requires consensus`,
        conflictsWith: conflicts,
        needsConsensus: true,
        needsSpotCheck: false,
      };
    }
    return {
      action: 'confirmed',
      trustClass: TrustClass.CONFIRMED,
      provenance: Provenance.USER_CONFIRMED,
      reviewStatus: ReviewStatus.APPROVED,
      reason: 'User-stated memory, auto-confirmed',
      conflictsWith: [],
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Branch 3: QUARANTINE (conflicts, low confidence, import) ---

  // Conflicts with existing → quarantine + flag for consensus
  if (conflicts.length > 0) {
    return {
      action: 'quarantined',
      trustClass: TrustClass.QUARANTINED,
      provenance: input.source === MemorySource.LLM ? Provenance.LLM_EXTRACTED_QUARANTINE : Provenance.IMPORTED,
      reviewStatus: ReviewStatus.PENDING,
      reason: `Conflicts with ${conflicts.length} existing memories`,
      conflictsWith: conflicts,
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
      needsConsensus: false,
      needsSpotCheck: false,
    };
  }

  // --- Branch 2: AUTO-STORE + spot-check lottery ---

  const needsSpotCheck = rollSpotCheck(config.spotCheckRate);

  return {
    action: 'stored',
    trustClass: TrustClass.AUTO_APPROVED,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    reviewStatus: ReviewStatus.APPROVED,
    reason: needsSpotCheck ? 'Auto-approved (flagged for spot-check)' : 'Auto-approved',
    conflictsWith: [],
    needsConsensus: false,
    needsSpotCheck,
  };
}
