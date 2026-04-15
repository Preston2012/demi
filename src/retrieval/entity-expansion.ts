import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate } from '../schema/memory.js';
import { searchLexical } from './lexical.js';
import { createLogger } from '../config.js';

const log = createLogger('entity-expansion');

/**
 * Relationship terms that indicate entity references.
 * Maps relationship term to the subject field that might contain the name.
 */
// STR-1: Generic relationship terms only. No hardcoded names.
// Entity names are extracted dynamically from candidate claims at runtime.
const RELATIONSHIP_TERMS: Record<string, string[]> = {
  partner: ['partner', 'spouse', 'wife', 'husband', 'girlfriend', 'boyfriend', 'significant other'],
  dog: ['pets', 'dog', 'puppy'],
  cat: ['pets', 'cat', 'kitten'],
  pet: ['pets', 'dog', 'cat', 'animal'],
  boss: ['workplace', 'manager', 'supervisor'],
  coworker: ['workplace', 'colleague', 'team'],
  friend: ['friend', 'buddy', 'companion'],
  sibling: ['sibling', 'brother', 'sister'],
  parent: ['parent', 'mother', 'father', 'mom', 'dad'],
  child: ['child', 'son', 'daughter', 'kid'],
};

/**
 * Extract proper names from candidate memories that match
 * relationship context in the query.
 */
function extractEntityNames(query: string, candidates: ScoredCandidate[]): string[] {
  const queryLower = query.toLowerCase();
  const names: string[] = [];

  for (const candidate of candidates) {
    const claim = candidate.record.claim.toLowerCase();
    const subject = candidate.record.subject.toLowerCase();

    // Check if any relationship term appears in the query
    for (const [term, relatedSubjects] of Object.entries(RELATIONSHIP_TERMS)) {
      if (!queryLower.includes(term)) continue;

      // If this candidate is about the related entity, extract proper names
      if (relatedSubjects.some((s) => subject.includes(s) || claim.includes(s))) {
        // Extract capitalized words as potential proper names
        const words = candidate.record.claim.split(/\s+/);
        for (const word of words) {
          const cleaned = word.replace(/[^a-zA-Z]/g, '');
          if (
            cleaned.length > 1 &&
            cleaned[0] === cleaned[0]!.toUpperCase() &&
            cleaned[0] !== cleaned[0]!.toLowerCase()
          ) {
            // Avoid common non-name capitalized words
            const skipWords = new Set(['User', 'The', 'This', 'That', 'She', 'He', 'Her', 'His', 'A', 'An']);
            if (!skipWords.has(cleaned)) {
              names.push(cleaned);
            }
          }
        }
      }
    }
  }

  return [...new Set(names)]; // Deduplicate
}

/**
 * Expand retrieval with entity-specific queries.
 *
 * If the query mentions relationship terms (partner, pet, etc.),
 * find the entity's proper name from initial candidates,
 * then search specifically for that entity's details.
 */
export async function expandEntityQuery(
  repo: IMemoryRepository,
  query: string,
  initialCandidates: ScoredCandidate[],
  limit: number,
): Promise<ScoredCandidate[]> {
  const entityNames = extractEntityNames(query, initialCandidates);

  if (entityNames.length === 0) return [];

  log.debug({ query, entityNames }, 'Entity expansion triggered');

  const expansionResults: ScoredCandidate[] = [];

  for (const name of entityNames) {
    // Search for memories mentioning this entity name
    const lexResults = await searchLexical(repo, name, limit);
    expansionResults.push(...lexResults);
  }

  if (expansionResults.length > 0) {
    log.info({ entityNames, expanded: expansionResults.length }, 'Entity expansion added candidates');
  }

  return expansionResults;
}
