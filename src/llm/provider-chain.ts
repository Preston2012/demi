/**
 * W4 Track A: explicit 5-provider failover chain for the calibrated
 * adjudicator (design §2.2, brain anchor I-285).
 *
 * The existing `callLLM` in `./client.ts` already does provider failover,
 * but its chain is implicit (derived from model-name prefix + one final
 * fallback to `gpt-4.1-mini`) and its per-attempt telemetry shape doesn't
 * surface to the caller. Track A needs:
 *   1. A fixed, declared chain ordered for cost (nano first) then
 *      diversity of providers (so a single-vendor outage doesn't fail
 *      the whole adjudication call).
 *   2. Per-attempt result records so the JSONL telemetry corpus row
 *      includes `provider_chain_attempts` for Stage 2 training.
 *   3. A bounded failure mode: when all five fail, the caller receives
 *      a structured error and the adjudicator surfaces an
 *      `adjudicator_throw` (per W3 doctrine, availability over gating).
 *
 * This module wraps `callLLM` so the lower-level OpenAI/Anthropic/etc.
 * client code stays the single source of provider plumbing. The chain
 * shape lives here in one place.
 */

import { callLLM, callLLMWithConfidence } from './client.js';
import type { ConfidenceSource, LogprobToken } from './confidence.js';
import { chainForCell, CELL_CHAINS, type Cell } from './cells.js';
import { recordDecision } from '../telemetry/index.js';

/**
 * W4 Track E: the adjudicator cell IS the canonical Track A chain. The chain
 * is now availability-filtered and telemetry-reorderable (see cells.ts);
 * `runProviderChain` resolves it at call time via `chainForCell('adjudicator')`
 * so a single-vendor client still resolves (the old hardcoded list had no
 * Anthropic model and broke a Claude-only deployment, brain #3019).
 *
 * This constant is retained for callers/tests that want the seed order
 * directly (the unfiltered table entry, before availability filtering).
 */
export const TRACK_A_PROVIDER_CHAIN = CELL_CHAINS['adjudicator'];

export type ChainModel = (typeof TRACK_A_PROVIDER_CHAIN)[number];

export interface AttemptRecord {
  model: string;
  rc: 'ok' | 'error';
  latency_ms: number;
  error?: string;
}

export interface ProviderChainResult {
  /** The raw LLM response text from the first successful attempt. */
  text: string;
  /** The model name that produced the response. */
  model: string;
  /** Per-attempt records, oldest first. Always includes the
   *  successful attempt as the last entry when `text` is present. */
  attempts: AttemptRecord[];
}

export class ProviderChainExhaustedError extends Error {
  readonly attempts: AttemptRecord[];
  constructor(attempts: AttemptRecord[]) {
    super(`Provider chain exhausted after ${attempts.length} attempts`);
    this.name = 'ProviderChainExhaustedError';
    this.attempts = attempts;
  }
}

export interface ProviderChainOpts {
  /** Override the default chain for tests, or pass a specific cell's chain
   *  (e.g. `chainForCell('injection-l3')`). Production paths that want the
   *  adjudicator cell leave this unset. */
  chain?: readonly string[];
  /** W4 Track E: the cell this call belongs to, for `cell_primary_used` /
   *  `provider_failover` telemetry. Defaults to 'adjudicator' (the cell
   *  whose chain backs the unset-chain default). */
  cell?: Cell;
  /** Per-attempt max tokens. Calibrated teacher uses 400 (small JSON
   *  blob fits comfortably; rationale is hard-capped at 25 words). */
  maxTokens?: number;
  /** Temperature. Adjudication is deterministic-ish; default 0. */
  temperature?: number;
  /** OpenAI prompt-cache key. Calibrated teacher reuses one key so the
   *  long reason-code-definitions block hits the cache. */
  cacheKey?: string;
  /** Lock-routing (S77): when true the chain runner owns failover and the
   *  per-member call does NOT expand its own implicit fallback. The bench
   *  model-pin path passes `chain: [pinned]` + `noFallback: true` so a pinned
   *  run is a single model with NO failover (keeps the unrouted sweep valid). */
  noFallback?: boolean;
  /** Answer-path only: question text for the confidence linguistic fallback. */
  query?: string;
  /** Answer-path only: retrieved fact count for the confidence linguistic fallback. */
  retrievedFactCount?: number;
}

/** Result of the confidence-preserving chain variant (answer path). */
export interface ProviderChainConfidenceResult {
  text: string;
  confidence: number;
  source: ConfidenceSource;
  /** The model that actually produced the answer. */
  model: string;
  attempts: AttemptRecord[];
  logprobs?: LogprobToken[];
}

/**
 * Shared chain walk + telemetry. Emits `cell_primary_used` on entry (with the
 * cell tag) and `provider_failover` per fallback (from_model/to_model/reason),
 * and throws `ProviderChainExhaustedError` when every member fails. `callOne`
 * runs one chain member; both the text and confidence variants reuse this so
 * there is ONE place that emits the cell telemetry.
 */
async function walkChain<R>(
  opts: ProviderChainOpts,
  callOne: (model: string, maxTokens: number, temperature: number) => Promise<R>,
): Promise<{ value: R; model: string; attempts: AttemptRecord[] }> {
  const cell: Cell = opts.cell ?? 'adjudicator';
  const chain: readonly string[] = opts.chain ?? chainForCell(cell);
  const maxTokens = opts.maxTokens ?? 400;
  const temperature = opts.temperature ?? 0;

  if (chain.length > 0) {
    recordDecision({
      decision_type: 'cell_primary_used',
      branch_taken: chain[0]!,
      inputs: { cell },
    });
  }

  const attempts: AttemptRecord[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    const t0 = Date.now();
    try {
      const value = await callOne(model, maxTokens, temperature);
      attempts.push({ model, rc: 'ok', latency_ms: Date.now() - t0 });
      return { value, model, attempts };
    } catch (err) {
      attempts.push({
        model,
        rc: 'error',
        latency_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      // Every cross-vendor fallback is observable (doctrine #6).
      recordDecision({
        decision_type: 'provider_failover',
        branch_taken: chain[i + 1] ?? 'exhausted',
        inputs: {
          cell,
          from_model: model,
          to_model: chain[i + 1] ?? null,
          reason: err instanceof Error ? err.message.slice(0, 120) : 'error',
        },
      });
    }
  }

  throw new ProviderChainExhaustedError(attempts);
}

/**
 * Try each model in the chain in order until one returns successfully
 * or all five fail. Each `callLLM` invocation already has its own retry
 * + intra-provider fallback; this loop wraps that with the cross-vendor
 * chain so a sustained outage at, e.g., OpenAI immediately tries
 * DeepSeek rather than bouncing between OpenAI models.
 *
 * Note: `callLLM` has its own implicit fallback chain. By passing each
 * chain entry as the primary model on a separate top-level call, we
 * avoid the situation where `callLLM` would keep falling through to
 * `gpt-4.1-mini` on every attempt regardless of which Track A chain
 * member we wanted next.
 */
export async function runProviderChain(
  systemPrompt: string,
  userMessage: string,
  opts: ProviderChainOpts = {},
): Promise<ProviderChainResult> {
  const { value, model, attempts } = await walkChain(opts, (m, maxTokens, temperature) =>
    callLLM(m, systemPrompt, userMessage, maxTokens, temperature, {
      cacheKey: opts.cacheKey,
      noFallback: opts.noFallback,
    }),
  );
  return { text: value, model, attempts };
}

/**
 * Confidence-preserving variant for the answer path. Same shared walk +
 * telemetry as `runProviderChain`, but each member calls
 * `callLLMWithConfidence` so the returned confidence still drives escalation.
 */
export async function runProviderChainWithConfidence(
  systemPrompt: string,
  userMessage: string,
  opts: ProviderChainOpts = {},
): Promise<ProviderChainConfidenceResult> {
  const { value, attempts } = await walkChain(opts, (m, maxTokens, temperature) =>
    callLLMWithConfidence(m, systemPrompt, userMessage, maxTokens, temperature, {
      cacheKey: opts.cacheKey,
      noFallback: opts.noFallback,
      ...(opts.query !== undefined ? { query: opts.query } : {}),
      ...(opts.retrievedFactCount !== undefined ? { retrievedFactCount: opts.retrievedFactCount } : {}),
    }),
  );
  const result: ProviderChainConfidenceResult = {
    text: value.text,
    confidence: value.confidence,
    source: value.source,
    // The model that actually produced the answer (after any inner fallback).
    model: value.modelUsed,
    attempts,
  };
  if (value.logprobs) result.logprobs = value.logprobs;
  return result;
}
