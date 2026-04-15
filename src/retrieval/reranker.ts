/**
 * Cross-encoder reranker for second-stage relevance scoring.
 *
 * @note S29: regressed -1.7% on unified config in A/B. Kept behind
 * RERANKER_ENABLED flag (off by default) for future experimentation.
 *
 * V2: bge-reranker-base ONNX (278M, BERT-based, passage/QA domain).
 *
 * KILL HISTORY (council-mandated documentation):
 *   V1: ms-marco-MiniLM-L6-v2 (web-search domain). KILLED at -25 pts.
 *   Root cause: domain mismatch. ms-marco was trained on web search queries,
 *   not memory claims. Cross-encoder domain MUST match data domain (UIK I-294).
 *   V2 fix: bge-reranker-base is trained on passage/QA pairs, matching
 *   our claim/query pattern. OMEGA uses the same model at 95.4% LME.
 *
 * GATING (R14 council mandate):
 *   Only rerank top-K candidates from the pre-scorer, not all.
 *   RERANKER_GATE_SIZE env var (default: 10). Council recommended 5-10.
 *   Remaining candidates pass through with original scores, appended after.
 *
 * Feature flag: RERANKER_ENABLED !== 'true' (default OFF, F-1).
 * Lazy init: model loaded on first rerank() call when flag ON.
 */
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AutoTokenizer, env } from '@xenova/transformers';
import { createLogger } from '../config.js';
import type { FinalScoredCandidate } from './scorer.js';

const log = createLogger('reranker');

let session: InferenceSession | null = null;
let tokenizer: any = null;
let loaded = false;
let loadPromise: Promise<boolean> | null = null;

const MAX_SEQ_LENGTH = 512;

/**
 * Load bge-reranker-base ONNX model + tokenizer.
 * Lazy-loaded on first use. Idempotent.
 */
async function ensureLoaded(): Promise<boolean> {
  if (loaded) return true;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const modelPath = resolve(process.cwd(), process.env.RERANKER_MODEL_PATH || 'models/bge-reranker-base.onnx');

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

      // Load tokenizer from model directory
      const modelDir = dirname(modelPath);
      env.localModelPath = resolve(modelDir, '..');
      env.allowRemoteModels = false;
      tokenizer = await AutoTokenizer.from_pretrained('models', { local_files_only: true });

      loaded = true;
      const elapsed = (performance.now() - startMs).toFixed(0);
      log.info('bge-reranker-base ONNX loaded in %sms', elapsed);
      return true;
    } catch (err) {
      log.error('Failed to load reranker: %s', err instanceof Error ? err.message : String(err));
      session = null;
      return false;
    }
  })();

  return loadPromise;
}

/**
 * Score a single query-claim pair.
 * Cross-encoder: [CLS] query [SEP] claim [SEP] → relevance logit.
 */
async function scoreOne(query: string, claim: string): Promise<number> {
  if (!session || !tokenizer) return 0;

  const encoded = tokenizer(query, {
    text_pair: claim,
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

  // Cross-encoder output: logits [1, 1] or [1]
  const logits = results.logits || results.output;
  if (!logits) {
    log.warn('Reranker output missing logits. Keys: %s', Object.keys(results).join(','));
    return 0;
  }

  return (logits.data as Float32Array)[0] ?? 0;
}

/**
 * Rerank candidates by cross-encoder relevance.
 *
 * Compatible API: same signature as V1 so index.ts needs zero changes.
 * When RERANKER_ENABLED=false, returns candidates.slice(0, topN) (passthrough).
 */
export async function rerank(
  query: string,
  candidates: FinalScoredCandidate[],
  topN: number,
): Promise<FinalScoredCandidate[]> {
  if (process.env.RERANKER_ENABLED !== 'true') return candidates.slice(0, topN);

  const ok = await ensureLoaded();
  if (!ok) return candidates.slice(0, topN);

  const startMs = performance.now();

  // Gating: only cross-encode the top-K from pre-scorer (council R14 mandate)
  const gateSize = parseInt(process.env.RERANKER_GATE_SIZE || '10', 10);
  const gatedCandidates = candidates.slice(0, gateSize);
  const remainderCandidates = candidates.slice(gateSize);

  // Score gated candidates with cross-encoder
  const scored: { candidate: FinalScoredCandidate; rerankerScore: number }[] = [];
  for (const c of gatedCandidates) {
    const score = await scoreOne(query, c.candidate.record.claim);
    scored.push({ candidate: c, rerankerScore: score });
  }

  // Sort reranked portion by cross-encoder score
  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

  // Combine: reranked top-K + remaining in original order
  const reranked = scored.map((s) => s.candidate);
  const combined = [...reranked, ...remainderCandidates];

  const elapsed = (performance.now() - startMs).toFixed(1);
  const top = scored[0]?.rerankerScore?.toFixed(3) ?? '?';
  const bottom = scored[scored.length - 1]?.rerankerScore?.toFixed(3) ?? '?';
  log.info(
    'Reranked %d/%d (gate=%d) -> %d in %sms (top: %s, bottom: %s)',
    gatedCandidates.length,
    candidates.length,
    gateSize,
    Math.min(topN, combined.length),
    elapsed,
    top,
    bottom,
  );

  return combined.slice(0, topN);
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
