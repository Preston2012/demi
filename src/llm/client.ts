/**
 * Multi-provider LLM client.
 * Routes by model name prefix: gpt→OpenAI, claude→Anthropic, gemini→Google, grok→xAI,
 * mistral→Mistral, deepseek→DeepSeek.
 *
 * S27: Retry + provider fallback + session-level health tracking.
 *      - 1 retry on failure, then fallback to gpt-4.1-mini
 *      - Fallback strips routing prompt suffixes
 *      - After 3 consecutive failures from a provider, marks it DOWN for the session
 *      - Subsequent calls skip the down provider entirely (zero latency penalty)
 *
 * S51: Lifted from src/benchmark/llm-caller.ts so engine-side code (dispatch.answer,
 *      src/answer/answer.ts) can import without reaching into src/benchmark/.
 *      src/benchmark/llm-caller.ts re-exports from here for back-compat.
 *
 * S51: Adds callLLMWithConfidence(), same retry/fallback semantics, but returns
 *      `{text, confidence, source, logprobs?}`. Logprobs requested for OpenAI/xAI;
 *      self-report (`<confidence>0.X</confidence>`) for the rest; local linguistic
 *      heuristic on extraction failure. Default 0.5, never 1.0.
 *
 * S65 Sprint 1: Adds optional prompt-cache support across providers that
 *      implement it natively.
 *      - OpenAI:   `prompt_cache_key` field on the request, `cached_tokens`
 *                  reported in `usage.prompt_tokens_details`. Routes ≥1024-token
 *                  prefixes through the cache automatically when `cacheKey`
 *                  is set; bills cached input at 50% off, lower latency.
 *      - DeepSeek: auto-caches identical prefixes with no opt-in field.
 *                  Same `cached_tokens` shape in usage.
 *      - Mistral:  auto-caches with `cached_tokens` in usage. No opt-in field.
 *      - xAI:      no prompt-cache as of 2026-05; passes through.
 *      - Anthropic: dropped from default routing (consensus moved off Haiku
 *                  per M13). Pass-through, no cache.
 *      Adds module-level cache stats (`getLLMCacheStats`, `resetLLMCacheStats`)
 *      for bench runners to verify cache behavior, and an `opts` parameter to
 *      `callLLM` / `callLLMWithConfidence` so callers can pass `cacheKey`.
 *      Existing positional callers untouched.
 */

import { SELF_REPORT_INSTRUCTION, extractConfidence, type ConfidenceSource, type LogprobToken } from './confidence.js';
import { recordLlmCall, recordDecision } from '../telemetry/index.js';
import { getProviderName } from './provider-name.js';
import { filterChain, DEFAULT_ORDER } from './provider-availability.js';

// ---------------------------------------------------------------------------
// Provider Health Tracking
// ---------------------------------------------------------------------------

// Degenerate last-resort literal, used only when zero providers are configured
// (which boot validation rejects). In every normal case the final fallback is
// resolved to the first AVAILABLE model in DEFAULT_ORDER (see finalFallbackModel).
const FINAL_FALLBACK = 'gpt-4.1-mini';

// S65 Sprint 1 (M12): exponential backoff with jitter for transient
// provider errors (rate limits, 5xx). Wraps a single attempt; the
// outer failover loop handles cross-provider escalation.
//
// Schedule (ms): 250, 500, 1000, 2000 with +/-25% jitter. Cap at ~5s
// total wait per provider; longer waits should escalate to fallback
// chain rather than block the request.
const M12_BACKOFF_BASE_MS = parseInt(process.env.LLM_BACKOFF_BASE_MS || '250', 10);
const M12_BACKOFF_MAX_RETRIES = parseInt(process.env.LLM_BACKOFF_MAX_RETRIES || '3', 10);

function isRetryableError(err: unknown): boolean {
  // S65 M12: classify errors as retryable (transient) vs not (auth, schema).
  // Provider-side rate limits and 5xx are retryable; 4xx other than 429
  // means the request is malformed and a retry won't fix it.
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b429\b/.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(msg)) return true;
  // Anthropic-specific overload
  if (/overloaded/i.test(msg)) return true;
  return false;
}

async function backoffAttempt<T>(fn: () => Promise<T>, maxRetries: number = M12_BACKOFF_MAX_RETRIES): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      if (!isRetryableError(err)) break;
      const baseDelay = M12_BACKOFF_BASE_MS * Math.pow(2, attempt);
      // Jitter: +/- 25%
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.floor(baseDelay + jitter));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

const FALLBACK_CHAINS: Record<string, string[]> = {
  'grok-4-1-fast-reasoning': ['claude-sonnet-4-20250514', 'gpt-4.1-mini'],
  'grok-4-1-fast-non-reasoning': ['gpt-4.1-mini', 'gemini-2.5-flash'],
  'claude-sonnet-4-20250514': ['gpt-4.1-mini', 'grok-4-1-fast-reasoning'],
  'gpt-4.1-mini': ['gemini-2.5-flash', 'grok-4-1-fast-non-reasoning'],
  'gpt-4o-mini': ['gpt-4.1-mini', 'gemini-2.5-flash'],
  'gemini-2.5-flash': ['gpt-4.1-mini', 'gpt-4o-mini'],
  'mistral-small-latest': ['gpt-4.1-mini', 'grok-4-1-fast-non-reasoning'],
  'deepseek-chat': ['gpt-4.1-mini', 'gpt-4o-mini'],
  // S65 cost-mitigation: nano primary for extraction + validator-1.
  // Fallback to grok-fast-non-reasoning (also cheap) then gpt-4.1-mini.
  'gpt-4.1-nano': ['grok-4-1-fast-non-reasoning', 'gpt-4.1-mini'],
};

/**
 * W4 Track E: the final fallback is the first AVAILABLE model in the default
 * escalation order, not a hardcoded `gpt-4.1-mini`. This is the answer-path
 * half of the single-vendor fix (#3019): a Claude-only client resolves the
 * final fallback to its Anthropic model instead of an unreachable OpenAI one.
 */
function finalFallbackModel(): string {
  const ordered = filterChain(DEFAULT_ORDER);
  return ordered[0] ?? FINAL_FALLBACK;
}

/**
 * W4 Track E: the per-model fallback list, availability-filtered so it never
 * contains an unreachable provider. When all keys are present `filterChain`
 * is a no-op and this returns the original list unchanged (the all-keys-noop
 * invariant). For a model with no declared list, falls back to the first
 * available model in the default order.
 */
function getFallbackChain(primaryModel: string): string[] {
  const base = FALLBACK_CHAINS[primaryModel];
  if (base) return filterChain(base);
  return [finalFallbackModel()];
}

/**
 * W4 Track E: classify why a chain fell past a candidate, for the
 * `provider_failover` telemetry decision. Reasons feed the per-cell ordering
 * loop (which providers fail, and how, for each route).
 */
function classifyFailoverReason(err: unknown, provider: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not set/i.test(msg)) return 'provider_absent';
  if (isProviderDown(provider)) return 'provider_down';
  if (/\b429\b|rate.?limit/i.test(msg)) return 'rate_limit';
  if (/timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg)) return 'timeout';
  return 'error';
}

/**
 * W4 Track E: record an observable failover. Doctrine forbids silent
 * fallback, which hides cost and provider-health signal. No-op when telemetry
 * is disabled or no trace is active.
 */
function recordFailover(fromModel: string, toModel: string | undefined, reason: string): void {
  recordDecision({
    decision_type: 'provider_failover',
    branch_taken: toModel ?? 'exhausted',
    inputs: { from_model: fromModel, to_model: toModel ?? null, reason },
  });
}
const PROVIDER_DOWN_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 60_000;

interface ProviderHealth {
  consecutiveFailures: number;
  isDown: boolean;
  downSince: number | null;
  totalFallbacks: number;
}

const providerHealth: Record<string, ProviderHealth> = {};

function getHealth(provider: string): ProviderHealth {
  if (!providerHealth[provider]) {
    providerHealth[provider] = { consecutiveFailures: 0, isDown: false, downSince: null, totalFallbacks: 0 };
  }
  const h = providerHealth[provider]!;
  if (h.isDown && h.downSince && Date.now() - h.downSince > PROVIDER_COOLDOWN_MS) {
    h.isDown = false;
    h.consecutiveFailures = 0;
    h.downSince = null;
  }
  return h;
}

function recordSuccess(provider: string): void {
  const h = getHealth(provider);
  h.consecutiveFailures = 0;
  if (h.isDown) {
    console.error(`  [HEALTH] ${provider} recovered after ${h.totalFallbacks} fallbacks`);
    h.isDown = false;
    h.downSince = null;
  }
}

function recordFailure(provider: string): void {
  const h = getHealth(provider);
  h.consecutiveFailures++;
  h.totalFallbacks++;
  if (!h.isDown && h.consecutiveFailures >= PROVIDER_DOWN_THRESHOLD) {
    h.isDown = true;
    h.downSince = Date.now();
    console.error(
      `  [HEALTH] ${provider} marked DOWN after ${h.consecutiveFailures} consecutive failures. Routing disabled for this provider.`,
    );
  }
}

function isProviderDown(provider: string): boolean {
  return getHealth(provider).isDown;
}

/**
 * S65 Sprint 1: reset module-level provider health state. Used by tests
 * (beforeEach) so test cases don't poison each other's fallback chain
 * tracking. NOT for production use.
 */
export function resetProviderHealth(): void {
  for (const k of Object.keys(providerHealth)) {
    delete providerHealth[k];
  }
}

function supportsLogprobs(model: string): boolean {
  // OpenAI chat/completions and xAI both expose logprobs over the OpenAI-compat API.
  // Anthropic, Gemini, Mistral, DeepSeek do not (or expose only token-id-based variants).
  if (model.startsWith('gpt')) return true;
  if (model.startsWith('grok')) return true;
  // Reasoning models (o1/o3/o4) do not support logprobs in the chat API.
  return false;
}

/**
 * S65: which providers natively cache prompt prefixes.
 * Used to decide whether to log a cache stat or pass-through.
 */
function supportsPromptCache(model: string): boolean {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return true;
  if (model.startsWith('deepseek')) return true;
  if (model.startsWith('mistral')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// S65: Prompt-cache observability
// ---------------------------------------------------------------------------

export interface LLMCacheStats {
  /** Total LLM calls observed since last reset. */
  calls: number;
  /** Calls that returned at least 1 cached token. */
  hits: number;
  /** Calls where cached_tokens was 0 or unreported. */
  misses: number;
  /** Total prompt tokens billed (cached + uncached). */
  promptTokens: number;
  /** Total cached prompt tokens (the cheap or free portion). */
  cachedTokens: number;
  /** Per-provider rollup. */
  byProvider: Record<string, { calls: number; hits: number; promptTokens: number; cachedTokens: number }>;
}

const cacheStats: LLMCacheStats = {
  calls: 0,
  hits: 0,
  misses: 0,
  promptTokens: 0,
  cachedTokens: 0,
  byProvider: {},
};

function recordCacheUsage(provider: string, promptTokens: number, cachedTokens: number): void {
  cacheStats.calls += 1;
  cacheStats.promptTokens += promptTokens;
  cacheStats.cachedTokens += cachedTokens;
  if (cachedTokens > 0) cacheStats.hits += 1;
  else cacheStats.misses += 1;

  const p = cacheStats.byProvider[provider] ?? { calls: 0, hits: 0, promptTokens: 0, cachedTokens: 0 };
  p.calls += 1;
  p.promptTokens += promptTokens;
  p.cachedTokens += cachedTokens;
  if (cachedTokens > 0) p.hits += 1;
  cacheStats.byProvider[provider] = p;
}

export function getLLMCacheStats(): LLMCacheStats {
  // Return a deep-ish copy so callers can't mutate internal state.
  return {
    calls: cacheStats.calls,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    promptTokens: cacheStats.promptTokens,
    cachedTokens: cacheStats.cachedTokens,
    byProvider: Object.fromEntries(Object.entries(cacheStats.byProvider).map(([k, v]) => [k, { ...v }])),
  };
}

export function resetLLMCacheStats(): void {
  cacheStats.calls = 0;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.promptTokens = 0;
  cacheStats.cachedTokens = 0;
  cacheStats.byProvider = {};
}

// ---------------------------------------------------------------------------
// Routing Suffix Management
// ---------------------------------------------------------------------------

const ROUTING_SUFFIXES_TO_STRIP = ['Be concise. Answer in 1-2 sentences max. Do not explain your reasoning.'];

function stripRoutingSuffixes(prompt: string): string {
  let cleaned = prompt;
  for (const suffix of ROUTING_SUFFIXES_TO_STRIP) {
    cleaned = cleaned.replace(suffix, '').trim();
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Output Cleaning
// ---------------------------------------------------------------------------

function stripGrokOutput(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\(M\d+[^)]*\)/g, '')
    .replace(/\[M\d+[^\]]*\]/g, '')
    .replace(/\n\nFrom the memory context[\s\S]*/g, '')
    .replace(/\n\n---[\s\S]*/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// S65: shared call options
// ---------------------------------------------------------------------------

export interface LLMCallOpts {
  /**
   * S65: opt-in OpenAI prompt-cache routing. Identical cacheKey across calls
   * helps OpenAI prefix-cache route identical system prompts to the same
   * cache shard. ≥1024-token prefix required for any cache benefit.
   * Other providers (DeepSeek, Mistral) auto-cache without this field.
   * xAI / Anthropic ignore it.
   *
   * Recommended values: a stable identifier per prompt-class
   * (e.g. `'demiurge:answer:v1'`, `'demiurge:judge:dialsim'`,
   * `'demiurge:consensus:validator'`). NOT per-question.
   */
  cacheKey?: string;
  /** AbortSignal for caller-driven cancellation. */
  signal?: AbortSignal;
  /**
   * Lock-routing (S77): disable the implicit per-model fallback chain. When
   * true, only `model` is attempted (no getFallbackChain expansion). The
   * provider-chain runner sets this so IT owns failover; the bench model-pin
   * path sets it so a pinned run is a single model with NO failover (the
   * invariant that keeps the unrouted sweep valid). Runtime health-skip
   * (isProviderDown) still applies.
   */
  noFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Provider Dispatch (text-only)
// ---------------------------------------------------------------------------

interface ProviderRichResult {
  text: string;
  logprobs?: LogprobToken[];
  promptTokens?: number;
  cachedTokens?: number;
}

async function callProvider(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts = {},
): Promise<ProviderRichResult> {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return callOpenAI(model, systemPrompt, userMessage, maxTokens, temperature, opts);
  } else if (model.startsWith('gemini')) {
    return callGemini(model, systemPrompt, userMessage, maxTokens, temperature, opts);
  } else if (model.startsWith('grok')) {
    const r = await callXAI(model, systemPrompt, userMessage, maxTokens, temperature, opts);
    return { ...r, text: stripGrokOutput(r.text) };
  } else if (model.startsWith('mistral')) {
    return callMistral(model, systemPrompt, userMessage, maxTokens, temperature, opts);
  } else if (model.startsWith('deepseek')) {
    return callDeepSeek(model, systemPrompt, userMessage, maxTokens, temperature, opts);
  } else {
    return callAnthropic(model, systemPrompt, userMessage, maxTokens, temperature, opts);
  }
}

// ---------------------------------------------------------------------------
// Provider Dispatch (with optional logprobs)
// ---------------------------------------------------------------------------

async function callProviderRaw(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts = {},
): Promise<ProviderRichResult> {
  if (supportsLogprobs(model)) {
    if (model.startsWith('gpt')) {
      return callOpenAIWithLogprobs(model, systemPrompt, userMessage, maxTokens, temperature, opts);
    }
    if (model.startsWith('grok')) {
      const r = await callXAIWithLogprobs(model, systemPrompt, userMessage, maxTokens, temperature, opts);
      return { ...r, text: stripGrokOutput(r.text) };
    }
  }
  // Self-report path: instruction is prepended by callLLMWithConfidence,
  // so callProvider sees an already-augmented system prompt.
  return callProvider(model, systemPrompt, userMessage, maxTokens, temperature, opts);
}

// ---------------------------------------------------------------------------
// Main Entry Point, text only (back-compat)
// ---------------------------------------------------------------------------

/**
 * Back-compat positional signature. Existing callers pass model/system/user
 * only. New callers should pass `opts.cacheKey` for prompt-cache routing.
 */
export async function callLLM(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 150,
  temperature: number = 0,
  opts: LLMCallOpts = {},
): Promise<string> {
  const chain = opts.noFallback ? [model] : [model, ...getFallbackChain(model)];
  let raw: ProviderRichResult | undefined;
  let lastErr: unknown;

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i]!;
    const provider = getProviderName(candidateModel);

    if (isProviderDown(provider)) {
      // W4 Track E: a health-skip is an observable failover.
      recordFailover(candidateModel, chain[i + 1], 'provider_down');
      continue;
    }

    const prompt = candidateModel === model ? systemPrompt : stripRoutingSuffixes(systemPrompt);

    const llmStart = Date.now();
    try {
      // S65 M12: exponential backoff replaces the fixed 500ms retry.
      raw = await backoffAttempt(() => callProvider(candidateModel, prompt, userMessage, maxTokens, temperature, opts));
      recordSuccess(provider);
      if (raw.promptTokens !== undefined) {
        recordCacheUsage(provider, raw.promptTokens, raw.cachedTokens ?? 0);
      }
      // Wedge 1.5 Phase 2: record successful LLM call.
      recordLlmCall({
        provider,
        model: candidateModel,
        tokens_in: raw.promptTokens,
        latency_ms: Date.now() - llmStart,
        cache_hit: (raw.cachedTokens ?? 0) > 0,
        retry_count: 0,
        status: 'ok',
      });
      // S67: remove empty console.error noise. Successful fallback is
      // already observable via the per-provider health stats and the
      // recordSuccess/recordFailure counters.
      break;
    } catch (retryErr) {
      recordFailure(provider);
      // Wedge 1.5 Phase 2: record failed LLM call.
      recordLlmCall({
        provider,
        model: candidateModel,
        latency_ms: Date.now() - llmStart,
        cache_hit: false,
        retry_count: 0,
        status: 'error',
      });
      // W4 Track E: record the failover so cost + provider-health signal is
      // never silent. `to_model` is undefined on the last attempt (exhausted).
      recordFailover(candidateModel, chain[i + 1], classifyFailoverReason(retryErr, provider));
      lastErr = retryErr;
    }
  }

  if (raw === undefined) {
    throw lastErr || new Error('All LLM providers failed and no fallback succeeded');
  }

  return raw.text;
}

// ---------------------------------------------------------------------------
// Confidence-aware entry point (S51)
// ---------------------------------------------------------------------------

export interface LLMConfidenceResult {
  text: string;
  confidence: number;
  source: ConfidenceSource;
  modelUsed: string;
  logprobs?: LogprobToken[];
}

export interface CallLLMWithConfidenceOpts extends LLMCallOpts {
  /** Question text, used by linguistic-fallback to detect entity presence. */
  query?: string;
  /** Number of memories surfaced to the answer LLM. Used by linguistic fallback. */
  retrievedFactCount?: number;
}

/**
 * Same retry/fallback semantics as callLLM, but returns confidence alongside
 * the answer text. Confidence source priority: logprobs > self-report >
 * linguistic-fallback. Default 0.5 on extraction failure.
 *
 * Self-report instruction is auto-prepended to the system prompt for providers
 * without logprob support. Tag is stripped from the returned text.
 */
export async function callLLMWithConfidence(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 200,
  temperature: number = 0,
  opts: CallLLMWithConfidenceOpts = {},
): Promise<LLMConfidenceResult> {
  const chain = opts.noFallback ? [model] : [model, ...getFallbackChain(model)];
  let raw: ProviderRichResult | undefined;
  let usedModel: string | undefined;
  let lastErr: unknown;
  const callOpts: LLMCallOpts = {};
  if (opts.cacheKey !== undefined) callOpts.cacheKey = opts.cacheKey;
  if (opts.signal !== undefined) callOpts.signal = opts.signal;

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i]!;
    const provider = getProviderName(candidateModel);
    if (isProviderDown(provider)) {
      // W4 Track E: a health-skip is an observable failover.
      recordFailover(candidateModel, chain[i + 1], 'provider_down');
      continue;
    }

    const basePrompt = candidateModel === model ? systemPrompt : stripRoutingSuffixes(systemPrompt);
    const prompt = supportsLogprobs(candidateModel) ? basePrompt : `${basePrompt}\n\n${SELF_REPORT_INSTRUCTION}`;

    try {
      // S65 M12: exponential backoff replaces the fixed 500ms retry.
      raw = await backoffAttempt(() =>
        callProviderRaw(candidateModel, prompt, userMessage, maxTokens, temperature, callOpts),
      );
      recordSuccess(provider);
      if (raw.promptTokens !== undefined) {
        recordCacheUsage(provider, raw.promptTokens, raw.cachedTokens ?? 0);
      }
      usedModel = candidateModel;
      break;
    } catch (retryErr) {
      recordFailure(provider);
      // W4 Track E: observable failover (see callLLM).
      recordFailover(candidateModel, chain[i + 1], classifyFailoverReason(retryErr, provider));
      lastErr = retryErr;
    }
  }

  if (!raw || !usedModel) {
    throw lastErr || new Error('All providers failed');
  }

  const extracted = extractConfidence(
    { text: raw.text, ...(raw.logprobs ? { logprobs: raw.logprobs } : {}) },
    {
      query: opts.query ?? '',
      retrievedFactCount: opts.retrievedFactCount ?? 0,
    },
  );

  const finalText = extracted.text;

  const result: LLMConfidenceResult = {
    text: finalText,
    confidence: extracted.confidence,
    source: extracted.source,
    modelUsed: usedModel,
  };
  if (extracted.logprobs) result.logprobs = extracted.logprobs;
  return result;
}

// ---------------------------------------------------------------------------
// Provider Implementations
// ---------------------------------------------------------------------------

interface UsageBlock {
  prompt_tokens?: number;
  total_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function extractUsage(usage: UsageBlock | undefined): { promptTokens: number; cachedTokens: number } {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return { promptTokens, cachedTokens };
}

async function callOpenAI(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (opts.cacheKey) body.prompt_cache_key = opts.cacheKey;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${errBody.substring(0, 200)}`);
  }
  const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: UsageBlock };
  const text = d.choices?.[0]?.message?.content ?? '';
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  return { text, promptTokens, cachedTokens };
}

async function callOpenAIWithLogprobs(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    logprobs: true,
    top_logprobs: 1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (opts.cacheKey) body.prompt_cache_key = opts.cacheKey;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${errBody.substring(0, 200)}`);
  }
  const d = (await r.json()) as {
    choices?: Array<{
      message?: { content?: string };
      logprobs?: { content?: Array<{ token: string; logprob: number }> };
    }>;
    usage?: UsageBlock;
  };
  const text: string = d.choices?.[0]?.message?.content ?? '';
  const lp: Array<{ token: string; logprob: number }> | undefined = d.choices?.[0]?.logprobs?.content?.map((t) => ({
    token: t.token,
    logprob: t.logprob,
  }));
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  const result: ProviderRichResult = { text, promptTokens, cachedTokens };
  if (lp && lp.length > 0) result.logprobs = lp;
  return result;
}

async function callAnthropic(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  // Anthropic does not honor `prompt_cache_key`; cache_control blocks would be
  // a different shape and aren't wired here. Pass-through, no cache stat.
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = d.content?.[0]?.text ?? '';
  const promptTokens = d.usage?.input_tokens ?? 0;
  return { text, promptTokens, cachedTokens: 0 };
}

async function callGemini(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const isNoThink = model.endsWith('-nothink');
  const actualModel = isNoThink ? model.replace('-nothink', '') : model;
  const adjustedMaxTokens = isNoThink ? maxTokens : Math.max(maxTokens * 3, 300);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: adjustedMaxTokens,
        temperature,
        ...(isNoThink ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number };
  };
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const promptTokens = d.usageMetadata?.promptTokenCount ?? 0;
  // Gemini does not currently surface cached_tokens in this API.
  return { text, promptTokens, cachedTokens: 0 };
}

async function callXAI(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY not set');
  const adjustedMaxTokens = model.includes('reasoning') ? Math.max(maxTokens * 3, 450) : maxTokens;
  // xAI does not implement prompt_cache_key as of 2026-05; passes through.
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: adjustedMaxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`xAI ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: UsageBlock };
  const text = d.choices?.[0]?.message?.content ?? '';
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  return { text, promptTokens, cachedTokens };
}

async function callXAIWithLogprobs(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY not set');
  const adjustedMaxTokens = model.includes('reasoning') ? Math.max(maxTokens * 3, 450) : maxTokens;
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: adjustedMaxTokens,
      temperature,
      logprobs: true,
      top_logprobs: 1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`xAI ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as {
    choices?: Array<{
      message?: { content?: string };
      logprobs?: { content?: Array<{ token: string; logprob: number }> };
    }>;
    usage?: UsageBlock;
  };
  const text: string = d.choices?.[0]?.message?.content ?? '';
  const lp: Array<{ token: string; logprob: number }> | undefined = d.choices?.[0]?.logprobs?.content?.map((t) => ({
    token: t.token,
    logprob: t.logprob,
  }));
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  const result: ProviderRichResult = { text, promptTokens, cachedTokens };
  if (lp && lp.length > 0) result.logprobs = lp;
  return result;
}

async function callMistral(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  // Mistral auto-caches identical prefixes, `cached_tokens` reported in usage.
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Mistral ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: UsageBlock };
  const text = d.choices?.[0]?.message?.content ?? '';
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  return { text, promptTokens, cachedTokens };
}

async function callDeepSeek(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  opts: LLMCallOpts,
): Promise<ProviderRichResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  // DeepSeek auto-caches identical prefixes, `cached_tokens` reported in usage.
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`DeepSeek ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: UsageBlock };
  const text = d.choices?.[0]?.message?.content ?? '';
  const { promptTokens, cachedTokens } = extractUsage(d.usage);
  return { text, promptTokens, cachedTokens };
}

// supportsPromptCache exported for benches that want to log "this provider has cache support".
export { supportsPromptCache };
