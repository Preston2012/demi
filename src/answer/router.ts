/**
 * Answer model router: one routing source of truth.
 *
 * Lock: docs/internal/LOCK_ROUTING_CHAINS_PACKET.md (S77).
 *
 * The model is derived from the cell chain so the router and the answer path
 * cannot disagree: routeAnswerModel(qt, query) = chainForCell(routeToCell(qt,
 * query))[0]. Per-type output guidance (COMPLEX_SUFFIX) is preserved.
 *
 * Routing is default-OFF as of S77 (retired: net-negative on weighted benches;
 * see ROUTING_OFF_DEPLOY_NOTE_S77.md). Enable explicitly with ANSWER_ROUTING=true
 * (a routed bench passes --routed). When off, routeAnswerModel returns null and
 * the caller uses its default model. The chains are authoritative for model
 * selection;
 * ANSWER_MODEL_SIMPLE / ANSWER_MODEL_COMPLEX / TEMPORAL_SPECIALIST_MODEL are
 * retired as the model source (a bench pins a single model via --answer-model
 * / opts.model, which bypasses routing entirely).
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import { recordDecision } from '../telemetry/index.js';
import { routeToCell } from './query-router.js';
import { chainForCell, type Cell } from '../llm/cells.js';

export interface RoutedModel {
  model: string;
  promptSuffix: string;
  tier: 'simple' | 'complex';
}

/**
 * Per-type output guidance. R24 council (quad unanimous): a single CONCISE
 * suffix killed temporal/synthesis/narrative, so guidance is per queryType.
 * Track C/lock: the router changes the model, never the suffix.
 */
const COMPLEX_SUFFIX: Partial<Record<QueryType, string>> = {
  'multi-hop': 'Be concise. Answer in 1-2 sentences. Do not explain your reasoning.',
  temporal: 'State only your final answer with specific dates. Do not show intermediate reasoning steps.',
  'temporal-multi-hop':
    'State only your final answer with specific dates for each entity. Do not show intermediate reasoning steps.',
  synthesis: 'Provide a coherent overview. Do not explain your reasoning process.',
  narrative: 'Tell the story concisely with specific details. Do not explain your reasoning process.',
};

/** conversational-answer is the "simple" tier; the other answer cells are "complex". */
function tierForCell(cell: Cell): 'simple' | 'complex' {
  return cell === 'conversational-answer' ? 'simple' : 'complex';
}

/**
 * Per-queryType output guidance suffix (empty for the simple/single-hop types).
 * The answer path applies this when routing is on; the model comes from the
 * cell chain, the suffix stays keyed off queryType (the router changes the
 * model, never the suffix).
 */
export function promptSuffixForQueryType(queryType: QueryType): string {
  return COMPLEX_SUFFIX[queryType] ?? '';
}

/**
 * Resolve the answer model for a query. Returns null when routing is off
 * (default; enabled only by ANSWER_ROUTING=true) or no provider is configured,
 * in which case the caller falls back to its default model.
 */
export function routeAnswerModel(queryType: QueryType, query: string = ''): RoutedModel | null {
  // Default-OFF (S77): routing retired as the default. Only explicit ANSWER_ROUTING=true enables it.
  if (process.env.ANSWER_ROUTING !== 'true') return null;

  const cell = routeToCell(queryType, query);
  const model = chainForCell(cell)[0];
  if (!model) return null; // no provider key configured; caller uses its default

  const tier = tierForCell(cell);
  const result: RoutedModel = { model, promptSuffix: COMPLEX_SUFFIX[queryType] ?? '', tier };

  recordDecision({
    decision_type: 'router_answer_model',
    branch_taken: model,
    inputs: { query_type: queryType, cell, tier },
  });
  return result;
}

/** Routing stats for logging/debugging. */
export function getRoutingConfig(): { enabled: boolean } {
  return { enabled: process.env.ANSWER_ROUTING === 'true' };
}
