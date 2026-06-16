/**
 * S51, first-class engine answer surface.
 *
 * Today the engine returns memories for upstream injection (dispatch.search).
 * `answerQuery()` adds an opinionated wrapper: search → LLM call → confidence
 * extraction → return `{answer, confidence, search, model}`.
 *
 * Used by `dispatch.answer()` and by the calibration benches (ECE/Brier,
 * recall@K) where confidence-vs-correctness is the metric.
 *
 * Default answer prompt is concise. Caller can override via opts.answerPrompt.
 *
 * S65 Sprint 1: closes the brain #2044 TODO, `nowIso` now plumbs through
 * AnswerOpts to dispatch.search. Pinning the engine "now" anchor per
 * conversation eliminates wall-clock leak that would otherwise bust
 * retrieval-cache hits across iteration cycles.
 *
 * S65 prompt-honesty: per-category prompts and answer-model routing are now
 * applied INSIDE the engine, driven by the classified queryType the search
 * stage already computed. Bench runners that previously handcrafted the
 * system prompt (CATEGORY_PROMPTS + ANSWER_PROMPT_SUFFIX env override +
 * router suffix) are now honest by going through dispatch.answer(). Real
 * users get the same per-category prompts and routing as the bench measures.
 * No bench-only prompt construction.
 */

import type { SearchResult } from '../core/dispatch.js';
import type { ConfidenceSource, LogprobToken } from '../llm/confidence.js';
import { getPromptForQuery } from '../inject/prompts.js';
import { promptSuffixForQueryType } from './router.js';
import { routeToCell } from './query-router.js';
import { chainForCell } from '../llm/cells.js';
import { runProviderChainWithConfidence } from '../llm/provider-chain.js';

export interface AnswerResult {
  /** Final answer string (self-report tag stripped if present). */
  answer: string;
  /** Confidence in [0,1]. Default 0.5 on extraction failure (never 1.0). */
  confidence: number;
  /** How confidence was derived. */
  confidenceSource: ConfidenceSource;
  /** The retrieval result that grounded the answer. */
  search: SearchResult;
  /** Model that produced the answer (after fallback chain resolution). */
  model: string;
  /** Optional logprobs for confidence diagnostics. */
  logprobs?: LogprobToken[];
}

export interface AnswerOpts {
  model?: string;
  maxRules?: number;
  maxTokens?: number;
  conversationId?: string;
  userId?: string;
  temperature?: number;
  /**
   * Override the engine's per-category answer prompt. Most callers should
   * leave this unset and let the engine pick a per-queryType prompt via
   * getPromptForQuery(). Only set this when you need to pin a specific
   * prompt (e.g. ablation tests, special-purpose surfaces).
   *
   * S65 prompt-honesty: bench runners MUST NOT set this, bench scores must
   * reflect what production users actually get, and production users get
   * the engine-selected per-category prompt.
   */
  answerPrompt?: string;
  /**
   * S65: per-conversation "now" anchor for bi-temporal filtering, RRF reference,
   * query-expansion's relative-date normalization, freshness scoring, and
   * reranker recency math. Used by bench runners to pin per-conversation
   * wall-clock when seeding historical transcripts; production callers (MCP /
   * REST) leave this undefined to keep server wall-clock behavior. Plumbing
   * the override eliminates wall-clock leak that would bust retrieval-cache
   * hits across iteration cycles. Brain #2044 + Sprint 1 cost mitigation.
   *
   * D3 (S71): nowIso no longer modifies the answer prompt. The
   * `Today is YYYY-MM-DD.` anchor that previously got prepended was a
   * read-time band-aid for relative-date resolution that should happen
   * at write-time (see A3 asOf primitive + D1 Temporal Parse IR).
   * nowIso is still forwarded to dispatch.search for retrieval-side
   * freshness/RRF/reranker wall-clock pinning.
   */
  nowIso?: string;
}

const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_MAX_RULES = 65;
const DEFAULT_MAX_TOKENS = 200;

/**
 * Minimal interface this module needs from CoreDispatch. Defined locally to
 * avoid a hard import cycle with src/core/dispatch.ts (the dispatch module
 * imports answerQuery to implement dispatch.answer()).
 */
export interface SearchCapableDispatch {
  search(
    query: string,
    limit?: number,
    conversationId?: string,
    userId?: string,
    nowIso?: string,
  ): Promise<SearchResult>;
}

export async function answerQuery(
  dispatch: SearchCapableDispatch,
  query: string,
  opts: AnswerOpts = {},
): Promise<AnswerResult> {
  const maxRules = opts.maxRules ?? DEFAULT_MAX_RULES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? 0;

  // S65: forward opts.nowIso to dispatch.search so bench runners get the same
  // per-conversation anchor on the answer path that they get on the search
  // path. Production callers leave nowIso undefined → server wall-clock.
  const search = await dispatch.search(query, maxRules, opts.conversationId, opts.userId, opts.nowIso);

  // S65 prompt-honesty: pick the engine's per-category answer prompt based on
  // the queryType the search stage already classified. Real users get the
  // same prompt selection as the bench measures.
  const queryType = search.raw.metadata.queryType;
  const basePrompt = opts.answerPrompt ?? getPromptForQuery(queryType, query);

  // Lock-routing (S77): one routing source of truth. routeToCell maps the
  // queryType (+ coding detection) to a cell; the answer runs the cell's
  // provider chain so it emits cell_primary_used + provider_failover and gets
  // cross-provider failover. Routing is default-OFF as of S77 (ANSWER_ROUTING === 'true').
  // Per-queryType output guidance (COMPLEX_SUFFIX) is preserved via the suffix;
  // the router changes the model, not the suffix.
  //
  // Bench pinning (NON-NEGOTIABLE): a caller-pinned `opts.model` (--answer-model)
  // collapses to a single-element chain with NO failover, bypassing routing, so
  // the unrouted iteration sweep stays valid even with routing default-on.
  const cell = routeToCell(queryType, query);
  const routingOn = process.env.ANSWER_ROUTING === 'true';
  const suffix = routingOn ? promptSuffixForQueryType(queryType) : '';

  let chain: string[];
  let noFallback = false;
  if (opts.model) {
    chain = [opts.model]; // bench pin: single model, no failover
    noFallback = true;
  } else if (routingOn) {
    chain = chainForCell(cell); // routed: the cell's provider chain
  } else {
    chain = [DEFAULT_MODEL]; // routing disabled, unpinned: today's default model
  }
  if (chain.length === 0) chain = [DEFAULT_MODEL]; // never hand the runner an empty chain

  // D3 (S71): "Today is X" answer-time prefix decommissioned. Relative-date
  // resolution belongs at write-time (A3 asOf primitive + D1 Temporal Parse
  // IR), not stitched onto the answer system prompt. The engine still pins
  // wall-clock for retrieval-side scoring via opts.nowIso → dispatch.search.
  const answerPrompt = `${basePrompt}${suffix}`;

  const userMessage = `Context:\n${search.contextText}\n\nQuestion: ${query}`;
  const retrievedFactCount = search.raw.candidates.length;

  const chainResult = await runProviderChainWithConfidence(answerPrompt, userMessage, {
    cell,
    chain,
    noFallback,
    maxTokens,
    temperature,
    query,
    retrievedFactCount,
    // S65 Sprint 1: stable cacheKey for the production answer surface, keyed by
    // queryType so OpenAI prompt-cache hits stack within a category.
    cacheKey: `demiurge:answer:${queryType}:v2`,
  });

  const result: AnswerResult = {
    answer: chainResult.text,
    confidence: chainResult.confidence,
    confidenceSource: chainResult.source,
    search,
    model: chainResult.model,
  };
  if (chainResult.logprobs) result.logprobs = chainResult.logprobs;
  return result;
}
