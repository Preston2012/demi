/**
 * Per-query memory budgets.
 *
 * Product feature: reduces context drowning by giving each query type
 * only the memories it needs. S24 data: wrong answers avg 48.8 memories.
 * Single-hop needs 15, not 65.
 *
 * Flag: QUERY_BUDGET_ENABLED (default: false, opt-in)
 * S25: Data-driven budgets from S24 error analysis.
 */

import type { QueryType } from './query-classifier.js';

/**
 * Data-driven memory budgets per query type.
 *
 * Rationale (S24 error analysis, 114 wrong answers, 100% had memories injected):
 *   - Single-hop: one fact needed. More = noise.
 *   - Open-domain: same as single-hop, supplement with general knowledge.
 *   - Current-state: need recent + historical for comparison.
 *   - Temporal: need enough dates to build timeline, not everything.
 *   - Multi-hop: need cross-subject facts, but 100 was drowning.
 *   - Narrative: story arc needs breadth, not exhaustion.
 *   - Synthesis: chronological overview, curated not dumped.
 *   - Coverage: exhaustive by nature, keep highest.
 */
const QUERY_BUDGETS: Record<QueryType, number> = {
  'single-hop': 15,
  'open-domain': 15,
  'current-state': 20,
  temporal: 30,
  'multi-hop': 35,
  'temporal-multi-hop': 35,
  narrative: 40,
  synthesis: 45,
  summarization: 45,
  coverage: 50,
};

/**
 * Get memory budget for a query type.
 * Returns the per-type budget, capped at globalMax.
 */
export function getQueryBudget(queryType: QueryType, globalMax: number): number {
  const budget = QUERY_BUDGETS[queryType] ?? globalMax;
  return Math.min(budget, globalMax);
}

/**
 * Check if per-query budgets are enabled.
 */
export function isQueryBudgetEnabled(): boolean {
  return process.env.QUERY_BUDGET_ENABLED === 'true';
}
