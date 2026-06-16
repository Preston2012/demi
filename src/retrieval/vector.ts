import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate } from '../schema/memory.js';
import { encode, isInitialized } from '../embeddings/index.js';
import { EmbeddingError } from '../errors.js';

/**
 * Vector similarity candidate generation.
 *
 * Embeds the query text, then searches sqlite-vec for nearest neighbors.
 * If embeddings aren't initialized (e.g., model missing), returns empty
 * gracefully. Retrieval must never crash; degrade to lexical-only.
 */

/**
 * A3 (flag-gated, OFF by default): binary-quantized first-pass recall.
 *
 * When `BINARY_VECTOR_RECALL=true`, vector search routes through the
 * `memories_vec_bit` table (binary-quantized, 48 bytes/row vs 1.5KB
 * float32, ~32× smaller index, faster Hamming distance). R12 migration
 * comment notes this activates at 50K+ scale.
 *
 * Bench validation required before flipping the default, set the flag,
 * run LOCOMO mini + LME mini, lock `golden-config.json` only if scores
 * hold or improve. See AUDIT_FIXES_NOTES.md "How to flip the deferred
 * flags" section.
 */
function binaryRecallEnabled(): boolean {
  return process.env.BINARY_VECTOR_RECALL === 'true';
}

/**
 * Generate vector candidates for a query.
 * Returns scored candidates with vectorScore set, lexicalScore = 0.
 *
 * Fails gracefully: returns empty if embedding model unavailable.
 */
export async function searchVector(
  repo: IMemoryRepository,
  query: string,
  limit: number,
  userId: string = 'system',
  nowIso?: string,
): Promise<ScoredCandidate[]> {
  if (!isInitialized()) {
    return []; // Degrade gracefully. Lexical search still works.
  }

  let embedding: number[];
  try {
    // BGE asymmetric retrieval: prefix queries, NOT documents.
    // Documents are encoded without prefix in the write path (src/write/index.ts).
    // Ref: https://huggingface.co/BAAI/bge-small-en-v1.5#using-huggingface-transformers
    const prefixedQuery = 'Represent this sentence for searching relevant passages: ' + query;
    embedding = await encode(prefixedQuery);
  } catch (err) {
    if (err instanceof EmbeddingError) {
      // Log but don't crash retrieval
      return [];
    }
    throw err;
  }

  // A3: when flag on, route through the binary-quantized table. The repo
  // interface declares searchVectorBinary as optional, so we feature-detect
  // before invoking, implementations without binary support fall back to
  // the float path automatically.
  if (binaryRecallEnabled() && typeof repo.searchVectorBinary === 'function') {
    return repo.searchVectorBinary(embedding, limit, userId, nowIso);
  }

  return repo.searchVector(embedding, limit, userId, nowIso);
}
