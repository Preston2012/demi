/**
 * RAR: Retrieve-Augment-Retrieve for multi-hop queries.
 *
 * @note RAR: unproven in unified config. Behind RAR_ENABLED flag
 * (off by default). Do not enable without A/B retest.
 *
 * After first retrieval pass, extracts new entities and temporal
 * references from top-K results, then runs a second retrieval
 * pass to find bridging facts.
 *
 * Targets multi-hop temporal failures: "When did X happen?" where
 * first pass finds "X happened last Friday" but can't resolve the date
 * without knowing the conversation timestamp.
 *
 * Also helps multi-hop entity bridging: finds facts about entities
 * mentioned IN retrieved facts but not in the original query.
 *
 * Flag: RAR_ENABLED=true (default: false)
 * Only runs for multi-hop and temporal query types.
 */

import type { IMemoryRepository } from '../repository/interface.js';
import { searchVector } from './vector.js';
import { createLogger } from '../config.js';
import type { ScoredCandidate } from '../schema/memory.js';

const log = createLogger('rar');

/**
 * Extract entities from retrieved fact claims that weren't in the original query.
 * Returns new entity names to search for.
 */
export function extractBridgeEntities(claims: string[], originalQuery: string): string[] {
  const queryLower = originalQuery.toLowerCase();

  const newEntities = new Set<string>();

  for (const claim of claims) {
    // Find capitalized names in claims
    const namePattern = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\b/g;
    let match;
    while ((match = namePattern.exec(claim)) !== null) {
      const name = match[1]!;
      // Skip if name appears in original query
      if (queryLower.includes(name.toLowerCase())) continue;
      // Skip common non-entity words
      const skip = new Set([
        'The',
        'This',
        'That',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ]);
      if (skip.has(name)) continue;
      newEntities.add(name);
    }
  }

  return [...newEntities].slice(0, 5); // Cap at 5 bridge entities
}

/**
 * Extract temporal context from retrieved facts.
 * Finds specific dates mentioned in claims that could help resolve
 * relative time references.
 */
export function extractTemporalContext(claims: string[]): string[] {
  const temporalQueries: string[] = [];
  const datePattern =
    /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*,?\s*\d{4}|\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/gi;

  const dates = new Set<string>();
  for (const claim of claims) {
    let match;
    while ((match = datePattern.exec(claim)) !== null) {
      dates.add(match[1]!);
    }
  }

  // For each unique date, create a temporal context query
  for (const date of [...dates].slice(0, 3)) {
    temporalQueries.push(date);
  }

  return temporalQueries;
}

/**
 * Run RAR: second retrieval pass using context from first-pass results.
 *
 * @param repo Memory repository
 * @param originalQuery Original user query
 * @param firstPassClaims Top claims from first retrieval pass
 * @param queryType Classified query type
 * @param limit Max candidates to return
 */
export async function rarRetrieval(
  repo: IMemoryRepository,
  originalQuery: string,
  firstPassClaims: string[],
  queryType: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (process.env.RAR_ENABLED !== 'true') return [];
  if (queryType !== 'multi-hop' && queryType !== 'temporal') return [];

  const allResults: ScoredCandidate[] = [];

  // 1. Bridge entity retrieval
  const bridgeEntities = extractBridgeEntities(firstPassClaims, originalQuery);
  if (bridgeEntities.length > 0) {
    log.debug({ bridgeEntities }, 'RAR: searching bridge entities');
    for (const entity of bridgeEntities.slice(0, 3)) {
      const results = await searchVector(repo, entity, Math.floor(limit / 3));
      allResults.push(...results);
    }
  }

  // 2. Temporal context retrieval
  if (queryType === 'temporal') {
    const temporalQueries = extractTemporalContext(firstPassClaims);
    if (temporalQueries.length > 0) {
      log.debug({ temporalQueries }, 'RAR: searching temporal context');
      for (const tq of temporalQueries.slice(0, 2)) {
        const results = await searchVector(repo, tq, Math.floor(limit / 3));
        allResults.push(...results);
      }
    }
  }

  log.info(
    {
      bridgeEntities: bridgeEntities.length,
      newCandidates: allResults.length,
      queryType,
    },
    'RAR: second pass complete',
  );

  return allResults;
}
