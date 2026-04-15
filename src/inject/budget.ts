import type { FinalScoredCandidate } from '../retrieval/scorer.js';
import { createLogger } from '../config.js';

const log = createLogger('budget');

/**
 * Memory budget compiler: allocate injection slots by category.
 *
 * Given N total slots, distribute across memory types to ensure
 * diversity. Prevents one hot subject from consuming all slots.
 *
 * Strategy: proportional allocation with minimum 1 per category present,
 * then fill remaining slots by score.
 *
 * Risk per Preston: bad compiler buries critical memory. Log all decisions.
 */

export interface BudgetAllocation {
  candidates: FinalScoredCandidate[];
  allocation: Record<string, number>;
  dropped: { id: string; reason: string }[];
}

/**
 * Family-aware: enforce one slot per canonical family.
 */
function deduplicateFamilies(candidates: FinalScoredCandidate[]): FinalScoredCandidate[] {
  const seen = new Set<string>();
  const result: FinalScoredCandidate[] = [];
  for (const c of candidates) {
    const famId = c.candidate.record.canonicalFactId;
    if (famId) {
      if (seen.has(famId)) continue;
      seen.add(famId);
    }
    result.push(c);
  }
  return result;
}

export function compileBudget(
  inputCandidates: FinalScoredCandidate[],
  totalSlots: number,
  minPerCategory: number = 1,
  maxPerCategory: number = Math.max(1, parseInt(process.env.BUDGET_MAX_PER_CATEGORY ?? '5', 10) || 5),
): BudgetAllocation {
  const candidates = deduplicateFamilies(inputCandidates);

  // Q6: Guard against zero/negative slots
  if (totalSlots <= 0) {
    return {
      candidates: [],
      allocation: {},
      dropped: candidates.map((c) => ({ id: c.id, reason: 'budget: zero slots' })),
    };
  }

  if (candidates.length <= totalSlots) {
    // Everything fits. No budgeting needed.
    const allocation: Record<string, number> = {};
    for (const c of candidates) {
      const cat = categorize(c);
      allocation[cat] = (allocation[cat] ?? 0) + 1;
    }
    return { candidates, allocation, dropped: [] };
  }

  // Group by category
  const groups = new Map<string, FinalScoredCandidate[]>();
  for (const c of candidates) {
    const cat = categorize(c);
    const group = groups.get(cat) ?? [];
    group.push(c);
    groups.set(cat, group);
  }

  // Phase 1: guarantee minimum per category
  // Q6: Sort groups by total score descending for deterministic allocation.
  const selected: FinalScoredCandidate[] = [];
  const allocation: Record<string, number> = {};
  let remaining = totalSlots;

  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const scoreA = a[1].reduce((sum, c) => sum + c.finalScore, 0);
    const scoreB = b[1].reduce((sum, c) => sum + c.finalScore, 0);
    return scoreB - scoreA;
  });

  for (const [cat, group] of sortedGroups) {
    // Sort within category by score
    group.sort((a, b) => b.finalScore - a.finalScore);

    const take = Math.min(minPerCategory, group.length, remaining);
    for (let i = 0; i < take; i++) {
      selected.push(group[i]!);
    }
    allocation[cat] = take;
    remaining -= take;
  }

  if (remaining <= 0) {
    // Log what was dropped
    const selectedIds = new Set(selected.map((c) => c.id));
    const dropped = candidates
      .filter((c) => !selectedIds.has(c.id))
      .map((c) => ({ id: c.id, reason: `budget: ${categorize(c)} at max` }));

    // STR-3: Sort output by score
    selected.sort((a, b) => b.finalScore - a.finalScore);
    log.debug({ allocation, droppedCount: dropped.length }, 'Budget compiled (min-fill only)');
    return { candidates: selected, allocation, dropped };
  }

  // Phase 2: fill remaining slots by global score
  const selectedIds = new Set(selected.map((c) => c.id));
  const overflow = candidates.filter((c) => !selectedIds.has(c.id)).sort((a, b) => b.finalScore - a.finalScore);

  for (const c of overflow) {
    if (remaining <= 0) break;
    const cat = categorize(c);
    if ((allocation[cat] ?? 0) >= maxPerCategory) continue;

    selected.push(c);
    allocation[cat] = (allocation[cat] ?? 0) + 1;
    selectedIds.add(c.id);
    remaining--;
  }

  const dropped = candidates
    .filter((c) => !selectedIds.has(c.id))
    .map((c) => ({ id: c.id, reason: `budget: overflow, score ${c.finalScore.toFixed(3)}` }));

  // STR-3: Sort output by score so injection order matches relevance
  selected.sort((a, b) => b.finalScore - a.finalScore);
  log.debug({ allocation, droppedCount: dropped.length, totalSelected: selected.length }, 'Budget compiled');
  return { candidates: selected, allocation, dropped };
}

/**
 * Categorize a candidate for budget allocation.
 * Uses subject as primary category. Hub memories get their own bucket.
 */
function categorize(c: FinalScoredCandidate): string {
  const subject = c.candidate.record.subject;
  if (subject.startsWith('hub:')) return 'hub';
  if (c.candidate.record.memoryType === 'procedural') return 'procedural';
  // T2: Normalize to lowercase to prevent case-variant duplicate buckets
  return subject.toLowerCase();
}
