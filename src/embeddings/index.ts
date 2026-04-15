import { InferenceSession, Tensor } from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AutoTokenizer, env, type PreTrainedTokenizer } from '@xenova/transformers';

import { EmbeddingError } from '../errors.js';
import { createLogger } from '../config.js';

const log = createLogger('embeddings');

/**
 * BGE-large-en-v1.5 ONNX embedding engine (1024-dim).
 *
 * Lifecycle:
 * 1. Call initialize() at boot with model path
 * 2. Call encode() to get 1024-dim float[] for any text
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
    log.info(`BGE-large ONNX model + tokenizer loaded in ${elapsed}ms`);
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

const CACHE_MAX = 1000;
const embeddingCache = new Map<string, number[]>();

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
  return null;
}

function setCache(text: string, embedding: number[]): void {
  const key = cacheKey(text);
  if (embeddingCache.size >= CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, embedding);
}

// --- Encode ---

/**
 * Encode text to a 1024-dim float array (BGE-large).
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

  // Check cache first
  const cached = getCached(text);
  if (cached) return cached;

  const { inputIds, attentionMask } = tokenize(text);
  const seqLength = inputIds.length;

  try {
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor('int64', inputIds, [1, seqLength]),
      attention_mask: new Tensor('int64', attentionMask, [1, seqLength]),
    };

    // Some models also expect token_type_ids
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new Tensor('int64', new Array(seqLength).fill(0n), [1, seqLength]);
    }

    const results = await session.run(feeds);

    // Try sentence_embedding first (some exports include it), then last_hidden_state
    if (results.sentence_embedding) {
      return Array.from(results.sentence_embedding.data as Float32Array);
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
    return result;
  } catch (err) {
    if (err instanceof EmbeddingError) throw err;
    throw new EmbeddingError(`Embedding inference failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
