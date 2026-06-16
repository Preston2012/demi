/**
 * Cross-encoder reranker for second-stage relevance scoring.
 *
 * S59 / TEMPR rewrite: replaces the S29 bge-reranker-base + GATE_SIZE
 * mechanism with a faster cross-encoder + timeout-based blocking + date-prefix
 * injection + recency boost + confidence floor + near-dup collapse.
 *
 * KILL HISTORY (council-mandated documentation):
 *   V1: ms-marco-MiniLM-L6-v2 (web-search domain). KILLED at -25 pts under
 *       the OLD scaffolding (no date-prefix, no recency layer, gate-size
 *       overfit). Re-evaluated in V4 with the new pipeline.
 *   V2: bge-reranker-base ONNX (passage/QA). Replaced in S59, bge had no
 *       date awareness, no recency layer, and the gate-size mechanism
 *       overfit to specific bench shapes.
 *   V3 (superseded S59A): mxbai-rerank-xsmall ONNX (mixedbread.ai).
 *       Council pick from S58 reconciliation; killed by ARM latency on CAX11
 *       (p95=502ms vs 250ms gate). Stays available via RERANK_MODEL_PATH +
 *       RERANK_TOKENIZER_DIR for future evaluation on faster hardware.
 *   V4 (current): ms-marco-MiniLM-L6-v2 ONNX (HuggingFace cross-encoder).
 *       23MB, 6-layer MiniLM trained on MS MARCO passage ranking. Chosen
 *       over mxbai-rerank-xsmall after S59A validate gate showed mxbai
 *       p95=502ms vs MiniLM p95=74ms on CAX11 (4GB ARM, 2 cores). Quality
 *       difference between the two on Demiurge's stored-memory retrieval
 *       (short claims, post-RRF top-K) is empirical and validated via
 *       bench minis after merge.
 *
 * Pipeline (RERANKER_ENABLED=true):
 *   1. Date-prefix injection: candidate text becomes
 *      "[Date: <iso_or_unknown>] context: <claim>" before tokenization.
 *   2. Score all candidates via cross-encoder. Timeout via Promise.race
 *      (RERANK_TIMEOUT_MS, default 200). On timeout: log degraded counter,
 *      still apply recency boost on RRF scores (no model call needed),
 *      return top-N. Don't lose partial signal.
 *   3. Sigmoid scores → [0,1].
 *   4. Multiplicative recency boost: final = sig * (1 + α * recencyFactor).
 *      α from QueryType (temporal 0.4, default 0.2, persona 0.05, timeless 0).
 *      Floor lifted from 0 to 0.2 when query has explicit date bounds
 *      (extractDateBounds non-null), never pushes above the query-type ceiling.
 *   5. Sort desc.
 *   6. Confidence floor: if best score < RERANK_CONFIDENCE_FLOOR (default
 *      0.25), return empty array, downstream answer model emits refusal
 *      via existing buildInjectionPayload empty-injection path.
 *   7. Slice to topN.
 *   8. Near-dup collapse: pairwise Jaccard on claim tokens (cosine-equivalent
 *      proxy at threshold 0.85 ≈ embedding cosine 0.92 for short claims;
 *      see RERANK_DEDUP_THRESHOLD env override). Drop lower-ranked dup,
 *      refill from overflow.
 *
 * Query-type gating (RERANK_QUERY_TYPE_GATING=true, default OFF):
 *   Skips the cross-encoder for query types where rerank doesn't help
 *   (single-hop / current-state / open-domain). Tracked separately from
 *   degraded, gating is by design, degradation is fallback-from-timeout.
 *
 * Feature flag: RERANKER_ENABLED !== 'true' (default OFF, F-1).
 * Lazy init: model loaded on first rerank() call when flag ON.
 *
 * Exported counter: getRerankDegradedCount() / getRerankGatedCount() /
 * resetRerankCounters() for bench harness assertions.
 */
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// A11: see src/embeddings/index.ts, same package swap, same reasons.
import { AutoTokenizer, env } from '@huggingface/transformers';
import { createLogger } from '../config.js';
import type { FinalScoredCandidate } from './scorer.js';
import type { QueryType } from './query-classifier.js';
import { extractDateBounds } from './query-temporal.js';
import { engineNow } from './engine-now.js';
import { recordRefusal } from '../telemetry/index.js';

const log = createLogger('reranker');

let session: InferenceSession | null = null;
let tokenizer: any = null;
let loaded = false;
let loadPromise: Promise<boolean> | null = null;

const MAX_SEQ_LENGTH = 512;
// S74 Bug 1 fix: timeout 250 → 800ms.
// 65 candidates × ~7ms ≈ 455ms; needs headroom for production traffic
// (consensus contention, embedding cache misses, write traffic). The
// 250ms ceiling forced the reranker into degraded-fallback at the
// 65-candidate pool the rest of retrieval feeds in.
// Tests lock the constant in tests/unit/reranker.test.ts.
export const DEFAULT_RERANK_TIMEOUT_MS = 800;
const DEFAULT_CONFIDENCE_FLOOR = 0.25;
const DEFAULT_DEDUP_THRESHOLD = 0.85; // Jaccard proxy for cosine 0.92.
const DEFAULT_RECENCY_HALFLIFE_DAYS = 180;
// S74 Bug 1 fix: cap 20 → 65.
// Each candidate costs ~7ms on CAX11 (4GB ARM, MiniLM-L6-v2). With the
// cap at 20, only the top-20 RRF candidates reached the cross-encoder
// and the other 45 passed through unscored, LOCOMO answers at RRF
// ranks 21+ were physically unreachable for promotion. The new cap
// matches the candidate-pool size (65 = `Math.max(maxResults *
// candidateOverfetchMultiplier, 30)` in src/retrieval/index.ts) so
// every candidate gets a chance to score.
//
// Latency: 65 × 7ms ≈ 455ms. Pairs with the 800ms timeout above
// (75% headroom). Operator can tune both via RERANK_MAX_CANDIDATES /
// RERANK_TIMEOUT_MS env vars if a real workload pegs CPU.
export const DEFAULT_RERANK_MAX_CANDIDATES = 65;

/**
 * Query types that bypass the cross-encoder entirely when
 * RERANK_QUERY_TYPE_GATING=true.
 *
 * Single-hop / current-state / open-domain queries are typically resolved
 * correctly by RRF top-K + recency boost. Cross-encoder rerank on these
 * adds latency without lifting accuracy, and can hurt by overweighting
 * semantic similarity over what RRF already got right.
 *
 * Rerank IS run for: multi-hop (need precise ordering across many
 * candidates), temporal / temporal-multi-hop (cross-encoder benefits from
 * date-prefix on candidate text), narrative / synthesis / summarization /
 * coverage (many candidates, need tight top-K).
 *
 * Gated behind RERANK_QUERY_TYPE_GATING flag (default OFF). Validate
 * on minis before flipping default ON.
 */
const RERANK_SKIP_TYPES: ReadonlySet<QueryType> = new Set<QueryType>(['single-hop', 'current-state', 'open-domain']);

// Per-query-type α coefficient for the multiplicative recency boost.
// Council-locked. extractDateBounds lifts the floor from 0 to 0.2 when
// query has explicit dates but query-classifier flagged "timeless".
const RECENCY_ALPHA: Record<QueryType, number> = {
  temporal: 0.4,
  'temporal-multi-hop': 0.4,
  'current-state': 0.2,
  'multi-hop': 0.2,
  'single-hop': 0.2,
  narrative: 0.2,
  synthesis: 0.2,
  summarization: 0.2,
  coverage: 0.2,
  'open-domain': 0.05, // persona-like, stable preferences
};

let degradedCount = 0;
let gatedCount = 0;
let totalCount = 0;
let lastCallInfo: { degraded: 0 | 1; gated: 0 | 1; confidenceFloorHit: 0 | 1; elapsedMs: number } = {
  degraded: 0,
  gated: 0,
  confidenceFloorHit: 0,
  elapsedMs: 0,
};

export function getRerankDegradedCount(): number {
  return degradedCount;
}
export function getRerankGatedCount(): number {
  return gatedCount;
}
export function getRerankTotalCount(): number {
  return totalCount;
}
export function resetRerankCounters(): void {
  degradedCount = 0;
  gatedCount = 0;
  totalCount = 0;
}
/** Snapshot of the most recent rerank() call. Single-threaded bench-mode use. */
export function getLastRerankInfo(): {
  degraded: 0 | 1;
  gated: 0 | 1;
  confidenceFloorHit: 0 | 1;
  elapsedMs: number;
} {
  return { ...lastCallInfo };
}

/**
 * Load reranker ONNX model + tokenizer. Lazy-loaded on first use, idempotent.
 *
 * Defaults: ms-marco-MiniLM-L6-v2 weights at `models/ms-marco-MiniLM-L6-v2.onnx`
 * + tokenizer at `models/ms-marco/`. Both overridable via RERANK_MODEL_PATH
 * and RERANK_TOKENIZER_DIR env vars.
 *
 * The reranker tokenizer loads from a dedicated subdirectory under `models/`
 * to avoid colliding with the BGE embedder, which loads from
 * `models/tokenizer.json`. Default `models/ms-marco` is overridable via
 * `RERANK_TOKENIZER_DIR`.
 */
async function ensureLoaded(): Promise<boolean> {
  if (loaded) return true;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const modelPath = resolve(process.cwd(), process.env.RERANK_MODEL_PATH || 'models/ms-marco-MiniLM-L6-v2.onnx');

      if (!existsSync(modelPath)) {
        log.warn('Reranker model not found at %s', modelPath);
        return false;
      }

      const startMs = performance.now();

      session = await InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 2,
      });

      const tokenizerDir = process.env.RERANK_TOKENIZER_DIR || 'models/ms-marco';
      const modelDir = dirname(modelPath);
      env.localModelPath = resolve(modelDir, '..');
      env.allowRemoteModels = false;
      tokenizer = await AutoTokenizer.from_pretrained(tokenizerDir, { local_files_only: true });

      loaded = true;
      const elapsed = (performance.now() - startMs).toFixed(0);
      log.info('Reranker model loaded in %sms (path: %s)', elapsed, modelPath);
      return true;
    } catch (err) {
      log.error('Failed to load reranker: %s', err instanceof Error ? err.message : String(err));
      session = null;
      return false;
    }
  })();

  return loadPromise;
}

/** Build the date-prefixed candidate text used as the cross-encoder pair. */
function buildPairText(record: { claim: string; validFrom: string | null; createdAt: string }): string {
  const iso = record.validFrom || record.createdAt || null;
  const datePart = iso ? `[Date: ${iso.slice(0, 10)}]` : '[Date: unknown]';
  return `${datePart} context: ${record.claim}`;
}

/**
 * Score a single query/pair via cross-encoder.
 * Cross-encoder: [CLS] query [SEP] pair_text [SEP] → relevance logit.
 */
async function scoreOne(query: string, pairText: string): Promise<number> {
  if (!session || !tokenizer) return 0;

  const encoded = tokenizer(query, {
    text_pair: pairText,
    padding: false,
    truncation: true,
    max_length: MAX_SEQ_LENGTH,
  });

  const ids = encoded.input_ids.data;
  const mask = encoded.attention_mask.data;
  const seqLength = ids.length;

  const inputIds: bigint[] = new Array(seqLength);
  const attentionMask: bigint[] = new Array(seqLength);
  for (let i = 0; i < seqLength; i++) {
    inputIds[i] = BigInt(ids[i]);
    attentionMask[i] = BigInt(mask[i]);
  }

  const feeds: Record<string, Tensor> = {
    input_ids: new Tensor('int64', inputIds, [1, seqLength]),
    attention_mask: new Tensor('int64', attentionMask, [1, seqLength]),
  };

  if (session.inputNames.includes('token_type_ids')) {
    const tokenTypeIds: bigint[] = encoded.token_type_ids
      ? Array.from(encoded.token_type_ids.data, (v: number) => BigInt(v))
      : new Array(seqLength).fill(0n);
    feeds.token_type_ids = new Tensor('int64', tokenTypeIds, [1, seqLength]);
  }

  const results = await session.run(feeds);
  const logits = results.logits || results.output;
  if (!logits) return 0;
  return (logits.data as Float32Array)[0] ?? 0;
}

function sigmoid(x: number): number {
  // Stable sigmoid for both signs.
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

function recencyFactor(
  record: { validFrom: string | null; createdAt: string },
  nowMs: number,
  halflifeDays: number,
): number {
  const dateStr = record.validFrom || record.createdAt;
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (nowMs - t) / (1000 * 60 * 60 * 24));
  const f = Math.exp(-days / halflifeDays);
  return Math.min(1, Math.max(0, f));
}

/**
 * Resolve α from query type, with env overrides + explicit-date floor lift.
 *
 * Exported for unit testing of the env-override paths only, internal API.
 *
 * Env overrides (S59A):
 * - RERANK_RECENCY_DISABLED=true zeroes ALL α (no recency boost anywhere).
 * - RERANK_RECENCY_ALPHA_TEMPORAL=<float> overrides α for 'temporal' and
 *   'temporal-multi-hop' only. Set to 0 to disable recency on temporal
 *   queries while leaving other types alone, useful when temporal
 *   questions ask about specific past dates rather than recent events
 *   (LOCOMO is heavy with this pattern; -54pp on cat 2 with α=0.4).
 *
 * S60 fix (Item C): floor lift via hasExplicitDate REMOVED. Was
 * Math.max(baseAlpha, 0.2) which defeated RERANK_RECENCY_ALPHA_TEMPORAL=0
 * by lifting alpha to 0.2 on every query that mentioned a date, the
 * exact Qs we want to NOT boost recency on. Brain #2042: Plan A regressed
 * temporal -61.7pp on LOCOMO mini due to this. The hasExplicitDate signal
 * is preserved as a parameter (call site passes bounds !== null) because
 * the future date-window pre-filter (S60 Item A) will consume it as a
 * trigger to hard-filter retrieval candidates by validity interval -
 * which is the right shape for "what happened on date X" queries, NOT
 * a recency multiplier.
 */
export function resolveAlpha(queryType: QueryType, _hasExplicitDate: boolean): number {
  // S74 Bug 3 fix: temporal types default to 0 (no recency boost).
  // RECENCY_ALPHA.temporal = 0.4 over-fires on past-date LOCOMO
  // questions, those want OLDER memories ("how long ago", "what did
  // X do on YYYY-MM-DD"), and a multiplicative recency boost ranks
  // newer-but-irrelevant facts above the correct older ones. Brain
  // #2042 / S60 Plan A documented -61.7pp temporal regression from
  // this exact behavior. The RERANK_RECENCY_ALPHA_TEMPORAL env override
  // was added then but not turned on by default, this commit turns it
  // on AND hardens against invalid env values (a stray '2.0' or 'foo'
  // would previously fall through to 0.4; now it falls through to 0).
  // Tests in tests/unit/recency-alpha-env.test.ts lock the new contract.
  if (queryType === 'temporal' || queryType === 'temporal-multi-hop') {
    const ovr = process.env.RERANK_RECENCY_ALPHA_TEMPORAL;
    if (ovr !== undefined) {
      const parsed = parseFloat(ovr);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed;
      }
      // Invalid env value (out of range, NaN) → default to 0, not 0.4.
    }
    return 0;
  }
  return RECENCY_ALPHA[queryType] ?? 0.2;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return inter / union;
}

/** Drop near-duplicates from a ranked list. Keeps higher-ranked, refills from overflow. */
function collapseNearDups(
  ranked: FinalScoredCandidate[],
  overflow: FinalScoredCandidate[],
  threshold: number,
  topN: number,
): FinalScoredCandidate[] {
  const kept: FinalScoredCandidate[] = [];
  const keptTokens: Set<string>[] = [];

  const consider = (c: FinalScoredCandidate): boolean => {
    const tokens = tokenize(c.candidate.record.claim);
    for (const k of keptTokens) {
      if (jaccard(tokens, k) >= threshold) return false;
    }
    kept.push(c);
    keptTokens.push(tokens);
    return true;
  };

  for (const c of ranked) {
    if (kept.length >= topN) break;
    consider(c);
  }
  // Refill from overflow if dedup dropped too many.
  for (let i = 0; i < overflow.length && kept.length < topN; i++) {
    consider(overflow[i]!);
  }
  return kept;
}

/** Promise.race utility with explicit timeout flag. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ value: T | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ value: null, timedOut: true });
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ value: v, timedOut: false });
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ value: null, timedOut: false });
        }
      },
    );
  });
}

export interface RerankContext {
  queryType?: QueryType;
  nowIso?: string;
}

/**
 * Rerank candidates by cross-encoder relevance.
 *
 * Compatible API: same 3-arg signature as V2 so existing call sites work.
 * Optional 4th `context` argument lets callers pass queryType + nowIso for
 * accurate recency boost. When omitted, defaults to `single-hop` and now.
 *
 * When RERANKER_ENABLED=false: passthrough candidates.slice(0, topN).
 * When confidence floor not met: returns [] (downstream emits refusal).
 */
export async function rerank(
  query: string,
  candidates: FinalScoredCandidate[],
  topN: number,
  context?: RerankContext,
): Promise<FinalScoredCandidate[]> {
  totalCount += 1;
  lastCallInfo = { degraded: 0, gated: 0, confidenceFloorHit: 0, elapsedMs: 0 };
  if (process.env.RERANKER_ENABLED !== 'true') return candidates.slice(0, topN);
  if (candidates.length === 0) return [];

  // Query-type gating: skip cross-encoder for query types that don't benefit.
  // Only fires when the caller explicitly classified queryType, undefined
  // skips gating and runs the full pipeline (legacy callers stay unchanged).
  // Telemetry records this as a deliberate skip, NOT a degraded fallback.
  const rawQueryType = context?.queryType;
  if (
    process.env.RERANK_QUERY_TYPE_GATING === 'true' &&
    rawQueryType !== undefined &&
    RERANK_SKIP_TYPES.has(rawQueryType)
  ) {
    gatedCount += 1;
    lastCallInfo.gated = 1;
    log.debug({ queryType: rawQueryType, candidateCount: candidates.length }, 'Rerank skipped: query-type gating');
    return candidates.slice(0, topN);
  }

  const ok = await ensureLoaded();
  if (!ok) {
    degradedCount += 1;
    lastCallInfo.degraded = 1;
    return candidates.slice(0, topN);
  }

  const queryType: QueryType = rawQueryType ?? 'single-hop';
  const nowIso = context?.nowIso ?? engineNow();
  const nowMs = new Date(nowIso).getTime();
  const halflifeDays = parseInt(process.env.RERANK_RECENCY_HALFLIFE_DAYS || String(DEFAULT_RECENCY_HALFLIFE_DAYS), 10);
  const timeoutMs = parseInt(process.env.RERANK_TIMEOUT_MS || String(DEFAULT_RERANK_TIMEOUT_MS), 10);
  const confidenceFloor = parseFloat(process.env.RERANK_CONFIDENCE_FLOOR || String(DEFAULT_CONFIDENCE_FLOOR));
  const dedupThreshold = parseFloat(process.env.RERANK_DEDUP_THRESHOLD || String(DEFAULT_DEDUP_THRESHOLD));

  const bounds = extractDateBounds(query, nowIso);
  const alpha = resolveAlpha(queryType, bounds !== null);

  const startMs = performance.now();

  // Cap candidates fed to the cross-encoder. Anything beyond the cap rides
  // through in original RRF order at the tail of the result. Keeps wall-clock
  // bounded; the top of the input list is what most needs reranking anyway.
  const maxCands = parseInt(process.env.RERANK_MAX_CANDIDATES || String(DEFAULT_RERANK_MAX_CANDIDATES), 10);
  const toScore = candidates.slice(0, maxCands);
  const passthrough = candidates.slice(maxCands);

  // Score capped candidates with timeout. On timeout, fall back to RRF order
  // with recency boost only, preserves partial signal without the model.
  const scoreAllPromise = (async () => {
    const out: { c: FinalScoredCandidate; raw: number }[] = [];
    for (const c of toScore) {
      const pair = buildPairText({
        claim: c.candidate.record.claim,
        validFrom: c.candidate.record.validFrom,
        createdAt: c.candidate.record.createdAt,
      });
      const raw = await scoreOne(query, pair);
      out.push({ c, raw });
    }
    return out;
  })();

  const { value: scoredRaw, timedOut } = await withTimeout(scoreAllPromise, timeoutMs);

  if (timedOut || !scoredRaw) {
    degradedCount += 1;
    lastCallInfo.degraded = 1;
    lastCallInfo.elapsedMs = performance.now() - startMs;
    log.warn(
      { timeoutMs, candidateCount: candidates.length, queryType },
      'Rerank timed out; falling back to recency-boosted RRF',
    );
    // Fallback: apply recency boost on RRF scores so we at least keep recency
    // signal active (no model call needed). Then slice.
    const boosted = candidates.map((c) => {
      const recF = recencyFactor(
        { validFrom: c.candidate.record.validFrom, createdAt: c.candidate.record.createdAt },
        nowMs,
        halflifeDays,
      );
      return { c, score: c.finalScore * (1 + alpha * recF) };
    });
    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, topN).map((b) => b.c);
  }

  // Sigmoid + recency boost.
  const finalScored = scoredRaw.map(({ c, raw }) => {
    const sig = sigmoid(raw);
    const recF = recencyFactor(
      { validFrom: c.candidate.record.validFrom, createdAt: c.candidate.record.createdAt },
      nowMs,
      halflifeDays,
    );
    const final = sig * (1 + alpha * recF);
    return { c, sig, final };
  });

  // Sort by final score desc.
  finalScored.sort((a, b) => b.final - a.final);

  // S74 Bug 2 fix: confidence-floor branch falls back to RRF order
  // instead of refusing.
  //
  // Pre-fix: when the top reranker score was below the configured floor
  // (default 0.25), this branch returned `[]`, a refusal-equivalent.
  // 22/296 LOCOMO mini questions (7.4%) tripped this on S3r and got
  // zero memories injected, then the answer model emitted "no info"
  // for questions S1 had answered correctly. Confidence calibration on
  // LOCOMO content (short personal claims) is too pessimistic, the
  // floor was treating top-score 0.20 as garbage when it was actually
  // correct.
  //
  // Post-fix: keep the recordRefusal call so calibration telemetry
  // continues to accrue (Wedge 4 calibrator + bench traces still see
  // the floor-hit signal), but return `candidates.slice(0, topN)` so
  // the user-visible result is the RRF top-K, never the worse-than-
  // baseline empty-result path.
  const top = finalScored[0];
  if (!top || top.final < confidenceFloor) {
    lastCallInfo.confidenceFloorHit = 1;
    lastCallInfo.elapsedMs = performance.now() - startMs;
    log.info(
      { topScore: top?.final ?? 0, floor: confidenceFloor, candidateCount: candidates.length },
      'Rerank confidence floor hit: falling back to RRF order (was refusal-equivalent pre-S74)',
    );
    recordRefusal({
      refusal_type: 'rerank_confidence_floor',
      reason: 'rerank confidence below threshold',
      evidence: {
        top_score: top?.final ?? 0,
        floor: confidenceFloor,
        candidate_count: candidates.length,
      },
      calibration_score: top?.final ?? 0,
    });
    return candidates.slice(0, topN);
  }

  // Slice to topN and apply near-dup collapse (refill from overflow).
  // Overflow includes scored-but-cut candidates AND the passthrough tail
  // (RRF-ordered candidates beyond the cap). Together they backfill any
  // dedup-removed slots and keep the result at topN.
  const ranked = finalScored.slice(0, topN).map((s) => s.c);
  const scoredOverflow = finalScored.slice(topN).map((s) => s.c);
  const overflow = [...scoredOverflow, ...passthrough];
  const deduped = collapseNearDups(ranked, overflow, dedupThreshold, topN);

  const elapsedMs = performance.now() - startMs;
  lastCallInfo.elapsedMs = elapsedMs;
  log.info(
    {
      candidates: candidates.length,
      returned: deduped.length,
      topScore: top.final.toFixed(3),
      alpha,
      queryType,
      hasDateBounds: bounds !== null,
      elapsedMs: elapsedMs.toFixed(1),
    },
    'Rerank',
  );

  return deduped;
}

/**
 * Dispose reranker model.
 */
export async function disposeReranker(): Promise<void> {
  if (session) {
    await session.release();
    session = null;
    tokenizer = null;
    loaded = false;
    loadPromise = null;
    log.info('Reranker model released');
  }
}
