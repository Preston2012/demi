import { extractEntities } from './ir.js';
/**
 * List enumerator specialist.
 *
 * Targets: LOCOMO multi-hop (11.8 pts). 43% of failures are incomplete lists.
 * Model gets 3 of 6 items because it stops scanning after first few matches.
 *
 * Council R16:
 *   - Gemini: derive enumeration key from question (activity, person, location)
 *   - GPT: enumerate by (normalized_item, relation_type, subject)
 *   - Grok: semantic dedup only as tie-breaker, exact match primary
 *
 * Approach: identify what's being listed, scan ALL facts for matches,
 * deduplicate by exact string, present complete numbered list.
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Enumeration Key Detection
// ---------------------------------------------------------------------------

interface EnumKey {
  category: string;         // what we're listing: "activities", "places", "people"
  subjectFilter: string[];  // who we're listing for
  predicateHints: string[]; // predicates that match this list type
}

const LIST_CATEGORIES: Array<{
  pattern: RegExp;
  category: string;
  predicateHints: string[];
}> = [
  {
    pattern: /\b(activit|hobby|hobbies|pastime|leisure|recreation|sport|exercise)\b/i,
    category: 'activities',
    predicateHints: ['interest', 'activity', 'hobby', 'enjoys', 'plays', 'does', 'practices', 'pursues'],
  },
  {
    pattern: /\b(place|cit|countr|location|where.*visited|where.*been|where.*traveled)\b/i,
    category: 'places',
    predicateHints: ['visited', 'location', 'lives', 'traveled', 'went', 'been_to'],
  },
  {
    pattern: /\b(friend|people|person|who|colleague|companion)\b/i,
    category: 'people',
    predicateHints: ['friend', 'relationship', 'met', 'knows', 'colleague'],
  },
  {
    pattern: /\b(pet|animal|dog|cat)\b/i,
    category: 'pets',
    predicateHints: ['owns', 'adopted', 'pet', 'has_pet'],
  },
  {
    pattern: /\b(book|movie|show|series|film|song|music)\b/i,
    category: 'media',
    predicateHints: ['watches', 'reads', 'likes', 'favorite', 'interest'],
  },
  {
    pattern: /\b(gift|present|receive|gave|got)\b/i,
    category: 'gifts',
    predicateHints: ['received', 'gave', 'gift', 'acquired'],
  },
  {
    pattern: /\b(food|restaurant|cuisine|cook|dish|meal)\b/i,
    category: 'food',
    predicateHints: ['eats', 'cooks', 'favorite_restaurant', 'food', 'likes'],
  },
];

function detectEnumKey(query: string): EnumKey {
  let category = 'items';
  let predicateHints: string[] = [];

  for (const lc of LIST_CATEGORIES) {
    if (lc.pattern.test(query)) {
      category = lc.category;
      predicateHints = lc.predicateHints;
      break;
    }
  }

  // Extract subject names from query
  const names = extractEntities(query);
  const subjectFilter = names.length > 0 ? names : [];

  return { category, subjectFilter, predicateHints };
}

// ---------------------------------------------------------------------------
// Item Extraction and Dedup
// ---------------------------------------------------------------------------

interface ListItem {
  value: string;            // the enumerated item
  normalizedValue: string;  // lowercased for dedup
  memoryIds: string[];      // provenance
  firstMentioned: string | null; // earliest date
}

function extractListItems(
  facts: NormalizedFact[],
  enumKey: EnumKey,
  _query: string,
): ListItem[] {
  const items = new Map<string, ListItem>(); // key = normalized value

  for (const fact of facts) {
    // Subject filter
    if (enumKey.subjectFilter.length > 0) {
      const matchesSubject = enumKey.subjectFilter.some(
        s => fact.subject.toLowerCase().includes(s.toLowerCase())
      );
      if (!matchesSubject) continue;
    }

    // Skip negated facts for enumeration
    if (fact.negated) continue;
    // Skip superseded
    if (fact.certainty === 'superseded') continue;

    // S27 fix #7: predicate hint filtering (was dead code, now active)
    // If predicateHints defined, prefer facts with matching predicates.
    // Non-matching predicates deprioritized (added to fallback pool only).
    if (enumKey.predicateHints.length > 0) {
      const predicateMatches = enumKey.predicateHints.some(
        hint => fact.predicate.toLowerCase().includes(hint) || hint.includes(fact.predicate.toLowerCase())
      );
      if (!predicateMatches && fact.predicate !== 'states') {
        // Skip non-matching predicates unless it's a generic 'states' fallback
        continue;
      }
    }

    // Extract the item value. Use the object from IR.
    let itemValue = fact.object;

    // If the object is very long, it's probably a sentence, not an item.
    // Try to extract the key noun phrase.
    if (itemValue.length > 80) {
      // Take first meaningful phrase (up to first comma or period)
      const short = itemValue.match(/^([^,.;]+)/);
      if (short) itemValue = short[1]!.trim();
    }

    if (!itemValue || itemValue.length < 2) continue;

    // Normalize for dedup (lowercase, trim, remove articles)
    const normalized = itemValue
      .toLowerCase()
      .replace(/^(a|an|the|some|his|her|their|my)\s+/i, '')
      .trim();

    if (normalized.length < 2) continue;

    // Dedup by exact normalized match
    if (items.has(normalized)) {
      const existing = items.get(normalized)!;
      if (!existing.memoryIds.includes(fact.memoryId)) {
        existing.memoryIds.push(fact.memoryId);
      }
      // Update earliest date
      if (fact.time && (!existing.firstMentioned || fact.time < existing.firstMentioned)) {
        existing.firstMentioned = fact.time;
      }
    } else {
      items.set(normalized, {
        value: itemValue,
        normalizedValue: normalized,
        memoryIds: [fact.memoryId],
        firstMentioned: fact.time,
      });
    }
  }

  // Sort by number of mentions (more corroborated items first), then alphabetically
  return [...items.values()].sort((a, b) => {
    if (b.memoryIds.length !== a.memoryIds.length) return b.memoryIds.length - a.memoryIds.length;
    return a.normalizedValue.localeCompare(b.normalizedValue);
  });
}

// ---------------------------------------------------------------------------
// List Enumerator Specialist
// ---------------------------------------------------------------------------

export const listEnumeratorSpecialist = {
  name: 'list-enum',

  shouldRun(ops: RequiredOperations): boolean {
    return ops.enumerateSet;
  },

  process(facts: NormalizedFact[], query: string, _queryType: QueryType): SpecialistOutput {
    const enumKey = detectEnumKey(query);
    const items = extractListItems(facts, enumKey, query);

    if (items.length === 0) {
      return {
        source: 'list-enum',
        derivedEvidence: `[LIST ENUMERATION] No ${enumKey.category} found for ${enumKey.subjectFilter.join(', ') || 'query'}.`,
        factsUsed: [],
        processingMs: 0,
      };
    }

    const lines: string[] = [];
    const subjectStr = enumKey.subjectFilter.length > 0
      ? enumKey.subjectFilter.join(' & ')
      : 'subject';

    lines.push(`ENUMERATED ${enumKey.category.toUpperCase()} for ${subjectStr}: ${items.length} items found`);
    lines.push('');

    const allMemoryIds: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const sources = item.memoryIds.join(', ');
      const dateStr = item.firstMentioned ? ` (${item.firstMentioned})` : '';
      lines.push(`  ${i + 1}. ${item.value}${dateStr} [${sources}]`);
      allMemoryIds.push(...item.memoryIds);
    }

    lines.push('');
    lines.push(`TOTAL COUNT: ${items.length} distinct ${enumKey.category}`);

    return {
      source: 'list-enum',
      derivedEvidence: lines.join('\n'),
      factsUsed: [...new Set(allMemoryIds)],
      processingMs: 0,
    };
  },
};
