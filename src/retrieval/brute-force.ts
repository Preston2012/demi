/**
 * R2: Subject Brute Force retrieval for COVERAGE queries.
 * 
 * On COVERAGE queries: SELECT all facts for subject, score via FTS5 BM25.
 * Budget compiler caps at MR65.
 * 
 * Flag: BRUTE_FORCE_ENABLED=true
 */

import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate } from '../schema/memory.js';
import { createLogger } from '../config.js';

const log = createLogger('brute-force');

/**
 * Extract primary subject from a coverage query.
 * Looks for capitalized names in the query.
 */
export function extractCoverageSubject(query: string): string | null {
  const namePattern = /\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})*)\b/g;
  const matches = query.match(namePattern) || [];
  const SKIP = new Set([
    'What', 'When', 'Where', 'Who', 'Why', 'How', 'Did', 'Does', 'Do',
    'Is', 'Are', 'Was', 'Were', 'Has', 'Have', 'Had', 'Which', 'Can',
    'Could', 'Would', 'Should', 'Tell', 'List', 'All',
  ]);
  for (const m of matches) {
    if (!SKIP.has(m)) return m;
  }
  return null;
}

/**
 * Brute force retrieval: get all facts for a subject, score with FTS5.
 */
export async function bruteForceRetrieval(
  repo: IMemoryRepository,
  query: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (process.env.BRUTE_FORCE_ENABLED !== 'true') return [];

  const subject = extractCoverageSubject(query);
  if (!subject) {
    log.debug({ query }, 'No subject found for brute force');
    return [];
  }

  // Get all facts for subject
  const subjectFacts = await repo.getBySubject(subject, limit * 3);
  if (subjectFacts.length === 0) return [];

  // Score via FTS5 BM25
  const ftsResults = await repo.searchFTS(query, limit * 3);
  const ftsScoreMap = new Map<string, number>();
  for (const r of ftsResults) {
    ftsScoreMap.set(r.id, r.lexicalScore);
  }

  // Build candidates with FTS scores
  const candidates: ScoredCandidate[] = subjectFacts.map(record => ({
    id: record.id,
    record,
    lexicalScore: ftsScoreMap.get(record.id) || 0.01, // Minimum score for subject match
    vectorScore: 0,
    source: 'fts' as const,
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  }));

  // Sort by FTS score
  candidates.sort((a, b) => b.lexicalScore - a.lexicalScore);

  log.debug({
    subject,
    totalFacts: subjectFacts.length,
    returned: Math.min(candidates.length, limit),
  }, 'Brute force retrieval complete');

  return candidates.slice(0, limit);
}
