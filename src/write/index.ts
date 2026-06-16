import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../repository/interface.js';
import type { AddMemoryInput, AddMemoryResult, MemoryRecord } from '../schema/memory.js';
import {
  AddMemoryInputSchema,
  TrustClass,
  ReviewStatus,
  Scope,
  PermanenceStatus,
  MemoryType,
  StorageTier,
  ResolutionLevel,
  InterferenceStatus,
} from '../schema/memory.js';
import { AuditAction } from '../schema/audit.js';
import type { Config } from '../config.js';
import { createLogger } from '../config.js';
import { ValidationError } from '../errors.js';
import { validateMemoryInput, detectInjection } from './validators.js';
import { checkDuplicate, computeSourceHash } from './dedup.js';
import { classifyTrust, resolveConfidence, type TrustBranchConfig } from './trust-branch.js';
import { isSingleValuedSubject } from './subject-cardinality.js';
import { runConsensus, type EvaluatorConfig, type ConsensusInput } from './consensus.js';
import { benchModeSources, isTestMode } from './test-mode.js';
import { parseEvaluators } from '../config.js';
import { encode, isInitialized } from '../embeddings/index.js';
import { decomposeClaim, computeConflictAnchor } from '../plan/triples.js';

const log = createLogger('write');

/**
 * Write pipeline orchestrator.
 *
 * Flow:
 * 1. Validate input (Zod schema)
 * 2. Run deterministic validators (format, content, injection)
 * 3. Compute embedding (async, non-blocking for reads)
 * 4. Check dedup (exact hash + semantic similarity)
 * 5. Trust branching (deterministic classifier)
 * 6. Consensus escalation (if flagged by trust branch)
 * 7. Build memory record
 * 8. Store (if not rejected)
 * 9. Flag for spot-check (if selected by lottery)
 * 10. Audit log entry
 * 11. Return result
 *
 * Every path produces an audit log entry. No silent mutations.
 */

function buildEvaluatorConfigs(config: Config): EvaluatorConfig[] {
  // S67: pass all 6 provider keys so M13 lineups using mistral/xai/deepseek
  // aren't silently filtered out of CONSENSUS_EVALUATORS by parseEvaluators.
  // The downstream callProvider routes through engine callLLM which reads
  // process.env directly, but parseEvaluators still gates by these keys to
  // skip evaluator entries whose provider is unconfigured for this deployment.
  const apiKeys = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    google: config.googleApiKey,
    mistral: config.mistralApiKey,
    xai: config.xaiApiKey,
    deepseek: config.deepseekApiKey,
  };

  // Try multi-model evaluators first
  const multiModel = parseEvaluators(config.consensusEvaluators, apiKeys);
  if (multiModel.length >= 2) {
    return multiModel.map((e) => ({ provider: e.provider, model: e.model, apiKeys }));
  }

  // Fall back to legacy single-provider mode (3 calls to same provider)
  const count = 3;
  return Array.from({ length: count }, () => ({
    provider: config.consensusProvider,
    model: config.consensusModel,
    apiKeys,
  }));
}

function buildTrustConfig(config: Config): TrustBranchConfig {
  return {
    confidenceThreshold: config.confidenceThreshold,
    spotCheckRate: config.spotCheckRate,
    consensusThreshold: config.consensusThreshold,
  };
}

export async function addMemory(input: unknown, repo: IMemoryRepository, config: Config): Promise<AddMemoryResult> {
  const startMs = performance.now();

  // 1. Zod validation
  const parseResult = AddMemoryInputSchema.safeParse(input);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ValidationError(msg);
  }
  const parsed: AddMemoryInput = parseResult.data;
  const userId = parsed.user_id ?? 'system';
  const externalRef = parsed.external_ref ?? null;

  // Packet 0: external_ref idempotency. Caller-controlled dedup that
  // short-circuits the entire write pipeline (no embedding, no consensus).
  // Returns the existing record with action='duplicate'; the route maps
  // that to HTTP 200 instead of 201.
  if (externalRef) {
    const existing = await repo.findByExternalRef(userId, externalRef);
    if (existing) {
      return {
        id: existing.id,
        trustClass: existing.trustClass,
        action: 'duplicate',
        reason: 'external_ref idempotency hit',
      };
    }
  }

  // 2. Deterministic validators
  // A2 (S71): BENCH_MODE canonical, TEST_MODE deprecated alias. Either is accepted
  // and either is production-blocked. isBenchMode() returns true if either is set.
  // F1: BENCH_MODE replaces SKIP_WRITE_VALIDATION (legacy).
  if (
    (process.env.BENCH_MODE === 'true' || process.env.TEST_MODE === 'true') &&
    process.env.NODE_ENV === 'production'
  ) {
    const which = process.env.BENCH_MODE === 'true' ? 'BENCH_MODE' : 'TEST_MODE';
    throw new ValidationError(`${which} cannot be enabled in production. Aborting to prevent security bypass.`);
  }
  // S75 (brain #2594): BENCH_SKIP_DEDUP is REMOVED. Any process that sets it
  // is treated as a bug and aborts at boot, regardless of NODE_ENV. The
  // historical bench-only-bypass shape made bench scores lie for multiple
  // months (brain #2123 dedup truth table); the doctrine is now fail-loud.
  if (process.env.BENCH_SKIP_DEDUP === 'true') {
    throw new ValidationError(
      'BENCH_SKIP_DEDUP is REMOVED in S75. Dedup is unconditional on every bench. ' +
        'If a bench fixture collides at cosine 0.95, rebuild it with rejection sampling. ' +
        'See src/benchmark/cross-session-temporal/bake.ts for the canonical pattern.',
    );
  }
  const skipValidation = isTestMode() && process.env.NODE_ENV !== 'production';
  if (skipValidation) {
    const sources = benchModeSources().join('+') || 'unknown';
    log.warn({ sources }, `CRITICAL: Write validation bypassed via bench mode (${sources})`);
  }
  // S53: refusal-first. Injection detection ALWAYS runs even under TEST_MODE.
  // Adversarial claims (prompt-injection patterns, role-hijack markers,
  // tool-call tags, etc.) must never enter the retrieval pool regardless of
  // bench bypass flags. The other validators (format, content, gibberish,
  // unicode tricks) still skip under TEST_MODE for bench determinism.
  const injectionCheck = detectInjection(parsed.claim);
  const validation = !injectionCheck.valid
    ? injectionCheck
    : skipValidation
      ? { valid: true, reason: '' }
      : validateMemoryInput(parsed.claim, parsed.subject);

  // 3. Compute embedding (if model available).
  // C1 subject-prefix embedding killed S33 (-13 to -23pp LOCOMO, brain #1815).
  const textToEmbed = parsed.claim;

  let embedding: number[] | null = null;
  if (isInitialized()) {
    try {
      embedding = await encode(textToEmbed);
    } catch (err) {
      log.warn({ err }, 'Embedding failed, continuing without');
    }
  }

  // 4. Dedup check (per-user)
  const dedup = await checkDuplicate(repo, parsed.claim, embedding, undefined, userId);

  // 5. Trust branching (per-user)
  const branch = await classifyTrust(parsed, repo, buildTrustConfig(config), validation, dedup, userId);

  // 6. Consensus escalation (if needed)
  // TEST_MODE skips consensus: each consensus call hits 3 LLM evaluators in
  // parallel (~1.5-2.5s each). On LOCOMO 296Q seeding, conflicts fire ~600
  // times → ~20min wall-clock just on consensus. Bench correctness does not
  // depend on consensus, trust-branch already populated conflictsWith for
  // telemetry. Production keeps the consensus path; benches skip it.
  // S59A: prior runs unintentionally fired consensus during seed because
  // the trust-branch conflicts path sets needsConsensus=true regardless of
  // TEST_MODE. This guard restores prior bench wall-time (~14min unrouted).
  // R29-WD-4: rows that consensus invalidated (the losing conflicts) so the
  // post-insert step can audit CONSENSUS_INVALIDATED with the rationale.
  let consensusInvalidated: string[] = [];
  let consensusRationale = '';
  const skipConsensusForBench = isTestMode();
  if (branch.needsConsensus && !skipConsensusForBench) {
    const evaluators = buildEvaluatorConfigs(config);

    // Fetch conflicting claims for context
    const conflictClaims: string[] = [];
    if (branch.conflictsWith.length > 0) {
      const conflictRecords = await repo.getByIds(branch.conflictsWith, userId);
      for (const r of conflictRecords) {
        conflictClaims.push(r.claim);
      }
    }

    const consensusInput: ConsensusInput = {
      claim: parsed.claim,
      subject: parsed.subject || 'unknown',
      confidence: parsed.confidence ?? 0.5,
      source: parsed.source ?? 'llm',
      existingConflicts: conflictClaims,
    };

    try {
      const result = await runConsensus(consensusInput, evaluators, config.consensusMinAgreement);

      // Override trust branch with consensus decision
      if (result.decision === 'store') {
        branch.action = 'stored';
        branch.trustClass = TrustClass.AUTO_APPROVED;
        branch.reviewStatus = ReviewStatus.APPROVED;
        branch.reason = `Consensus: store (${result.unanimous ? 'unanimous' : 'majority'})`;
        // R29-WD-4: consensus chose the new claim over its conflicts. Invalidate
        // the losing rows, but ONLY within safe bounds: the subject must
        // canonicalize single-valued, and the conflicts are already constrained
        // by findConflicts to the same subject + a related attribute. Outside
        // those bounds we leave the conflicts intact (refusal-first: never
        // destroy a fact on an additive/multi-valued subject). The losers are
        // folded into supersedes so insertWithAudit invalidates them atomically.
        if (branch.conflictsWith.length > 0 && isSingleValuedSubject(parsed.subject || 'unknown')) {
          consensusInvalidated = [...branch.conflictsWith];
          consensusRationale = `Consensus stored the new claim (${
            result.unanimous ? 'unanimous' : 'majority'
          }); single-valued subject "${parsed.subject || 'unknown'}", losing conflicts invalidated`;
          branch.supersedes = Array.from(new Set([...branch.supersedes, ...consensusInvalidated]));
        }
      } else if (result.decision === 'reject') {
        branch.action = 'rejected';
        branch.trustClass = TrustClass.REJECTED;
        branch.reviewStatus = ReviewStatus.REJECTED;
        branch.reason = `Consensus: reject (${result.unanimous ? 'unanimous' : 'majority'})`;
      }
      // else: stays quarantined (consensus couldn't agree)

      await repo.appendAuditLog(
        {
          memoryId: null,
          action: AuditAction.CONSENSUS_COMPLETED,
          details: JSON.stringify({
            decision: result.decision,
            unanimous: result.unanimous,
            latencyMs: result.totalLatencyMs,
          }),
        },
        userId,
      );
    } catch (err) {
      log.error({ err }, 'Consensus failed, keeping quarantine');
      // On consensus failure, stay quarantined (safe default)
    }
  }

  // 7. Build memory record
  const now = new Date().toISOString();
  // Use validFrom as creation timestamp when provided (benchmark/import temporal ordering)
  const effectiveTimestamp = parsed.validFrom ?? now;
  const id = uuid();
  const sourceHash = computeSourceHash(parsed.claim);

  const record: MemoryRecord = {
    id,
    userId,
    externalRef,
    claim: parsed.claim,
    subject: parsed.subject || 'unknown',
    scope: parsed.scope ?? Scope.GLOBAL,
    validFrom: parsed.validFrom ?? null,
    validTo: parsed.validTo ?? null,
    provenance: branch.provenance,
    trustClass: branch.trustClass,
    // S2: Use same resolved confidence as trust branching
    confidence: resolveConfidence(parsed),
    sourceHash,
    supersedes: null,
    conflictsWith: branch.conflictsWith,
    reviewStatus: branch.reviewStatus,
    accessCount: 0,
    lastAccessed: effectiveTimestamp,
    createdAt: effectiveTimestamp,
    updatedAt: effectiveTimestamp,
    embedding,
    permanenceStatus: PermanenceStatus.PROVISIONAL,
    // Packet 1: Hub-and-spoke, versioning, decay
    hubId: null,
    hubScore: 0,
    resolution: ResolutionLevel.SPECIFIC,
    // S3: Respect input memoryType instead of hardcoding DECLARATIVE
    memoryType: parsed.memoryType ?? MemoryType.DECLARATIVE,
    versionNumber: 1,
    parentVersionId: null,
    frozenAt: null,
    decayScore: 1,
    storageTier: StorageTier.ACTIVE,
    // Packet 2a: Inhibitory, interference, causal
    isInhibitory: parsed.isInhibitory ?? false,
    inhibitionTarget: parsed.inhibitionTarget ?? null,
    interferenceStatus: InterferenceStatus.ACTIVE,
    correctionCount: 0,
    isFrozen: false,
    causedBy: parsed.causedBy ?? null,
    leadsTo: parsed.leadsTo ?? null,
    // S6: Validate canonicalFactId format if provided (prevent arbitrary family collapsing)
    canonicalFactId:
      parsed.canonicalFactId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.canonicalFactId)
        ? parsed.canonicalFactId
        : null,
    isCanonical: parsed.isCanonical ?? true,
    // Packet A: bi-temporal, validAt defaults to validFrom or createdAt
    validAt: parsed.validFrom ?? effectiveTimestamp,
    invalidAt: null,
    // Packet C3 / Bug 3: persona flag. Explicit input only, auto-detect
    // was config-mirror-deleted S67 (brain #2173).
    persona: parsed.persona ?? false,
    // S59 / TEMPR: session and episode IDs from input (only writers with
    // session context provide these; otherwise NULL and the pre-rerank
    // filter degrades gracefully).
    sessionId: parsed.sessionId ?? null,
    episodeId: parsed.episodeId ?? null,
    // D1 + A7 (S72): temporal parse IR audit columns. Set only when the
    // write-time temporal resolver mutated the claim (see dispatch.ingest).
    rawClaim: parsed.rawClaim ?? null,
    normalization: parsed.normalization ?? null,
  };

  // 8. Store (if not rejected)
  //
  // S5: insert + bi-temporal supersession + audit-log append now run in a
  // single synchronous SQLite transaction via `repo.insertWithAudit`. Before
  // this, the three were separate async calls, a crash between them left
  // the DB in an inconsistent state (memory written without audit entry,
  // or superseded facts not invalidated).
  //
  // STONE / facets / spot-check stay outside the atomic block because they
  // are best-effort and each already has its own try/catch with log.warn.
  // Wedging them into the same transaction would force engine-wide rollback
  // for issues the engine is otherwise designed to tolerate.
  const auditAction =
    branch.action === 'confirmed'
      ? AuditAction.CONFIRMED
      : branch.action === 'stored'
        ? AuditAction.CREATED
        : branch.action === 'quarantined'
          ? AuditAction.QUARANTINED
          : AuditAction.REJECTED;

  if (branch.action !== 'rejected') {
    const supersedeIds = config.biTemporalEnabled && branch.supersedes.length > 0 ? branch.supersedes : undefined;
    const supersedeAt = supersedeIds ? (record.validFrom ?? record.createdAt) : undefined;

    try {
      await repo.insertWithAudit(
        record,
        { memoryId: id, action: auditAction, details: branch.reason },
        userId,
        supersedeIds ? { supersedeIds, supersedeAt } : undefined,
      );
    } catch (err) {
      // Race-protection for external_ref idempotency: the partial unique
      // index on (user_id, external_ref) is the safety net. If two
      // concurrent inserts with the same external_ref hit, the second
      // throws SQLITE_CONSTRAINT_UNIQUE, recover by returning the
      // existing row.
      const isUniqueErr = err instanceof Error && /UNIQUE|external_ref/i.test(err.message);
      if (externalRef && isUniqueErr) {
        const existing = await repo.findByExternalRef(userId, externalRef);
        if (existing) {
          return {
            id: existing.id,
            trustClass: existing.trustClass,
            action: 'duplicate',
            reason: 'external_ref idempotency hit (race)',
          };
        }
      }
      throw err;
    }

    // R29-WD-4: record the consensus-driven invalidation of the losing rows
    // (the supersession itself already ran atomically inside insertWithAudit
    // via supersedeIds; this entry carries the losing ids + rationale).
    if (consensusInvalidated.length > 0) {
      await repo.appendAuditLog(
        {
          memoryId: id,
          action: AuditAction.CONSENSUS_INVALIDATED,
          details: JSON.stringify({
            losingIds: consensusInvalidated,
            subject: parsed.subject || 'unknown',
            rationale: consensusRationale,
          }),
        },
        userId,
      );
    }

    // R29-WD-3: if this write re-asserts a value that was previously superseded,
    // link the historical (already-invalid) row(s) and audit the recurrence. The
    // new row already supersedes the current opposing row via the normal
    // supersedes path; this makes the re-assertion observable instead of silent.
    try {
      const revived = await repo.findSupersededBySourceHash(sourceHash, userId);
      if (revived.length > 0) {
        await repo.appendAuditLog(
          {
            memoryId: id,
            action: AuditAction.REASSERTED_PRIOR_VALUE,
            details: JSON.stringify({
              reassertedId: id,
              historicalIds: revived,
              supersededCurrentIds: supersedeIds ?? [],
            }),
          },
          userId,
        );
      }
    } catch (reviveErr) {
      log.warn({ id, err: reviveErr }, 'Re-assertion audit failed (non-critical)');
    }

    // Wedge 2 (S74): write-time triple decomposition.
    // After the memory row commits, the hybrid decomposer in
    // src/plan/triples.ts emits one or more rows into assertion_triples.
    // On pattern match: (subject, predicate, object) with possible
    // valid_from override. On miss: a single fallback row with
    // object_literal = claim. Every assertion produces at least one row,
    // so plan-executor subject lookups always succeed.
    //
    // Non-fatal on failure: if insertTriples throws, log and continue -
    // the memory row is already committed and the backfill script
    // (scripts/migrate-assertion-triples.ts) can re-emit later. The
    // legacy retrieve path doesn't consume triples, so failure here is
    // graceful degradation, not a write-side regression.
    try {
      const anchor = computeConflictAnchor(record.id, branch.conflictsWith ?? []);
      const triples = decomposeClaim(record.claim, record.subject, {
        assertion_id: record.id,
        valid_from: record.validFrom,
        valid_to: record.validTo,
        confidence: record.confidence,
        conflict_set_id: anchor,
      });
      await repo.insertTriples(record.id, triples);
    } catch (tripleErr) {
      log.warn({ err: tripleErr, id: record.id }, 'Triple decomposition failed (non-critical; backfill will recover)');
    }

    // Packet A / S49: bi-temporal supersession (Graphiti pattern) is handled
    // atomically inside repo.insertWithAudit above via { supersedeIds,
    // supersedeAt } (sqlite/index.ts:374), in the SAME transaction as the
    // memory + audit row. R29-N2: the former post-hoc UPDATE here was a second,
    // non-atomic channel writing invalid_at outside that transaction; it has
    // been removed so supersession has exactly one source of truth.

    // 8a. STONE: log raw claim to immutable store (tier 1)
    // A4 (S71): STONE writes are unconditional. Audit log integrity is structural;
    // gating it on env created reproducibility gaps when benches ran without it.
    // STONE_INGEST env flag is DEPRECATED and ignored. STONE_ENABLED retained
    // for retrieval-side expansion features (compression router, episode boost).
    // Cost is one cached singleton lookup + 2 SQL inserts per claim. Acceptable.
    {
      try {
        const stone = repo.getStoneStore ? repo.getStoneStore() : null;
        if (stone) {
          const convId = parsed.source || 'default';
          try {
            stone.createConversation({ id: convId, source: parsed.source || 'api', startedAt: now });
          } catch {
            /* already exists */
          }
          stone.appendMessage({
            id: uuid(),
            conversationId: convId,
            role: 'user',
            content: parsed.claim,
            sequenceNumber: Date.now(),
            timestamp: now,
          });
        }
      } catch (stoneErr) {
        log.warn({ id, err: stoneErr }, 'STONE logging failed (non-critical)');
      }
    }

    // 8b. Populate facets (R11: annotation layer for episodes/state packs)
    try {
      await repo.populateFacets(record);
    } catch (facetErr) {
      log.warn({ id, err: facetErr }, 'Facet population failed (non-critical)');
    }

    // 8c. State packs KILLED in R11 (-2.4 LOCOMO, -2.3 BEAM). Removed.

    // 8d. Bridge facts KILLED in R11 (-0.3). Removed.

    // 9. Spot-check flag
    if (branch.needsSpotCheck) {
      await repo.flagForSpotCheck(id);
    }
  } else {
    // Rejected branch: no memory row, but we still record an audit entry
    // so REJECT decisions show up in the chain.
    await repo.appendAuditLog(
      {
        memoryId: null,
        action: auditAction,
        details: branch.reason,
      },
      userId,
    );
  }

  const totalMs = Math.round(performance.now() - startMs);
  log.info({ id, action: branch.action, trustClass: branch.trustClass, totalMs }, 'Write pipeline complete');

  // 11. Return result
  return {
    id,
    trustClass: branch.trustClass,
    action: branch.action,
    reason: branch.reason,
    conflictsWith: branch.conflictsWith.length > 0 ? branch.conflictsWith : undefined,
    // S49: temporally-ordered supersedes, exposed so callers can observe
    // which prior facts this write replaced (write side already marked
    // them invalid_at when biTemporalEnabled).
    supersedes: branch.supersedes.length > 0 ? branch.supersedes : undefined,
  };
}
