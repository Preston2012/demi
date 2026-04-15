/**
 * Recency resolver specialist.
 *
 * Targets: BEAM contradiction_resolution (4.5 pts), knowledge_update (3.8 pts).
 *
 * S27 Council R17 fixes:
 *   - #10: Classify predicates as stateful vs additive. Only run state chains on stateful.
 *   - #3 (R17): Negated facts WITH supersession markers DO close prior state.
 *   - #13: MUTATE facts array certainty so downstream specialists see superseded status.
 *
 * Stateful predicates: location, employer, relationship, role, favorite_* (one current value)
 * Additive predicates: interest, visited, acquired, owns, education, has_count (accumulate)
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Predicate Classification
// ---------------------------------------------------------------------------

/**
 * Stateful predicates: only one value is current at a time.
 * "Lives in NYC" then "Lives in Portland" = Portland supersedes NYC.
 */
const STATEFUL_PREDICATES = new Set([
  'location', 'employer', 'relationship', 'role',
]);

/** Check if a predicate is stateful (including favorite_* pattern). */
function isStatefulPredicate(predicate: string): boolean {
  if (STATEFUL_PREDICATES.has(predicate)) return true;
  if (predicate.startsWith('favorite_')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// State Resolution
// ---------------------------------------------------------------------------

interface StateChain {
  subject: string;
  predicate: string;
  history: Array<{
    fact: NormalizedFact;
    status: 'current' | 'superseded';
  }>;
  currentValue: string;
  currentMemoryId: string;
}

function buildStateChains(facts: NormalizedFact[]): StateChain[] {
  // Group by (subject_lower, predicate) - ONLY stateful predicates
  const groups = new Map<string, NormalizedFact[]>();

  for (const fact of facts) {
    if (fact.certainty === 'hypothetical' || fact.certainty === 'conditional') continue;
    if (!isStatefulPredicate(fact.predicate)) continue;

    const key = `${fact.subject.toLowerCase()}::${fact.predicate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fact);
  }

  const chains: StateChain[] = [];

  for (const [, groupFacts] of groups) {
    if (groupFacts.length < 2) continue;

    // Sort by time (most recent last)
    const sorted = [...groupFacts].sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return 0;
    });

    // Resolution rules:
    // 1. Most recent fact wins (by time)
    // 2. Negated + superseded ("no longer lives in") CLOSES the prior state
    //    (Council R17 #3 fix: negated supersession IS a valid terminal state)
    // 3. If the latest is negated+superseded, current = "none" (state was closed)
    // 4. If latest is asserted, that's the current value
    const latest = sorted[sorted.length - 1]!;

    let currentFact: NormalizedFact;
    if (latest.certainty === 'superseded' || (latest.negated && latest.certainty === 'negated')) {
      // The state was explicitly closed. Latest negation/supersession wins.
      currentFact = latest;
    } else {
      // Most recent asserted fact wins
      const asserted = sorted.filter(f => f.certainty === 'asserted' && !f.negated);
      currentFact = asserted.length > 0 ? asserted[asserted.length - 1]! : latest;
    }

    const history = sorted.map(f => ({
      fact: f,
      status: f.memoryId === currentFact.memoryId ? 'current' as const : 'superseded' as const,
    }));

    // S27 fix #13: MUTATE facts array so downstream specialists see superseded status
    for (const entry of history) {
      if (entry.status === 'superseded' && entry.fact.certainty === 'asserted') {
        entry.fact.certainty = 'superseded';
      }
    }

    chains.push({
      subject: currentFact.subject,
      predicate: currentFact.predicate,
      history,
      currentValue: currentFact.object,
      currentMemoryId: currentFact.memoryId,
    });
  }

  return chains;
}

// ---------------------------------------------------------------------------
// Recency Resolver Specialist
// ---------------------------------------------------------------------------

export const recencyResolverSpecialist = {
  name: 'recency',

  shouldRun(ops: RequiredOperations): boolean {
    return ops.resolveLatestState;
  },

  process(facts: NormalizedFact[], _query: string, _queryType: QueryType): SpecialistOutput {
    const chains = buildStateChains(facts);

    if (chains.length === 0) {
      return {
        source: 'recency',
        derivedEvidence: '[RECENCY] No stateful conflicts detected.',
        factsUsed: [],
        processingMs: 0,
      };
    }

    const lines: string[] = [];
    const allFactIds: string[] = [];

    lines.push(`STATE RESOLUTION (${chains.length} stateful attributes with updates):`);
    lines.push('');

    for (const chain of chains) {
      lines.push(`  ${chain.subject} / ${chain.predicate}:`);

      for (const entry of chain.history) {
        const timeStr = entry.fact.time ? ` (${entry.fact.time})` : '';
        const statusTag = entry.status === 'current' ? '[CURRENT]' : '[SUPERSEDED]';
        const negStr = entry.fact.negated ? ' [NEGATED]' : '';
        lines.push(
          `    ${statusTag} ${entry.fact.object}${timeStr}${negStr} [${entry.fact.memoryId}]`
        );
        allFactIds.push(entry.fact.memoryId);
      }

      lines.push(`    -> CURRENT VALUE: ${chain.currentValue} [${chain.currentMemoryId}]`);
      lines.push('');
    }

    return {
      source: 'recency',
      derivedEvidence: lines.join('\n'),
      factsUsed: [...new Set(allFactIds)],
      processingMs: 0,
    };
  },
};
