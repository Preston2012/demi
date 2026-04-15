/**
 * Answer model router.
 *
 * Routes query types to optimal answer models based on S15 empirical findings:
 *   - Simple queries (single-hop, open-domain, current-state, coverage) -> gpt-4.1-mini
 *     Wins LOCOMO (44.3%) and BEAM (56.2%). Fast, cheap, concise.
 *   - Complex queries (multi-hop, temporal, synthesis, narrative) -> Grok reasoning+concise
 *     Wins LME (72.0%). Reasoning crushes multi-step inference.
 *
 * Principle: "Reasoning thinks. Non-reasoning talks."
 *
 * Feature flag: ANSWER_ROUTING (default: false, opt-in)
 * Override: ANSWER_MODEL_SIMPLE, ANSWER_MODEL_COMPLEX (env vars)
 */

import type { QueryType } from '../retrieval/query-classifier.js';

export interface RoutedModel {
  model: string;
  promptSuffix: string;
  tier: 'simple' | 'complex';
}

const SIMPLE_TYPES: Set<QueryType> = new Set([
  'single-hop',
  'open-domain',
  'current-state',
  'coverage',
  'summarization',
]);

const COMPLEX_TYPES: Set<QueryType> = new Set([
  'multi-hop',
  'temporal-multi-hop',
  'temporal',
  'synthesis',
  'narrative',
]);

/**
 * Per-type output guidance for complex queries.
 * R24 council (quad unanimous): single CONCISE_SUFFIX killed temporal/synthesis/narrative.
 * Multi-hop: factual cross-reference, keep brief.
 * Temporal: needs dates and ordering, not sentence-capped.
 * Narrative/synthesis: needs structured output.
 */
const COMPLEX_SUFFIX: Partial<Record<QueryType, string>> = {
  'multi-hop': 'Be concise. Answer in 1-2 sentences. Do not explain your reasoning.',
  temporal: 'State only your final answer with specific dates. Do not show intermediate reasoning steps.',
  'temporal-multi-hop':
    'State only your final answer with specific dates for each entity. Do not show intermediate reasoning steps.',
  synthesis: 'Provide a coherent overview. Do not explain your reasoning process.',
  narrative: 'Tell the story concisely with specific details. Do not explain your reasoning process.',
};

/**
 * Route a query type to the optimal answer model.
 * Returns null if ANSWER_ROUTING is disabled (caller uses default model).
 */
export function routeAnswerModel(queryType: QueryType): RoutedModel | null {
  if (process.env.ANSWER_ROUTING !== 'true') return null;

  const simpleModel = process.env.ANSWER_MODEL_SIMPLE || 'gpt-4.1-mini';
  const complexModel = process.env.ANSWER_MODEL_COMPLEX || 'grok-4-1-fast-reasoning';

  if (SIMPLE_TYPES.has(queryType)) {
    return { model: simpleModel, promptSuffix: '', tier: 'simple' };
  }

  if (COMPLEX_TYPES.has(queryType)) {
    return {
      model: complexModel,
      promptSuffix: COMPLEX_SUFFIX[queryType] || 'Be concise. Do not explain your reasoning.',
      tier: 'complex',
    };
  }

  // Fallback: treat unknown types as simple
  return { model: simpleModel, promptSuffix: '', tier: 'simple' };
}

/**
 * Get routing stats for logging/debugging.
 */
export function getRoutingConfig(): {
  enabled: boolean;
  simpleModel: string;
  complexModel: string;
  simpleTypes: string[];
  complexTypes: string[];
} {
  return {
    enabled: process.env.ANSWER_ROUTING === 'true',
    simpleModel: process.env.ANSWER_MODEL_SIMPLE || 'gpt-4.1-mini',
    complexModel: process.env.ANSWER_MODEL_COMPLEX || 'grok-4-1-fast-reasoning',
    simpleTypes: Array.from(SIMPLE_TYPES),
    complexTypes: Array.from(COMPLEX_TYPES),
  };
}
