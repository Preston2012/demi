import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate } from '../schema/memory.js';

/**
 * FTS5/BM25 lexical candidate generation.
 *
 * Sanitizes the query for FTS5 syntax safety, then delegates
 * to the repository. FTS5 throws on malformed queries (unbalanced
 * quotes, invalid operators). We catch and return empty rather than crash.
 */

/**
 * Sanitize input for FTS5 MATCH syntax.
 * - Strip characters that FTS5 interprets as operators
 * - Collapse whitespace
 * - If result is empty after sanitization, return null (skip FTS search)
 */
export function sanitizeFTSQuery(raw: string): string | null {
  let cleaned = raw;

  // Compound hyphens (word-word) → FTS5 phrase match
  cleaned = cleaned.replace(/(\w)-(\w)/g, '"$1 $2"');

  // Standalone minus (NOT operator) and other FTS5 specials → strip
  cleaned = cleaned.replace(/(?<!\w)-/g, ' ');
  cleaned = cleaned.replace(/[*^(){}:+[\]]/g, ' ');

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Generate lexical candidates for a query.
 * Returns scored candidates with lexicalScore set, vectorScore = 0.
 */
export async function searchLexical(repo: IMemoryRepository, query: string, limit: number): Promise<ScoredCandidate[]> {
  const ftsQuery = sanitizeFTSQuery(query);
  if (!ftsQuery) return [];

  return repo.searchFTS(ftsQuery, limit);
}
