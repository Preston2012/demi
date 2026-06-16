/**
 * Wedge 3: Materializer primitive.
 *
 * Sits between dispatch.ingest and the trust-branch/write pipeline behind
 * MATERIALIZER_ENABLED. On cache hit, returns the prior projection without
 * re-calling extract or the adjudicator. On miss, reads the raw text from
 * STONE for the requested window, runs the policy's extraction prompt,
 * runs the pre_adjudicate hook (default: W3 injection adapter), and
 * writes a durable row.
 *
 * Architectural invariant: STONE is the source of truth. materialize()
 * NEVER takes raw text as input -- it always reads from STONE for the
 * requested (conversationId, seqStart..seqEnd) window. Callers must
 * write to STONE first (dispatch.ingest already does this in phase [1]).
 *
 * Read this with WEDGE_3_DESIGN.md §§2-5 in hand. The schema lives in
 * src/repository/sqlite/migrations.ts; types and the hook contract live in
 * ./types; the cache-key derivation in ./cache-key. The write path
 * downstream (trust-branch, dedup, audit) is unchanged: dispatch.ingest
 * still feeds projection.assertions into the existing per-claim loop.
 *
 * S76 W4 Track A amendment: before invoking the adjudicator, materialize()
 * fetches up to K prior memories matching the leading claim's subject for
 * the requesting user. The result is passed into AdjudicatorInput as
 * `priorMemories`. The calibrated teacher consumes this to populate the
 * `contradicts_existing` reason code. The W3 default detectInjection
 * adapter ignores the field (no signature break). Fetch is subject to a
 * 50ms wall-clock budget; on timeout or DB error we silently degrade to
 * empty list (degraded contradicts_existing recall, never blocks ingest).
 */

import type Database from 'better-sqlite3-multiple-ciphers';

import { extractClaimsDetailed } from '../extract/index.js';
import type { ExtractedClaim } from '../extract/index.js';
import type { StoneStore } from '../stone/index.js';
import { recordCacheEvent, recordDecision, recordError, span } from '../telemetry/index.js';

import { detectSecretsInText, isVaultEnabled, vault } from '../security/vault/index.js';

import { detectInjectionAdjudicator } from './adjudicators/detect-injection.js';
import { computeCacheKey, truncateToMinute } from './cache-key.js';
import { DEFAULT_MULTISPEAKER_POLICY_ID, loadPolicy } from './policies.js';
import { fetchPriorMemoriesForSubject } from './prior-memories.js';
import { getMaterialization, insertMaterialization, touchMaterialization } from './store.js';
import type {
  AdjudicationResult,
  AdjudicatorFn,
  MaterializeOpts,
  MaterializedProjection,
  PriorMemory,
} from './types.js';

let _dbRef: Database.Database | null = null;
let _stoneRef: StoneStore | null = null;

/**
 * Bind the engine DB handle and a StoneStore reader. Called once during
 * SqliteMemoryRepository.initialize() after migrations and seeding. Module-
 * level singleton because threading these through every materialize() call
 * site would break the design-doc hook signature.
 */
export function bindMaterializer(db: Database.Database, stone: StoneStore): void {
  _dbRef = db;
  _stoneRef = stone;
}

export function resetMaterializer(): void {
  _dbRef = null;
  _stoneRef = null;
}

function db(): Database.Database {
  if (!_dbRef) {
    throw new Error('Materializer not bound. Call bindMaterializer() during repository.initialize().');
  }
  return _dbRef;
}

function stone(): StoneStore {
  if (!_stoneRef) {
    throw new Error('Materializer not bound. Call bindMaterializer() during repository.initialize().');
  }
  return _stoneRef;
}

const FALLBACK_POLICY_LABEL = 'fallback';

function keyExcerpt(cacheKey: string): string {
  return cacheKey.slice(0, 32);
}

function readWindowRawText(conversationId: string, seqStart: number, seqEnd: number): string {
  const msgs = stone().getMessageRange(conversationId, seqStart, seqEnd);
  return msgs.map((m) => m.content).join('\n\n');
}

/**
 * Wedge 3 entry point. See WEDGE_3_DESIGN.md §4 for the hook contract.
 *
 * Flow on miss: read STONE window -> extract -> fetch prior memories
 * (W4) -> adjudicate -> insert (even on reject, so a future identical
 * ingest doesn't re-pay extraction or re-prompt the adjudicator) ->
 * return.
 *
 * Flow on hit: load row -> touchMaterialization fire-and-forget -> return.
 *
 * Adjudicator throw -> recordError(materializer.adjudicator_throw), fall
 * through to accept with policy='fallback'. Availability over gating;
 * downstream addMemory validators still run. W4 should remove the
 * fallback once the calibrated adjudicator is stable.
 */
export async function materialize(opts: MaterializeOpts): Promise<MaterializedProjection> {
  const policyId = opts.policyId ?? 'default';
  const stoneWindowFull = {
    conversationId: opts.conversationId,
    seqStart: opts.stoneWindow.seqStart,
    seqEnd: opts.stoneWindow.seqEnd,
  };
  const cacheKey = computeCacheKey({
    conversationId: opts.conversationId,
    seqStart: opts.stoneWindow.seqStart,
    seqEnd: opts.stoneWindow.seqEnd,
    policyId,
    asOf: opts.asOf,
  });

  const policy = loadPolicy(db(), policyId);
  if (!policy) {
    throw new Error(`Materializer: unknown policy_id "${policyId}". Did you seed default policies?`);
  }

  // [1] Cache lookup. Stale rows (policy retired since insert) treated as miss.
  const cached = getMaterialization(db(), cacheKey);
  if (cached && cached.staleAt === null) {
    recordCacheEvent({ cache_name: 'materializer', event: 'hit', key_excerpt: keyExcerpt(cacheKey) });
    touchMaterialization(db(), cacheKey);
    return {
      assertions: cached.assertions,
      adjudication: cached.adjudicationState,
      policyId,
      policyVersion: policy.version,
      stoneWindow: stoneWindowFull,
      asOf: opts.asOf,
      fromCache: true,
      cacheKey,
    };
  }
  recordCacheEvent({
    cache_name: 'materializer',
    event: cached && cached.staleAt !== null ? 'stale' : 'miss',
    key_excerpt: keyExcerpt(cacheKey),
  });

  return span(
    'materializer.cold_read',
    async () => {
      const adjudicator: AdjudicatorFn = opts.pre_adjudicate ?? detectInjectionAdjudicator;
      const rawText = readWindowRawText(opts.conversationId, opts.stoneWindow.seqStart, opts.stoneWindow.seqEnd);

      const promptVersion =
        typeof policy.params === 'object' && policy.params && typeof policy.params.promptVersion === 'string'
          ? (policy.params.promptVersion as string)
          : undefined;

      // Derive multiSpeaker from the policy_id so the prompt body
      // selected by extractClaimsDetailed agrees with the prompt label
      // captured in policy.params.promptVersion. Without this, routing a
      // multispeaker conversation through policy_id='default-multispeaker'
      // would use the single-speaker EXTRACTION_PROMPT body, producing
      // claims that don't match the labeled prompt. W4 follow-up: make
      // policy.promptTemplate the canonical source and drop this branch.
      const multiSpeaker = policyId === DEFAULT_MULTISPEAKER_POLICY_ID;

      let claims: ExtractedClaim[];
      try {
        const r = await extractClaimsDetailed(rawText, {
          model: policy.modelId,
          assertedAt: opts.asOf,
          promptVersion,
          multiSpeaker,
        });
        claims = r.claims;
      } catch (err) {
        recordError({
          error_type: 'materializer.extract_fail',
          message: err instanceof Error ? err.message : String(err),
          tags: { policy_id: policyId, source: 'materializer' },
        });
        claims = [];
      }

      // W4.5 Position 1: extraction-time secret detection + encryption.
      // For each detected span we encrypt the plaintext via the vault and
      // splice the opaque [SECRET:ref] token into the claim text. The
      // adjudicator (next step) sees only the redacted form. Gated on the
      // master flag AND the position-specific flag AND a bound vault -
      // the conjunction is intentional: missing any one of these is a
      // configuration error that should not silently leak secrets.
      if (process.env.VAULT_EXTRACTION_DETECTION_ENABLED === 'true' && isVaultEnabled() && claims.length > 0) {
        for (let i = 0; i < claims.length; i++) {
          const original = claims[i];
          if (!original) continue;
          const detection = detectSecretsInText(original.claim);
          if (!detection.hasSecrets) continue;
          let mutated = original.claim;
          // Walk spans right-to-left so earlier offsets remain valid as we
          // splice in the (typically longer) ref tokens.
          for (let s = detection.spans.length - 1; s >= 0; s--) {
            const span = detection.spans[s];
            if (!span) continue;
            try {
              const ref = await vault().encrypt(span.value, {
                userId: opts.userId ?? 'unknown',
                stage: 'extraction',
              });
              mutated = mutated.slice(0, span.start) + `[SECRET:${ref}]` + mutated.slice(span.end);
              recordDecision({
                decision_type: 'vault_encrypt',
                branch_taken: 'encrypted',
                outcome: 'ok',
                inputs: { pattern: span.pattern, stage: 'extraction' },
              });
            } catch (err) {
              recordError({
                error_type: 'vault.encrypt_fail',
                message: err instanceof Error ? err.message : String(err),
                tags: { pattern: span.pattern, stage: 'extraction' },
              });
            }
          }
          claims[i] = { ...original, claim: mutated };
        }
      }

      // S76 W4 Track A: fetch prior memories scoped by leading claim's
      // subject before invoking the adjudicator. v1 uses only the first
      // claim's subject; multi-subject extractions get coverage of the
      // dominant subject only. v1.1 candidate: per-subject fetch with
      // dedup. Fetch is bounded by 50ms wall clock and silently degrades
      // to empty on timeout or DB error (degrades contradicts_existing
      // recall, never blocks ingest).
      let priorMemories: PriorMemory[] = [];
      const leadingSubject = claims[0]?.subject;
      if (leadingSubject) {
        priorMemories = await fetchPriorMemoriesForSubject(db(), opts.userId, leadingSubject);
      }

      let adjudication: AdjudicationResult;
      try {
        adjudication = await adjudicator({
          rawText,
          extractedClaims: claims,
          stoneWindow: stoneWindowFull,
          asOf: opts.asOf,
          userId: opts.userId,
          priorMemories,
        });
      } catch (err) {
        recordError({
          error_type: 'materializer.adjudicator_throw',
          message: err instanceof Error ? err.message : String(err),
          tags: { policy_id: policyId, source: 'materializer' },
        });
        adjudication = {
          decision: 'accept',
          policy: FALLBACK_POLICY_LABEL,
          score: null,
          reason_codes: ['adjudicator_throw'],
          rule_hits: [],
        };
      }

      const assertions = adjudication.decision === 'reject' ? [] : claims;

      recordDecision({
        decision_type: 'materializer.adjudication',
        branch_taken: adjudication.decision,
        outcome: adjudication.decision,
        inputs: {
          policy_id: policyId,
          policy_version: policy.version,
          reason_codes: adjudication.reason_codes,
          score: adjudication.score,
          claims_count: assertions.length,
          prior_memories_count: priorMemories.length,
        },
      });

      try {
        insertMaterialization(db(), {
          cacheKey,
          policyId,
          conversationId: opts.conversationId,
          stoneWindowStart: opts.stoneWindow.seqStart,
          stoneWindowEnd: opts.stoneWindow.seqEnd,
          asofAnchor: truncateToMinute(opts.asOf),
          assertions,
          adjudicationState: adjudication,
        });
      } catch (err) {
        recordError({
          error_type: 'materializer.cache_write_fail',
          message: err instanceof Error ? err.message : String(err),
          tags: { policy_id: policyId, source: 'materializer' },
        });
        // Continue: cache write is best-effort, the projection itself is sound.
      }

      return {
        assertions,
        adjudication,
        policyId,
        policyVersion: policy.version,
        stoneWindow: stoneWindowFull,
        asOf: opts.asOf,
        fromCache: false,
        cacheKey,
      };
    },
    { policy_id: policyId },
  );
}

export { warmCacheForRecentWindow } from './warm.js';
export {
  DEFAULT_POLICY_ID,
  DEFAULT_MULTISPEAKER_POLICY_ID,
  loadPolicy,
  retirePolicy,
  seedDefaultPolicies,
} from './policies.js';
export type {
  MaterializeOpts,
  MaterializedProjection,
  AdjudicationResult,
  AdjudicatorFn,
  AdjudicatorInput,
  AdjudicationDecision,
  MaterializationPolicy,
  PriorMemory,
} from './types.js';
