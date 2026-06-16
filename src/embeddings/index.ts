import { InferenceSession, Tensor } from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// A11: dropped @xenova/transformers (vulnerable protobufjs@6 chain via
// onnxruntime-web → onnx-proto) in favor of the maintained @huggingface
// /transformers v4 fork. Same AutoTokenizer.from_pretrained surface +
// the same env.localModelPath/allowRemoteModels knobs. Smoke test in
// tests/unit/embeddings-smoke.test.ts pins the observable contract so
// any output drift gets caught.
// tests/integration/transformer-imports.smoke.test.ts pins the cross-
// file import consistency so any future drift gets caught at CI time.
import { AutoTokenizer, env, type PreTrainedTokenizer } from '@huggingface/transformers';

import { EmbeddingError } from '../errors.js';
import { createLogger } from '../config.js';
import { span, recordLlmCall } from '../telemetry/index.js';

const log = createLogger('embeddings');

/**
 * BGE-small-en-v1.5 ONNX embedding engine (384-dim).
 *
 * Lifecycle:
 * 1. Call initialize() at boot with model path
 * 2. Call encode() to get 384-dim float[] for any text
 * 3. Call dispose() at shutdown
 *
 * Uses real BERT WordPiece tokenizer loaded from tokenizer.json
 * in the model directory. Requires tokenizer.json and tokenizer_config.json
 * alongside the ONNX model file.
 */

let session: InferenceSession | null = null;
let initialized = false;

// --- BERT WordPiece tokenizer (real) ---

const MAX_SEQ_LENGTH = 512;
let tokenizer: PreTrainedTokenizer | null = null;

/**
 * Initialize the BERT wordpiece tokenizer from local files.
 * Loads tokenizer.json from the model directory.
 */
async function initTokenizer(modelDir: string): Promise<void> {
  if (tokenizer) return;
  try {
    // Set local model path for @xenova/transformers to find tokenizer files.
    // The env.localModelPath must point to the PARENT of the model directory
    // so that from_pretrained("models") resolves to models/tokenizer.json.
    env.localModelPath = resolve(modelDir, '..');
    env.allowRemoteModels = false;
    tokenizer = await AutoTokenizer.from_pretrained('models', { local_files_only: true });
    log.info('BERT wordpiece tokenizer loaded from %s', modelDir);
  } catch (err) {
    throw new EmbeddingError(
      `Failed to load tokenizer from ${modelDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function tokenize(text: string): { inputIds: bigint[]; attentionMask: bigint[] } {
  if (!tokenizer) {
    throw new EmbeddingError('Tokenizer not initialized. Call initialize() first.');
  }

  const encoded = tokenizer(text, {
    padding: false,
    truncation: true,
    max_length: MAX_SEQ_LENGTH,
  });

  const ids = encoded.input_ids.data;
  const mask = encoded.attention_mask.data;
  const len = ids.length;

  const inputIds: bigint[] = new Array(len);
  const attentionMask: bigint[] = new Array(len);

  for (let i = 0; i < len; i++) {
    inputIds[i] = BigInt(ids[i]);
    attentionMask[i] = BigInt(mask[i]);
  }

  return { inputIds, attentionMask };
}

// --- Model lifecycle ---

export async function initialize(modelPath: string): Promise<void> {
  if (initialized) return;

  if (!existsSync(modelPath)) {
    throw new EmbeddingError(`ONNX model not found at: ${modelPath}`);
  }

  const startMs = performance.now();

  try {
    // Load BERT tokenizer from same directory as ONNX model
    const modelDir = dirname(modelPath);
    await initTokenizer(modelDir);

    session = await InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 2,
    });
    initialized = true;
    const elapsed = (performance.now() - startMs).toFixed(0);
    log.info(`BGE-small ONNX model + tokenizer loaded in ${elapsed}ms`);
  } catch (err) {
    throw new EmbeddingError(`Failed to load ONNX model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function isInitialized(): boolean {
  return initialized;
}

export async function dispose(): Promise<void> {
  if (session) {
    await session.release();
    session = null;
    tokenizer = null;
    initialized = false;
    log.info('Embedding model + tokenizer released');
  }
}

// --- Embedding Cache (LRU, 1000 entries) ---

import { createHash } from 'node:crypto';
import { getSharedCache } from '../cache/cache-store.js';

const CACHE_MAX = 1000;
const embeddingCache = new Map<string, number[]>();

// S65 Sprint 1 (M4): persistent embedding cache identifier. Bump this when
// the embedding model or tokenization changes so old vectors auto-bust.
// Default model is BGE-small-en-v1.5 (384-dim), see initialize() / config.
const EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION || 'bge-small-en-v1.5-onnx-fp32';

// S65 Sprint 1 (M4): persistent disk cache toggle. ON by default; tests and
// pure-inference benchmarks can set DEMIURGE_PERSISTENT_EMBED_CACHE=false.
function persistentEmbedCacheEnabled(): boolean {
  return process.env.DEMIURGE_PERSISTENT_EMBED_CACHE !== 'false';
}

function cacheKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function getCached(text: string): number[] | null {
  const key = cacheKey(text);
  const cached = embeddingCache.get(key);
  if (cached) {
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }
  // S65 Sprint 1 (M4): in-memory miss → check persistent cache.
  if (persistentEmbedCacheEnabled()) {
    try {
      const disk = getSharedCache().getEmbedding(text, EMBEDDING_MODEL_VERSION);
      if (disk) {
        // Promote to in-memory LRU
        if (embeddingCache.size >= CACHE_MAX) {
          const oldest = embeddingCache.keys().next().value;
          if (oldest) embeddingCache.delete(oldest);
        }
        embeddingCache.set(key, disk.vector);
        return disk.vector;
      }
    } catch {
      // Persistent cache failures must never break inference. Fall through.
    }
  }
  return null;
}

function setCache(text: string, embedding: number[]): void {
  const key = cacheKey(text);
  if (embeddingCache.size >= CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, embedding);
  // S65 Sprint 1 (M4): mirror to persistent cache. Best-effort only.
  if (persistentEmbedCacheEnabled()) {
    try {
      getSharedCache().putEmbedding(text, EMBEDDING_MODEL_VERSION, embedding);
    } catch {
      // Persistent cache write failures must never break inference.
    }
  }
}

// --- Encode ---

/**
 * Encode text to a 384-dim float array (BGE-small).
 * Uses mean pooling over non-padding token embeddings.
 *
 * Throws EmbeddingError if model not initialized or inference fails.
 */
export async function encode(text: string): Promise<number[]> {
  if (!session) {
    throw new EmbeddingError('Embedding model not initialized. Call initialize() first.');
  }

  if (!text.trim()) {
    throw new EmbeddingError('Cannot encode empty text.');
  }

  // Capture the non-null session reference for the inner closure (TS narrowing
  // doesn't survive the arrow function boundary).
  const activeSession = session;
  return span(
    'embed.generate',
    async () => {
      const embedStart = Date.now();

      // Check cache first
      const cached = getCached(text);
      if (cached) {
        recordLlmCall({
          provider: 'bge-onnx',
          model: 'bge-small-en-v1.5',
          latency_ms: Date.now() - embedStart,
          cache_hit: true,
          status: 'ok',
        });
        return cached;
      }

      const { inputIds, attentionMask } = tokenize(text);
      const seqLength = inputIds.length;

      try {
        const feeds: Record<string, Tensor> = {
          input_ids: new Tensor('int64', inputIds, [1, seqLength]),
          attention_mask: new Tensor('int64', attentionMask, [1, seqLength]),
        };

        // Some models also expect token_type_ids
        if (activeSession.inputNames.includes('token_type_ids')) {
          feeds.token_type_ids = new Tensor('int64', new Array(seqLength).fill(0n), [1, seqLength]);
        }

        const results = await activeSession.run(feeds);

        // Try sentence_embedding first (some exports include it), then last_hidden_state
        if (results.sentence_embedding) {
          // S65 Sprint 1: bug fix, earlier code returned without populating the
          // in-memory LRU on this path. Every encode() that took this branch was
          // a cold cache hit. Capture, cache, then return.
          const sentenceVec = Array.from(results.sentence_embedding.data as Float32Array);
          setCache(text, sentenceVec);
          recordLlmCall({
            provider: 'bge-onnx',
            model: 'bge-small-en-v1.5',
            latency_ms: Date.now() - embedStart,
            cache_hit: false,
            status: 'ok',
          });
          return sentenceVec;
        }

        // Mean pooling over last_hidden_state
        const output = results.last_hidden_state;
        if (!output) {
          throw new EmbeddingError('Model output missing both sentence_embedding and last_hidden_state');
        }

        const data = output.data as Float32Array;
        const hiddenDim = output.dims[2]!; // [batch, seq_len, hidden_dim]
        const embedding = new Float64Array(hiddenDim);
        let tokenCount = 0;

        for (let t = 0; t < seqLength; t++) {
          if (attentionMask[t] === 1n) {
            for (let d = 0; d < hiddenDim; d++) {
              embedding[d]! += data[t * hiddenDim + d]!;
            }
            tokenCount++;
          }
        }

        if (tokenCount === 0) {
          throw new EmbeddingError('No valid tokens after tokenization');
        }

        // Average + normalize to unit vector
        const result = new Array<number>(hiddenDim);
        let norm = 0;
        for (let d = 0; d < hiddenDim; d++) {
          result[d] = embedding[d]! / tokenCount;
          norm += result[d]! * result[d]!;
        }
        norm = Math.sqrt(norm);

        if (norm > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            result[d] = result[d]! / norm;
          }
        }

        setCache(text, result);
        recordLlmCall({
          provider: 'bge-onnx',
          model: 'bge-small-en-v1.5',
          latency_ms: Date.now() - embedStart,
          cache_hit: false,
          status: 'ok',
        });
        return result;
      } catch (err) {
        recordLlmCall({
          provider: 'bge-onnx',
          model: 'bge-small-en-v1.5',
          latency_ms: Date.now() - embedStart,
          cache_hit: false,
          status: 'error',
        });
        if (err instanceof EmbeddingError) throw err;
        throw new EmbeddingError(`Embedding inference failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    { text_len: text.length },
  );
}

/**
 * Cosine similarity between two normalized vectors.
 * Both vectors must be the same length. Returns -1 to 1.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingError(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot; // Already normalized in encode()
}
