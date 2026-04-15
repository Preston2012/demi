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
import { validateMemoryInput } from './validators.js';
import { checkDuplicate, computeSourceHash } from './dedup.js';
import { classifyTrust, resolveConfidence, type TrustBranchConfig } from './trust-branch.js';
import { runConsensus, type EvaluatorConfig, type ConsensusInput } from './consensus.js';
import { parseEvaluators } from '../config.js';
import { encode, isInitialized } from '../embeddings/index.js';

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
  const apiKeys = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    google: config.googleApiKey,
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

  // 2. Deterministic validators
  // F1: TEST_MODE replaces SKIP_WRITE_VALIDATION. Blocked in production.
  if (process.env.TEST_MODE === 'true' && process.env.NODE_ENV === 'production') {
    throw new ValidationError('TEST_MODE cannot be enabled in production. Aborting to prevent security bypass.');
  }
  const skipValidation = process.env.TEST_MODE === 'true' && process.env.NODE_ENV !== 'production';
  if (skipValidation) {
    log.warn({}, 'CRITICAL: Write validation bypassed via TEST_MODE');
  }
  const validation = skipValidation ? { valid: true, reason: '' } : validateMemoryInput(parsed.claim, parsed.subject);

  // 3. Compute embedding (if model available)
  // C1: Contextualize claim before embedding for richer vector representation
  const textToEmbed =
    process.env.CONTEXTUALIZE_EMBEDDING === 'true' && parsed.subject
      ? parsed.claim.toLowerCase().includes(parsed.subject.toLowerCase())
        ? parsed.claim
        : `${parsed.subject}. ${parsed.claim}`
      : parsed.claim;

  let embedding: number[] | null = null;
  if (isInitialized()) {
    try {
      embedding = await encode(textToEmbed);
    } catch (err) {
      log.warn({ err }, 'Embedding failed, continuing without');
    }
  }

  // 4. Dedup check
  const dedup = await checkDuplicate(repo, parsed.claim, embedding);

  // 5. Trust branching
  const branch = await classifyTrust(parsed, repo, buildTrustConfig(config), validation, dedup);

  // 6. Consensus escalation (if needed)
  if (branch.needsConsensus) {
    const evaluators = buildEvaluatorConfigs(config);

    // Fetch conflicting claims for context
    const conflictClaims: string[] = [];
    if (branch.conflictsWith.length > 0) {
      const conflictRecords = await repo.getByIds(branch.conflictsWith);
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
      } else if (result.decision === 'reject') {
        branch.action = 'rejected';
        branch.trustClass = TrustClass.REJECTED;
        branch.reviewStatus = ReviewStatus.REJECTED;
        branch.reason = `Consensus: reject (${result.unanimous ? 'unanimous' : 'majority'})`;
      }
      // else: stays quarantined (consensus couldn't agree)

      await repo.appendAuditLog({
        memoryId: null,
        action: AuditAction.CONSENSUS_COMPLETED,
        details: JSON.stringify({
          decision: result.decision,
          unanimous: result.unanimous,
          latencyMs: result.totalLatencyMs,
        }),
      });
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
  };

  // 8. Store (if not rejected)
  if (branch.action !== 'rejected') {
    await repo.insert(record);

    // 8a. STONE: log raw claim to immutable store (tier 1)
    // S27: Gated behind STONE_INGEST (separate from STONE_ENABLED).
    // STONE_ENABLED controls read-path (queries, MCP tools).
    // STONE_INGEST controls write-path (logging claims on ingest).
    // Benchmarks: STONE_INGEST off (avoids 2x latency from ad-hoc StoneStore creation per write).
    // Product: STONE_INGEST=true in .env.
    if (process.env.STONE_INGEST === 'true') {
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
  }

  // 10. Audit log
  const auditAction =
    branch.action === 'confirmed'
      ? AuditAction.CONFIRMED
      : branch.action === 'stored'
        ? AuditAction.CREATED
        : branch.action === 'quarantined'
          ? AuditAction.QUARANTINED
          : AuditAction.REJECTED;

  await repo.appendAuditLog({
    memoryId: branch.action !== 'rejected' ? id : null,
    action: auditAction,
    details: branch.reason,
  });

  const totalMs = Math.round(performance.now() - startMs);
  log.info({ id, action: branch.action, trustClass: branch.trustClass, totalMs }, 'Write pipeline complete');

  // 11. Return result
  return {
    id,
    trustClass: branch.trustClass,
    action: branch.action,
    reason: branch.reason,
    conflictsWith: branch.conflictsWith.length > 0 ? branch.conflictsWith : undefined,
  };
}
