import { createHash } from 'node:crypto';
import type { IMemoryRepository } from '../repository/interface.js';
import { normalizeForComparison } from './validators.js';

/**
 * Two-layer deduplication.
 *
 * Layer 1: Exact match via source hash.
 *   Hash the normalized claim text. If a stored memory has the
 *   same hash, it's an exact duplicate. Fast, zero LLM cost.
 *
 * Layer 2: Semantic similarity via embedding cosine distance.
 *   If no exact match, check if any stored memory is semantically
 *   near-identical (above similarity threshold). Catches paraphrases.
 *
 * Both layers are deterministic. No LLM calls.
 */

const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

export interface DedupResult {
  isDuplicate: boolean;
  matchType: 'exact' | 'semantic' | null;
  existingId: string | null;
  similarity: number | null;
}

/**
 * Compute source hash from normalized claim text.
 * Used for exact-match dedup and stored on every memory record.
 */
export function computeSourceHash(claim: string): string {
  const normalized = normalizeForComparison(claim);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Check for exact duplicate by source hash.
 */
async function checkExactDuplicate(
  repo: IMemoryRepository,
  sourceHash: string,
): Promise<DedupResult> {
  const existing = await repo.findBySourceHash(sourceHash);
  if (existing) {
    return {
      isDuplicate: true,
      matchType: 'exact',
      existingId: existing.id,
      similarity: 1.0,
    };
  }
  return {
    isDuplicate: false,
    matchType: null,
    existingId: null,
    similarity: null,
  };
}

/**
 * Check for semantic near-duplicate via embedding similarity.
 * Only called if exact match fails.
 *
 * @param embedding Pre-computed embedding for the new claim
 * @param threshold Cosine similarity threshold (0-1). Above = duplicate.
 */
async function checkSemanticDuplicate(
  repo: IMemoryRepository,
  embedding: number[],
  threshold: number,
): Promise<DedupResult> {
  const similar = await repo.findSimilar(embedding, threshold);

  if (similar.length > 0) {
    // Take the most similar
    const best = similar.sort(
      (a, b) => b.vectorScore - a.vectorScore,
    )[0]!;

    return {
      isDuplicate: true,
      matchType: 'semantic',
      existingId: best.id,
      similarity: best.vectorScore,
    };
  }

  return {
    isDuplicate: false,
    matchType: null,
    existingId: null,
    similarity: null,
  };
}

/**
 * Run full dedup check: exact first, then semantic.
 *
 * @param repo Memory repository
 * @param claim Raw claim text
 * @param embedding Pre-computed embedding (null skips semantic check)
 * @param threshold Similarity threshold (default 0.92)
 */
export async function checkDuplicate(
  repo: IMemoryRepository,
  claim: string,
  embedding: number[] | null,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<DedupResult> {
  // Layer 1: exact match
  const sourceHash = computeSourceHash(claim);
  const exactResult = await checkExactDuplicate(repo, sourceHash);
  if (exactResult.isDuplicate) return exactResult;

  // Layer 2: semantic similarity (if embedding available)
  if (embedding) {
    return checkSemanticDuplicate(repo, embedding, threshold);
  }

  return {
    isDuplicate: false,
    matchType: null,
    existingId: null,
    similarity: null,
  };
}
