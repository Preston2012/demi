/**
 * Per-cell provider chains.
 *
 * Lock: docs/internal/LOCK_ROUTING_CHAINS_PACKET.md (S77, verified provider
 * sweep: LOCOMO + BEAM + FRAME + calib + DialSim, brain #3063/#3064/#3065/#3068).
 *
 * A "cell" is a (task, query-shape) routing target. Each carries an ordered
 * chain that lists exactly one model per provider (OpenAI, xAI, DeepSeek,
 * Google, Anthropic, Mistral) for full provider failover, so a single-vendor
 * client still resolves to one of its models after availability filtering.
 *
 * Doctrine (locked):
 *   - Every cell carries one model per provider (6-deep). Ordered quality-first
 *     with cost breaking ties (nano $0.10/$0.40 < deepseek $0.14/$0.28 <
 *     grok-fast $0.20/$0.50 < mini $0.40/$1.60 < gpt-4.1 $2/$8 < sonnet $3/$15).
 *   - Claude is never at index 0 (cost) EXCEPT heavy-coding, where Opus leads
 *     by design (best coder, no cheaper substitute for hard code).
 *   - The four answer cells (single-hop / temporal / reasoning / synthesis) are
 *     routed by queryType in query-router.ts.
 *   - Telemetry per-cell keeps re-ordering chains over time; this is the locked
 *     initial order from the verified sweep.
 */

import { filterChain } from './provider-availability.js';

export type Cell =
  | 'extraction'
  | 'conversational-answer'
  | 'temporal-answer'
  | 'synthesis-answer'
  | 'adjudicator'
  | 'injection-l3'
  | 'light-coding'
  | 'heavy-coding';

/**
 * Locked initial order from the S77 verified provider sweep (#3068). Per-cell
 * citations below. Telemetry re-orders from here; bench model-pins override the
 * chain entirely (single model, no failover) so the unrouted sweep stays valid.
 */
export const CELL_CHAINS: Record<Cell, readonly string[]> = {
  // nano wins overall 55.1 + single-hop 51.8
  extraction: [
    'gpt-4.1-nano',
    'grok-4-1-fast-non-reasoning',
    'deepseek-chat',
    'claude-haiku-4-5-20251001',
    'gemini-2.5-flash',
    'mistral-small-latest',
  ],
  // Classifier-collapse (S77): the merged conversational answer cell. mini wins
  // LOCOMO overall 53.0; single-hop and multi-hop are indistinguishable at the
  // question and both best-served by mini, so merging single-hop-answer +
  // reasoning-answer removes the misrouting cost. The bench host A/Bs
  // mini-vs-grok-nr via CELL_CHAIN_CONVERSATIONAL_ANSWER, no code change.
  'conversational-answer': [
    'gpt-4.1-mini',
    'grok-4-1-fast-non-reasoning',
    'deepseek-chat',
    'mistral-small-latest',
    'gemini-2.5-flash',
    'claude-haiku-4-5-20251001',
  ],
  // grok-nr = mistral 70.0; deepseek at 4 = #1626 BEAM-temporal hedge, CONFLICT noted
  'temporal-answer': [
    'grok-4-1-fast-non-reasoning',
    'mistral-small-latest',
    'gpt-4.1-mini',
    'deepseek-chat',
    'claude-haiku-4-5-20251001',
    'gemini-2.5-flash',
  ],
  // grok-r wins BEAM 48.2; sonnet OFF the chain (ties grok-r at 15x cost), haiku as the Anthropic slot
  'synthesis-answer': [
    'grok-4-1-fast-reasoning',
    'gpt-4.1-mini',
    'deepseek-chat',
    'claude-haiku-4-5-20251001',
    'gemini-2.5-flash',
    'mistral-small-latest',
  ],
  // deepseek hard-neg 94.7; mistral best Brier
  adjudicator: [
    'deepseek-chat',
    'mistral-small-latest',
    'grok-4-1-fast-non-reasoning',
    'gpt-4.1-mini',
    'gemini-2.5-flash',
    'claude-haiku-4-5-20251001',
  ],
  // all six tied 100% catch-rate, pure cost order
  'injection-l3': [
    'deepseek-chat',
    'mistral-small-latest',
    'grok-4-1-fast-non-reasoning',
    'gemini-2.5-flash',
    'gpt-4.1-mini',
    'claude-haiku-4-5-20251001',
  ],
  // no bench, telemetry-seeded; gpt-4.1 standard ($2/$8) is the non-Opus coding pin
  'light-coding': [
    'gpt-4.1',
    'grok-4-1-fast-reasoning',
    'claude-sonnet-4-6',
    'deepseek-chat',
    'gemini-2.5-flash',
    'mistral-small-latest',
  ],
  // no bench, telemetry-seeded; Opus leads by design (best coder), the one
  // intentional Claude-at-index-0 cell.
  'heavy-coding': [
    'claude-opus-4-8',
    'gpt-4.1',
    'grok-4-1-fast-reasoning',
    'deepseek-chat',
    'gemini-2.5-flash',
    'mistral-small-latest',
  ],
};

/** Build the `CELL_CHAIN_<CELL>` env-override key for a cell. */
function envKeyForCell(cell: Cell): string {
  return `CELL_CHAIN_${cell.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Resolve a cell to a runnable chain: availability-filtered, never empty
 * (as long as one provider key exists). A `CELL_CHAIN_<CELL>` env var
 * (comma-separated model list) overrides the seed chain for that cell, and
 * is still availability-filtered. Evaluated at call time so env overrides
 * and configured keys are always fresh.
 */
export function chainForCell(cell: Cell): string[] {
  const raw = process.env[envKeyForCell(cell)];
  const base = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : CELL_CHAINS[cell];
  return filterChain(base);
}
