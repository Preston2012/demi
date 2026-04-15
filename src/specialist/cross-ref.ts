import { extractEntities } from './ir.js';
/**
 * Multi-hop cross-reference specialist.
 *
 * Targets: LOCOMO multi-hop (11.8 pts). Specifically the 43% of failures
 * where the question asks about relationships BETWEEN entities.
 *
 * "What activities has Andrew done WITH HIS GIRLFRIEND?"
 * Needs: facts about Andrew + facts about girlfriend + intersection where both appear.
 *
 * The list enumerator scans one subject. This scans relationships between
 * multiple subjects and extracts the target attribute from the intersection.
 *
 * Trigger: query mentions 2+ entities AND asks for shared/connecting attributes.
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Entity Pair Detection
// ---------------------------------------------------------------------------

interface CrossRefQuery {
  entities: string[];           // 2+ entities from the query
  relationKeywords: string[];   // "with", "together", "both", "and"
  targetAttribute: string;      // what we're looking for about the pair
  isSharedQuery: boolean;       // asking about something shared/common
}

const SHARED_PATTERNS = /\b(together|both|shared|common|mutual|with (?:his|her|their)|with each other|in common|similar)\b/i;
const RELATION_PATTERNS = /\b(with|and|between|for .+ and)\b/i;

function detectCrossRef(query: string): CrossRefQuery | null {
  // Extract all capitalized names (potential entities)
  const entities = extractEntities(query);
  if (entities.length === 0) return null;

  // Need at least 2 entities, or 1 entity + relational pronoun
  const hasRelationalPronoun = /\b(his|her|their)\s+(wife|husband|girlfriend|boyfriend|partner|friend|colleague|sister|brother|mother|father|mom|dad|family)\b/i.test(query);

  if (entities.length < 2 && !hasRelationalPronoun) return null;

  // Extract relation keywords
  const relationKeywords: string[] = [];
  const relMatch = query.match(RELATION_PATTERNS);
  if (relMatch) relationKeywords.push(relMatch[0]);

  // Detect if this is a "shared" query
  const isSharedQuery = SHARED_PATTERNS.test(query) || relationKeywords.length > 0;

  // Extract target attribute from question
  const stopwords = new Set([
    'what', 'which', 'where', 'when', 'who', 'how', 'does', 'did', 'is', 'are',
    'was', 'were', 'has', 'have', 'had', 'the', 'a', 'an', 'of', 'in', 'to',
    'for', 'with', 'on', 'at', 'by', 'from', 'that', 'this', 'and', 'or',
    'his', 'her', 'their', 'do', 'done', 'been',
  ]);
  const words = query.replace(/[?.,!'"]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()) && !/^[A-Z]/.test(w));
  const targetAttribute = words.join(' ').toLowerCase();

  return { entities, relationKeywords, targetAttribute, isSharedQuery };
}

// ---------------------------------------------------------------------------
// Cross-Reference Logic
// ---------------------------------------------------------------------------

interface CrossRefResult {
  sharedFacts: Array<{
    fact: NormalizedFact;
    matchedEntities: string[];
    relevanceScore: number;
  }>;
  entitySpecificFacts: Map<string, NormalizedFact[]>;
}

function findCrossReferences(
  facts: NormalizedFact[],
  crossRef: CrossRefQuery,
): CrossRefResult {
  const entityLower = crossRef.entities.map(e => e.toLowerCase());

  // Categorize facts by which entities they mention
  const sharedFacts: CrossRefResult['sharedFacts'] = [];
  const entitySpecificFacts = new Map<string, NormalizedFact[]>();

  for (const entity of crossRef.entities) {
    entitySpecificFacts.set(entity, []);
  }

  for (const fact of facts) {
    if (fact.negated) continue;
    if (fact.certainty === 'superseded') continue;

    const claimLower = fact.sourceText.toLowerCase();
    const subjectLower = fact.subject.toLowerCase();

    // Check which entities this fact mentions
    const matchedEntities: string[] = [];
    for (let i = 0; i < entityLower.length; i++) {
      if (subjectLower.includes(entityLower[i]!) || claimLower.includes(entityLower[i]!)) {
        matchedEntities.push(crossRef.entities[i]!);
      }
    }

    // S27 fix #12: Tighter relational pronoun expansion
    // Only promote to shared if the relationship term appears ADJACENT to
    // a query entity name (within 5 words). Don't blindly add all entities.
    if (matchedEntities.length === 1) {
      const matched = matchedEntities[0]!.toLowerCase();
      const relTerms = ['girlfriend', 'boyfriend', 'wife', 'husband', 'partner', 'friend', 'colleague'];
      for (const term of relTerms) {
        // Check if the relation term appears near the matched entity
        const nearPattern = new RegExp(matched + '.{0,40}' + term + '|' + term + '.{0,40}' + matched, 'i');
        if (nearPattern.test(claimLower)) {
          // Only add ONE other entity (the most likely second entity from query)
          const otherEntity = crossRef.entities.find(e => !matchedEntities.includes(e));
          if (otherEntity) matchedEntities.push(otherEntity);
          break;
        }
      }
    }

    if (matchedEntities.length >= 2) {
      // Shared fact: mentions multiple entities
      let relevanceScore = fact.score;
      // Bonus for mentioning more entities
      relevanceScore += matchedEntities.length * 0.2;
      // Bonus for matching target attribute keywords
      if (crossRef.targetAttribute) {
        const targetWords = crossRef.targetAttribute.split(' ');
        const hits = targetWords.filter(w => claimLower.includes(w)).length;
        relevanceScore += (hits / Math.max(targetWords.length, 1)) * 0.3;
      }

      sharedFacts.push({ fact, matchedEntities, relevanceScore });
    } else if (matchedEntities.length === 1) {
      const entity = matchedEntities[0]!;
      entitySpecificFacts.get(entity)?.push(fact);
    }
  }

  // Sort shared facts by relevance
  sharedFacts.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return { sharedFacts, entitySpecificFacts };
}

// ---------------------------------------------------------------------------
// Cross-Reference Specialist
// ---------------------------------------------------------------------------

export const crossReferenceSpecialist = {
  name: 'cross-ref',

  shouldRun(ops: RequiredOperations): boolean {
    // Runs when we need to enumerate or extract facts AND query has multiple entities
    // The pipeline calls shouldRun first, then process checks for multi-entity
    return ops.enumerateSet || ops.extractFact;
  },

  process(facts: NormalizedFact[], query: string, _queryType: QueryType): SpecialistOutput {
    const crossRef = detectCrossRef(query);

    // If not a cross-reference query, skip
    if (!crossRef) {
      return {
        source: 'cross-ref', // type workaround
        derivedEvidence: '',
        factsUsed: [],
        processingMs: 0,
      };
    }

    const result = findCrossReferences(facts, crossRef);

    if (result.sharedFacts.length === 0 && [...result.entitySpecificFacts.values()].every(f => f.length === 0)) {
      return {
        source: 'cross-ref',
        derivedEvidence: `[CROSS-REFERENCE] No connecting facts found between ${crossRef.entities.join(' and ')}.`,
        factsUsed: [],
        processingMs: 0,
      };
    }

    const lines: string[] = [];
    const allFactIds: string[] = [];

    lines.push(`CROSS-REFERENCE: ${crossRef.entities.join(' + ')}`);
    lines.push(`TARGET: ${crossRef.targetAttribute || 'shared attributes'}`);
    lines.push('');

    // Shared facts (mention multiple entities)
    if (result.sharedFacts.length > 0) {
      lines.push(`SHARED/CONNECTING FACTS (${result.sharedFacts.length}):`);
      for (let i = 0; i < Math.min(result.sharedFacts.length, 15); i++) {
        const sf = result.sharedFacts[i]!;
        const dateStr = sf.fact.time ? ` (${sf.fact.time})` : '';
        lines.push(`  ${i + 1}. [${sf.matchedEntities.join('+')}] ${sf.fact.sourceText.substring(0, 150)}${dateStr} [${sf.fact.memoryId}]`);
        allFactIds.push(sf.fact.memoryId);
      }
      lines.push('');
    }

    // Per-entity facts (for context)
    for (const [entity, entityFacts] of result.entitySpecificFacts) {
      if (entityFacts.length === 0) continue;
      const topFacts = entityFacts.slice(0, 5);
      lines.push(`${entity.toUpperCase()}-ONLY FACTS (${entityFacts.length} total, top ${topFacts.length}):`);
      for (const f of topFacts) {
        lines.push(`  - ${f.sourceText.substring(0, 120)} [${f.memoryId}]`);
        allFactIds.push(f.memoryId);
      }
      lines.push('');
    }

    // Extract common items from shared facts
    if (result.sharedFacts.length > 0) {
      const commonItems = new Set<string>();
      for (const sf of result.sharedFacts) {
        // Use the object from the fact (extracted by IR)
        if (sf.fact.object && sf.fact.object.length < 100) {
          commonItems.add(sf.fact.object);
        }
      }
      if (commonItems.size > 0) {
        lines.push(`COMMON ITEMS (${commonItems.size}): ${[...commonItems].join(', ')}`);
      }
    }

    return {
      source: 'cross-ref', // uses same output channel
      derivedEvidence: lines.join('\n'),
      factsUsed: [...new Set(allFactIds)],
      processingMs: 0,
    };
  },
};
