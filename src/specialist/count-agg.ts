import { extractEntities } from './ir.js';
/**
 * Count aggregator specialist.
 *
 * Targets: LME multi-session count errors (10 pts), LOCOMO quantity errors.
 * Models pick one memory's count instead of aggregating across all.
 *
 * Council R16:
 *   - GPT: build on top of list enumeration (COUNT(DISTINCT normalized_item_id))
 *   - GPT: split triggers: cardinal count, scalar amount, duration, frequency
 *   - Grok: count aggregator is needed, no major missed failure modes
 *
 * Approach: detect "how many" queries, enumerate distinct items matching
 * the subject, deduplicate, and inject explicit count with provenance.
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Count Type Detection
// ---------------------------------------------------------------------------

type CountType = 'cardinal' | 'scalar' | 'duration' | 'frequency';

function detectCountType(query: string): CountType {
  const q = query.toLowerCase();
  if (/\b(how long|duration|time spent|hours|minutes)\b/.test(q)) return 'duration';
  if (/\b(how often|frequency|times per|per week|per month)\b/.test(q)) return 'frequency';
  if (/\b(how much|amount|cost|price|budget|salary|weight)\b/.test(q)) return 'scalar';
  return 'cardinal'; // default: "how many"
}

// ---------------------------------------------------------------------------
// Number Extraction
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};

function extractNumber(text: string): number | null {
  // Try digit match
  const digitMatch = text.match(/\b(\d+)\b/);
  if (digitMatch) return parseInt(digitMatch[1]!, 10);

  // Try word match
  const lower = text.toLowerCase();
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    if (lower.includes(word)) return num;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Count Aggregator Specialist
// ---------------------------------------------------------------------------

export const countAggregatorSpecialist = {
  name: 'count-agg',

  shouldRun(ops: RequiredOperations): boolean {
    return ops.aggregateCount;
  },

  process(facts: NormalizedFact[], query: string, _queryType: QueryType): SpecialistOutput {
    const countType = detectCountType(query);
    const queryLower = query.toLowerCase();

    // Extract subject from query
    const names = extractEntities(query);
    const subjectFilter = names.length > 0 ? names : [];

    // For cardinal counts: find distinct items
    if (countType === 'cardinal') {
      // Find what we're counting by extracting the noun after "how many"
      // S27 fix #11: extract 1-3 words after 'how many' for compound nouns
      const countTargetMatch = queryLower.match(/how many\s+(\w+(?:\s+\w+){0,2})/);
      const countTarget = countTargetMatch?.[1] || '';

      // Collect distinct items from facts
      const distinctItems = new Map<string, { value: string; memoryId: string; time: string | null }>();

      for (const fact of facts) {
        // Subject filter
        if (subjectFilter.length > 0) {
          const matches = subjectFilter.some(
            s => fact.subject.toLowerCase().includes(s.toLowerCase())
          );
          if (!matches) continue;
        }

        // Skip negated
        if (fact.negated) continue;
        if (fact.certainty === 'superseded') continue;

        // Check if this fact relates to the count target
        const claimLower = fact.sourceText.toLowerCase();
        const objectLower = fact.object.toLowerCase();

        // Relevance check: does the claim mention the count target?
        if (countTarget && !claimLower.includes(countTarget) && !objectLower.includes(countTarget)) {
          // Also check predicate
          if (!fact.predicate.toLowerCase().includes(countTarget)) continue;
        }

        // Extract the countable item
        let item = fact.object;
        if (item.length > 60) {
          const short = item.match(/^([^,.;]+)/);
          if (short) item = short[1]!.trim();
        }

        const normalized = item.toLowerCase().replace(/^(a|an|the)\s+/, '').trim();
        if (normalized.length < 2) continue;

        if (!distinctItems.has(normalized)) {
          distinctItems.set(normalized, {
            value: item,
            memoryId: fact.memoryId,
            time: fact.time,
          });
        }
      }

      // Also check for explicit counts in memories ("has 3 dogs", "owns two cars")
      let explicitCount: { value: number; memoryId: string; text: string; time: string | null } | null = null;
      for (const fact of facts) {
        if (fact.predicate === 'has_count' || /\b(has|have|had|owns?|own)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(fact.sourceText)) {
          const num = extractNumber(fact.object) || extractNumber(fact.sourceText);
          if (num !== null) {
            // Use the most recent explicit count
            if (!explicitCount || (fact.time && (!explicitCount.time || fact.time > explicitCount.time))) {
              explicitCount = { value: num, memoryId: fact.memoryId, text: fact.sourceText, time: fact.time };
            }
          }
        }
      }

      const lines: string[] = [];
      const subjectStr = subjectFilter.join(' & ') || 'subject';

      if (distinctItems.size > 0) {
        lines.push(`COUNT ANALYSIS for "${countTarget || 'items'}" (${subjectStr}):`);
        lines.push(`  Distinct items found: ${distinctItems.size}`);
        lines.push('');

        let i = 1;
        for (const [, item] of distinctItems) {
          const dateStr = item.time ? ` (${item.time})` : '';
          lines.push(`  ${i}. ${item.value}${dateStr} [${item.memoryId}]`);
          i++;
        }

        if (explicitCount) {
          lines.push('');
          lines.push(`  EXPLICIT COUNT in memory: ${explicitCount.value} [${explicitCount.memoryId}]`);
          if (explicitCount.value !== distinctItems.size) {
            lines.push(`  NOTE: Explicit count (${explicitCount.value}) differs from enumerated items (${distinctItems.size}). Use the most recent explicit count if available.`);
          }
        }

        lines.push('');
        lines.push(`ANSWER: ${explicitCount ? explicitCount.value : distinctItems.size}`);
      } else if (explicitCount) {
        lines.push(`COUNT for "${countTarget || 'items'}" (${subjectStr}):`);
        lines.push(`  Explicit count: ${explicitCount.value} [${explicitCount.memoryId}]`);
        lines.push(`  Source: ${explicitCount.text.substring(0, 100)}`);
        lines.push('');
        lines.push(`ANSWER: ${explicitCount.value}`);
      } else {
        lines.push(`COUNT: No countable ${countTarget || 'items'} found for ${subjectStr}.`);
      }

      return {
        source: 'count-agg',
        derivedEvidence: lines.join('\n'),
        factsUsed: [...distinctItems.values()].map(i => i.memoryId),
        processingMs: 0,
      };
    }

    // For scalar/duration/frequency: find the most relevant value
    const lines: string[] = [];
    lines.push(`COUNT TYPE: ${countType}`);

    const relevantFacts = facts
      .filter(f => !f.negated && f.certainty !== 'superseded')
      .filter(f => {
        if (subjectFilter.length === 0) return true;
        return subjectFilter.some(s => f.subject.toLowerCase().includes(s.toLowerCase()));
      });

    // Find facts with numbers
    const withNumbers = relevantFacts
      .map(f => ({ fact: f, number: extractNumber(f.sourceText) }))
      .filter(f => f.number !== null);

    if (withNumbers.length > 0) {
      // Sort by recency (latest first)
      withNumbers.sort((a, b) => {
        if (a.fact.time && b.fact.time) return b.fact.time.localeCompare(a.fact.time);
        return 0;
      });

      lines.push(`Values found (${withNumbers.length}):`);
      for (const { fact, number } of withNumbers.slice(0, 5)) {
        const dateStr = fact.time ? ` (${fact.time})` : '';
        lines.push(`  ${number}${dateStr} [${fact.memoryId}]: ${fact.sourceText.substring(0, 80)}`);
      }
      lines.push('');
      lines.push(`MOST RECENT VALUE: ${withNumbers[0]!.number}`);
    } else {
      lines.push('No numeric values found matching the query.');
    }

    return {
      source: 'count-agg',
      derivedEvidence: lines.join('\n'),
      factsUsed: withNumbers.map(w => w.fact.memoryId),
      processingMs: 0,
    };
  },
};
