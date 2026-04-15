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
 * Generate vector candidates for a query.
 * Returns scored candidates with vectorScore set, lexicalScore = 0.
 *
 * Fails gracefully: returns empty if embedding model unavailable.
 */
export async function searchVector(repo: IMemoryRepository, query: string, limit: number): Promise<ScoredCandidate[]> {
  if (!isInitialized()) {
    return []; // Degrade gracefully. Lexical search still works.
  }

  let embedding: number[];
  try {
    // BGE asymmetric retrieval: prefix queries, NOT documents.
    // Documents are encoded without prefix in the write path (src/write/index.ts).
    // Ref: https://huggingface.co/BAAI/bge-large-en-v1.5#using-huggingface-transformers
    const prefixedQuery = 'Represent this sentence for searching relevant passages: ' + query;
    embedding = await encode(prefixedQuery);
  } catch (err) {
    if (err instanceof EmbeddingError) {
      // Log but don't crash retrieval
      return [];
    }
    throw err;
  }

  return repo.searchVector(embedding, limit);
}
