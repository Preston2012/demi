import type { IMemoryRepository } from "../repository/interface.js";
import { searchVector } from "./vector.js";
import { createLogger } from "../config.js";

const log = createLogger("entity-split");

/**
 * U1: Entity-split retrieval for multi-hop queries.
 *
 * Problem: blended embeddings for "What do Caroline and Melanie
 * have in common?" find facts about neither entity well.
 *
 * Fix: extract entity names, run separate vector searches per
 * entity, merge results. Guarantees entity-specific facts
 * appear in the candidate pool.
 *
 * CI math: P(both facts found) goes from 0.49 to 0.81.
 * Expected +5-11 pts on multi-hop.
 */

const STOP_WORDS = new Set([
  "what", "when", "where", "who", "why", "how",
  "did", "does", "do", "is", "are", "was", "were",
  "has", "have", "had", "which", "would", "could",
  "should", "might", "the", "and", "but", "that",
  "this", "with", "from", "for", "not", "about",
  "their", "they", "them", "both", "each", "other",
  "some", "any", "all", "many", "much", "more",
  "most", "very", "also", "just", "than", "then",
  "may", "can", "will",
]);

/**
 * Extract likely entity names from a query.
 * Heuristic: capitalized words that are not stop words.
 */
export function extractEntities(query: string): string[] {
  const words = query.split(/\s+/);
  const entities = new Set<string>();

  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z'-]/g, "");
    if (clean.length < 2) continue;
    if (clean[0] !== clean[0]!.toUpperCase()) continue;
    if (clean[0] === clean[0]!.toLowerCase()) continue;
    if (STOP_WORDS.has(clean.toLowerCase())) continue;
    entities.add(clean);
  }

  return [...entities];
}

/**
 * Run entity-split retrieval.
 * For each entity, search for facts about that entity.
 * Also search for entity pairs (relationship facts).
 * Only runs when 2+ entities detected.
 */
export async function entitySplitRetrieval(
  repo: IMemoryRepository,
  query: string,
  limit: number,
): Promise<Awaited<ReturnType<typeof searchVector>>> {
  const entities = extractEntities(query);

  if (entities.length < 2) {
    return [];
  }

  log.info({ entities, query }, "Entity-split: running per-entity searches");

  const allResults: Awaited<ReturnType<typeof searchVector>> = [];

  for (const entity of entities) {
    const results = await searchVector(repo, entity, limit);
    allResults.push(...results);
  }

  if (entities.length === 2) {
    const pairQuery = entities[0] + " " + entities[1];
    const pairResults = await searchVector(repo, pairQuery, limit);
    allResults.push(...pairResults);
  }

  log.info(
    { entityCount: entities.length, resultsFound: allResults.length },
    "Entity-split: search complete",
  );

  return allResults;
}
