import type { IMemoryRepository } from '../repository/interface.js';
import type { Config } from '../config.js';
import { createLogger } from '../config.js';
import { filterInjectable, applyInhibition, rankCandidates, adaptWeights, type ScoringWeights } from './scorer.js';
import { collapseFactFamilies } from './collapse.js';
import { applyCascade } from './hub-cascade.js';
import { rerank } from './reranker.js';
import { dedupInjectionSet } from './dedup-injection.js';
import type { RetrievalResult } from './index.js';
import type { QueryType } from './query-classifier.js';

const log = createLogger('sql-first');

/**
 * SQL-first fast path for simple queries.
 *
 * @deprecated S20: killed in unified config. Kept behind SQL_FIRST_ROUTING flag
 * (off by default) for potential future revival. Do not enable without A/B retest.
 *
 * For single-hop and current-state queries, FTS5/BM25 keyword matching
 * is sufficient. Skipping vector search eliminates embedding encoding
 * (~50-80ms) and vec table scan (~7ms), bringing retrieval to <5ms.
 *
 * Uses OR-based FTS5 search (any matching term counts) rather than
 * the default AND logic. Strips possessives, punctuation, and stop words
 * to produce clean content-word OR queries.
 *
 * Feature flag: SQL_FIRST_ROUTING (default: false, opt-in)
 * Threshold: SQL_FIRST_MIN_RESULTS (default: 3)
 */

const SQL_FIRST_TYPES: Set<QueryType> = new Set(['single-hop', 'current-state']);

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'must',
  'need',
  'what',
  'when',
  'where',
  'who',
  'whom',
  'which',
  'how',
  'why',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'from',
  'about',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'no',
  'so',
  'if',
  'then',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'up',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'doing',
  'done',
]);

/**
 * Convert a natural language query to OR-joined FTS5 query.
 * Strips possessives, punctuation, stop words. Joins with OR.
 */
export function toOrQuery(query: string): string | null {
  const cleaned = query
    .replace(/'s\b/g, '') // strip possessives
    .replace(/[?!.,;:"'(){}]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (words.length === 0) return null;
  return words.join(' OR ');
}

export function isSqlFirstEligible(queryType: QueryType): boolean {
  if (process.env.SQL_FIRST_ROUTING !== 'true') return false;
  return SQL_FIRST_TYPES.has(queryType);
}

export async function sqlFirstFastPath(
  repo: IMemoryRepository,
  query: string,
  queryType: QueryType,
  config: Config,
  maxResults: number,
): Promise<RetrievalResult | null> {
  const minResults = parseInt(process.env.SQL_FIRST_MIN_RESULTS || '3', 10);
  const totalStart = performance.now();

  // Build OR-based FTS5 query for better recall
  const orQuery = toOrQuery(query);
  if (!orQuery) {
    log.debug({ query }, 'SQL-first: no content words after stop word removal');
    return null;
  }

  // --- FTS5 search with OR logic ---
  const lexStart = performance.now();
  let lexicalCandidates;
  try {
    lexicalCandidates = await repo.searchFTS(orQuery, maxResults * 3);
  } catch {
    // FTS5 can throw on edge-case syntax. Fall through to full pipeline.
    log.debug({ query, orQuery }, 'SQL-first: FTS5 query failed, falling through');
    return null;
  }
  const lexicalMs = performance.now() - lexStart;

  // Confidence gate: need enough FTS5 hits
  if (lexicalCandidates.length < minResults) {
    log.debug(
      { query, queryType, orQuery, hits: lexicalCandidates.length, minRequired: minResults },
      'SQL-first: insufficient FTS5 results, falling through',
    );
    return null;
  }

  // --- Scoring pipeline on FTS5 candidates only ---
  const scoreStart = performance.now();

  const injectable = filterInjectable(lexicalCandidates);
  if (injectable.length === 0) return null;

  const inhibitions = await repo.getActiveInhibitions();
  const afterInhibition = applyInhibition(
    injectable,
    inhibitions.map((m) => ({
      inhibitionTarget: m.inhibitionTarget ?? '',
      confidence: m.confidence,
    })),
  );

  const weights: ScoringWeights = {
    lexicalWeight: config.lexicalWeight,
    vectorWeight: config.vectorWeight,
    provenanceWeight: config.provenanceWeight,
    freshnessWeight: config.freshnessWeight,
    confirmedBonus: config.confirmedBonus,
    contradictionPenaltyBase: config.contradictionPenaltyBase,
    contradictionPenaltyMax: config.contradictionPenaltyMax,
    freshnessHalfLifeDays: config.freshnessHalfLifeDays,
  };
  const adaptedWeights = adaptWeights(afterInhibition, weights);
  const preHubRanked = rankCandidates(afterInhibition, adaptedWeights, maxResults);

  const collapsed = collapseFactFamilies(preHubRanked);
  const cascadeResult = await applyCascade(repo, collapsed, maxResults);
  const postCascade = collapseFactFamilies(cascadeResult.candidates);

  const deduped = process.env.DEDUP_INJECTION_ENABLED === 'true' ? dedupInjectionSet(postCascade) : postCascade;

  const ranked = await rerank(query, deduped, maxResults);

  const mergeAndScoreMs = performance.now() - scoreStart;
  const totalMs = performance.now() - totalStart;

  log.info(
    {
      query,
      queryType,
      orQuery,
      totalMs: Math.round(totalMs * 100) / 100,
      lexicalMs: Math.round(lexicalMs * 100) / 100,
      candidates: ranked.length,
    },
    'SQL-first fast path: skipped vector search',
  );

  return {
    candidates: ranked,
    metadata: {
      query,
      queryType,
      queryEmbedding: null,
      candidatesGenerated: lexicalCandidates.length,
      candidatesAfterFilter: afterInhibition.length,
      candidatesReturned: ranked.length,
      timings: {
        lexicalMs: Math.round(lexicalMs * 100) / 100,
        vectorMs: 0,
        mergeAndScoreMs: Math.round(mergeAndScoreMs * 100) / 100,
        totalMs: Math.round(totalMs * 100) / 100,
      },
    },
  };
}
