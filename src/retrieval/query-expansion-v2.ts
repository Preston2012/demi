/**
 * NOVEL-1: State-pack-aware query expansion.
 * 
 * Enriches query embedding with entity context from state packs.
 * Instead of multi-query (killed in R10), creates a SINGLE enriched embedding
 * that includes entity context. Adds subject's current state to the query
 * vector representation.
 * 
 * Example: "What does Alex do?" → embed("What does Alex do? [Alex: software engineer at TechCorp, lives in Seattle]")
 * 
 * Flag: QUERY_EXPANSION_V2=true
 */

import type { IMemoryRepository } from '../repository/interface.js';
import { encode, isInitialized } from '../embeddings/index.js';
import { createLogger } from '../config.js';

const log = createLogger('query-expansion-v2');

const MAX_CONTEXT_CHARS = 200;

/**
 * Extract subject names from a query for state pack lookup.
 */
function extractQuerySubjects(query: string): string[] {
  const namePattern = /\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})*)\b/g;
  const matches = query.match(namePattern) || [];
  const SKIP = new Set([
    'What', 'When', 'Where', 'Who', 'Why', 'How', 'Did', 'Does', 'Do',
    'Is', 'Are', 'Was', 'Were', 'Has', 'Have', 'Had', 'Which', 'Can',
    'Could', 'Would', 'Should', 'Tell', 'Describe', 'Summarize',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
  ]);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const m of matches) {
    if (SKIP.has(m)) continue;
    if (seen.has(m.toLowerCase())) continue;
    seen.add(m.toLowerCase());
    results.push(m);
  }
  return results;
}

/**
 * Build an enriched query string with state pack context.
 * Returns the original query with appended entity context.
 */
export async function buildEnrichedQuery(
  query: string,
  repo: IMemoryRepository,
): Promise<string> {
  if (process.env.QUERY_EXPANSION_V2 !== 'true') return query;

  try {
    const subjects = extractQuerySubjects(query);
    if (subjects.length === 0) return query;

    // Get compact state pack context for detected subjects
    const stateContext = await repo.buildStatePackInjection(query, false);
    if (!stateContext || stateContext.trim().length === 0) return query;

    // Only enrich if state pack has substantive context (>40 chars, indicating real data)
    // Prevents noisy enrichment from near-empty state packs
    if (stateContext.trim().length < 40) {
      log.debug({ contextLen: stateContext.trim().length }, 'State pack context too thin for enrichment, skipping');
      return query;
    }

    // Truncate context to avoid bloating the embedding input
    const truncated = stateContext.trim().slice(0, MAX_CONTEXT_CHARS);
    const enriched = `${query} [${truncated}]`;

    log.debug({
      subjects: subjects.length,
      contextLen: truncated.length,
      enrichedLen: enriched.length,
    }, 'Query enriched with state pack context');

    return enriched;
  } catch (err) {
    log.warn({ err }, 'Query expansion V2 failed, using original query');
    return query;
  }
}

/**
 * Encode an enriched query embedding.
 * Uses state pack context to create a more informed embedding.
 */
export async function encodeEnrichedQuery(
  query: string,
  repo: IMemoryRepository,
): Promise<number[] | null> {
  if (!isInitialized()) return null;

  const enriched = await buildEnrichedQuery(query, repo);
  const prefixed = 'Represent this sentence for searching relevant passages: ' + enriched;

  try {
    return await encode(prefixed);
  } catch (err) {
    log.warn({ err }, 'Enriched query encoding failed');
    return null;
  }
}
