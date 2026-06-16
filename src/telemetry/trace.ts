/**
 * Wedge 1.5 Phase 1: trace context via AsyncLocalStorage.
 *
 * Every request creates a Trace. Every operation inside threads the trace
 * context through ALS so callers don't need to pass it as a parameter.
 *
 * Hot-path overhead:
 *   - als.getStore(): sub-microsecond on Node 22.
 *   - span() wrapper: ~1μs to record duration + push event.
 *   - When TELEMETRY_ENABLED=false, getStorage() returns null and every
 *     helper returns early. Effective cost: a single null-check.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getStorage } from './storage.js';
import { shouldSample } from './sampling.js';
import { createHash } from 'node:crypto';
import { redactObject } from '../security/redact.js';
import { offByDefault } from '../config/flag-defaults.js';
import type {
  Trace,
  Span,
  Tags,
  DecisionEvent,
  RefusalEvent,
  ConflictEvent,
  LlmCallEvent,
  CacheEvent,
  ErrorEvent,
  BodyEvent,
  RetrievalEvent,
  InjectionEvent,
} from './types.js';

/**
 * Per-request context propagated via AsyncLocalStorage. Reads and writes
 * to this object are sync and lock-free; the storage layer takes care of
 * persistence asynchronously.
 */
export interface TraceContext {
  trace_id: string;
  entry: Trace['entry'];
  started_at: string;
  /** Stack of active span IDs. Top of stack is the current parent. */
  span_stack: string[];
  user_id?: string;
  conversation_id?: string;
  tags?: Tags;
  /** Error sink. If non-empty at trace close, status='error'. */
  error_type?: string;
}

const _als = new AsyncLocalStorage<TraceContext>();

/** Current trace context for the active async chain, or undefined. */
export function getActiveTrace(): TraceContext | undefined {
  return _als.getStore();
}

/** Current trace_id, or undefined if no trace is active. */
export function getActiveTraceId(): string | undefined {
  return _als.getStore()?.trace_id;
}

/**
 * Start a new trace and run `fn` inside its context. The trace is auto-flushed
 * to storage on completion (success or error).
 *
 * If telemetry is disabled, `fn` runs without an active trace and no events
 * are emitted.
 */
export async function withTrace<T>(
  opts: {
    entry: Trace['entry'];
    user_id?: string;
    conversation_id?: string;
    tags?: Tags;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) {
    return fn();
  }
  const trace_id = randomUUID();
  const started_at = new Date().toISOString();
  const ctx: TraceContext = {
    trace_id,
    entry: opts.entry,
    started_at,
    span_stack: [],
    user_id: opts.user_id,
    conversation_id: opts.conversation_id,
    tags: opts.tags,
  };
  const startMs = Date.now();
  try {
    const result = await _als.run(ctx, fn);
    flushTrace(ctx, startMs, 'ok');
    return result;
  } catch (err) {
    ctx.error_type = err instanceof Error ? err.constructor.name : 'unknown';
    flushTrace(ctx, startMs, 'error');
    throw err;
  }
}

function flushTrace(ctx: TraceContext, startMs: number, status: Trace['status']): void {
  const storage = getStorage();
  if (!storage) return;
  const ended_at = new Date().toISOString();
  const duration_ms = Date.now() - startMs;
  const trace: Trace = {
    trace_id: ctx.trace_id,
    entry: ctx.entry,
    started_at: ctx.started_at,
    ended_at,
    duration_ms,
    status,
    user_id: ctx.user_id,
    conversation_id: ctx.conversation_id,
    // Phase 2 follow-up: the SQL INSERT in storage.ts binds these as
    // named parameters. better-sqlite3 throws 'Missing named parameter'
    // when absent, and the flush loop swallows per-row errors. Result:
    // traces table stayed empty while child spans/decisions/llm_calls
    // all landed. Include explicit undefined so normalizeForSqlite
    // converts them to NULL bindings.
    request_size_bytes: undefined,
    response_size_bytes: undefined,
    error_type: ctx.error_type,
    tags: ctx.tags,
  };
  if (shouldSample('trace').sampled) {
    storage.enqueue({ kind: 'trace', payload: trace });
  }
}

/**
 * Wrap a function in a span. Records start time, runs fn, records duration,
 * emits a Span event.
 *
 * If telemetry is disabled or no trace is active, runs fn without recording.
 */
export async function span<T>(name: string, fn: () => Promise<T>, tags?: Tags): Promise<T> {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) {
    return fn();
  }
  const span_id = randomUUID();
  const parent_span_id = ctx.span_stack[ctx.span_stack.length - 1];
  const started_at = new Date().toISOString();
  const startMs = Date.now();
  ctx.span_stack.push(span_id);
  try {
    const result = await fn();
    const duration_ms = Date.now() - startMs;
    const isSlow = duration_ms > 100;
    if (shouldSample('span', { isSlow }).sampled) {
      const ev: Span = {
        span_id,
        trace_id: ctx.trace_id,
        parent_span_id,
        name,
        started_at,
        duration_ms,
        tags,
      };
      storage.enqueue({ kind: 'span', payload: ev });
    }
    return result;
  } finally {
    ctx.span_stack.pop();
  }
}

/**
 * Sync span variant for non-async operations. Same semantics as span()
 * but takes a synchronous function.
 */
export function spanSync<T>(name: string, fn: () => T, tags?: Tags): T {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) {
    return fn();
  }
  const span_id = randomUUID();
  const parent_span_id = ctx.span_stack[ctx.span_stack.length - 1];
  const started_at = new Date().toISOString();
  const startMs = Date.now();
  ctx.span_stack.push(span_id);
  try {
    const result = fn();
    const duration_ms = Date.now() - startMs;
    const isSlow = duration_ms > 100;
    if (shouldSample('span', { isSlow }).sampled) {
      const ev: Span = {
        span_id,
        trace_id: ctx.trace_id,
        parent_span_id,
        name,
        started_at,
        duration_ms,
        tags,
      };
      storage.enqueue({ kind: 'span', payload: ev });
    }
    return result;
  } finally {
    ctx.span_stack.pop();
  }
}

// ---------------------------------------------------------------------------
// Event helpers. Each emits the corresponding TelemetryEvent kind if a trace
// is active. All are no-ops when telemetry is disabled.
// ---------------------------------------------------------------------------

export function recordDecision(opts: {
  decision_type: DecisionEvent['decision_type'];
  branch_taken: string;
  inputs?: Record<string, unknown>;
  confidence?: number;
  outcome?: string;
  duration_ms?: number;
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) return;
  if (!shouldSample('decision').sampled) return;
  const ev: DecisionEvent = {
    decision_id: randomUUID(),
    trace_id: ctx.trace_id,
    span_id: ctx.span_stack[ctx.span_stack.length - 1],
    decision_type: opts.decision_type,
    branch_taken: opts.branch_taken,
    inputs_json: opts.inputs ? JSON.stringify(opts.inputs) : undefined,
    confidence: opts.confidence,
    outcome: opts.outcome,
    duration_ms: opts.duration_ms,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'decision', payload: ev });
}

export function recordRefusal(opts: {
  refusal_type: string;
  reason: string;
  evidence?: Record<string, unknown>;
  calibration_score?: number;
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) return;
  if (!shouldSample('refusal').sampled) return;
  const ev: RefusalEvent = {
    refusal_id: randomUUID(),
    trace_id: ctx.trace_id,
    refusal_type: opts.refusal_type,
    reason: opts.reason,
    evidence_json: opts.evidence ? JSON.stringify(opts.evidence) : undefined,
    calibration_score: opts.calibration_score,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'refusal', payload: ev });
}

export function recordConflict(opts: {
  member_ids: string[];
  resolution: string;
  asof?: string;
  surfaced: boolean;
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) return;
  if (!shouldSample('conflict').sampled) return;
  const ev: ConflictEvent = {
    conflict_set_id: randomUUID(),
    trace_id: ctx.trace_id,
    member_ids_json: JSON.stringify(opts.member_ids),
    resolution: opts.resolution,
    asof: opts.asof,
    surfaced: opts.surfaced,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'conflict', payload: ev });
}

export function recordLlmCall(opts: {
  provider: string;
  model: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  latency_ms?: number;
  cache_hit?: boolean;
  retry_count?: number;
  status: LlmCallEvent['status'];
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!ctx || !storage || !storage.isEnabled()) return;
  const isSlow = (opts.latency_ms ?? 0) > 2000;
  if (!shouldSample('llm_call', { isSlow }).sampled) return;
  const ev: LlmCallEvent = {
    call_id: randomUUID(),
    trace_id: ctx.trace_id,
    span_id: ctx.span_stack[ctx.span_stack.length - 1],
    provider: opts.provider,
    model: opts.model,
    tokens_in: opts.tokens_in,
    tokens_out: opts.tokens_out,
    cost_usd: opts.cost_usd,
    latency_ms: opts.latency_ms,
    cache_hit: opts.cache_hit ?? false,
    retry_count: opts.retry_count ?? 0,
    status: opts.status,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'llm_call', payload: ev });
}

export function recordCacheEvent(opts: { cache_name: string; event: CacheEvent['event']; key_excerpt?: string }): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return;
  const isSlow = opts.event === 'evict' || opts.event === 'invalidate';
  if (!shouldSample('cache_event', { isSlow }).sampled) return;
  const ev: CacheEvent = {
    event_id: randomUUID(),
    trace_id: ctx?.trace_id,
    cache_name: opts.cache_name,
    event: opts.event,
    key_excerpt: opts.key_excerpt,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'cache_event', payload: ev });
}

export function recordError(opts: {
  error_type: string;
  message?: string;
  stack_trace?: string;
  endpoint?: string;
  user_id?: string;
  tags?: Tags;
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return;
  if (!shouldSample('error').sampled) return;
  const ev: ErrorEvent = {
    error_id: randomUUID(),
    trace_id: ctx?.trace_id,
    span_id: ctx?.span_stack[ctx.span_stack.length - 1],
    error_type: opts.error_type,
    message: opts.message,
    stack_trace: opts.stack_trace,
    endpoint: opts.endpoint,
    user_id: opts.user_id ?? ctx?.user_id,
    tags: opts.tags,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'error', payload: ev });
}

/** Cap stored bodies; anything larger is truncated and flagged. */
const BODY_CAPTURE_MAX_CHARS = 16_384;

/**
 * C-14/WC-11: the ONLY sanctioned emitter for body events. Request/response
 * bodies never reach the telemetry DB except through this function, which
 * always passes them through redactObject() first; there is deliberately
 * no raw-body path.
 *
 * Gated on TELEMETRY_BODY_CAPTURE via the strict offByDefault() parse
 * (capture only when the env var is exactly 'true'). The config-schema
 * field still uses z.coerce.boolean(), which mis-parses 'false' as true;
 * packet WC-1 fixes that schema-wide. Reading through flag-defaults.ts
 * here keeps capture semantics correct now and identical after WC-1.
 */
export function recordBody(opts: { kind: BodyEvent['kind']; body: unknown }): void {
  if (!offByDefault(process.env.TELEMETRY_BODY_CAPTURE)) return;
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return;
  if (!shouldSample('body_capture').sampled) return;
  let body_json = JSON.stringify(redactObject(opts.body)) ?? 'null';
  const truncated = body_json.length > BODY_CAPTURE_MAX_CHARS;
  if (truncated) body_json = body_json.slice(0, BODY_CAPTURE_MAX_CHARS);
  const ev: BodyEvent = {
    body_id: randomUUID(),
    trace_id: ctx?.trace_id ?? randomUUID(),
    kind: opts.kind,
    body_json,
    truncated,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'body', payload: ev });
}

/**
 * B1a: record a retrieval event for the offline weight tuner.
 *
 * `candidates` is the post-rank top-K (caller chooses K, defaults to 50
 * via the helper). Each entry carries the score breakdown so the analyzer
 * can correlate per-component contribution with downstream reuse.
 *
 * Returns the generated retrieval_id so a subsequent recordInjection
 * call can link to it. No-ops + returns null when telemetry is disabled.
 */
export function recordRetrieval(opts: {
  query: string;
  query_type: string;
  user_id: string;
  conversation_id?: string;
  candidates: Array<{
    id: string;
    claim_excerpt: string;
    finalScore: number;
    breakdown: Record<string, number>;
  }>;
  candidates_total: number;
  weights: Record<string, number>;
  duration_ms: number;
}): string | null {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return null;
  if (!shouldSample('retrieval').sampled) return null;
  const retrieval_id = randomUUID();
  const trace_id = ctx?.trace_id ?? randomUUID();
  // Truncate the query for storage; full hash retained for cross-event joins.
  const truncatedQuery = opts.query.length > 500 ? opts.query.slice(0, 500) : opts.query;
  const query_sha = createHash('sha256').update(opts.query).digest('hex');
  const ev: RetrievalEvent = {
    retrieval_id,
    trace_id,
    query: truncatedQuery,
    query_sha,
    query_type: opts.query_type,
    user_id: opts.user_id,
    conversation_id: opts.conversation_id,
    candidates_json: JSON.stringify(opts.candidates),
    candidates_total: opts.candidates_total,
    weights_json: JSON.stringify(opts.weights),
    duration_ms: opts.duration_ms,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'retrieval', payload: ev });
  return retrieval_id;
}

/**
 * B1a: record an injection event correlated to a prior recordRetrieval.
 * `retrieval_id` is the value returned by recordRetrieval.
 */
export function recordInjection(opts: {
  retrieval_id: string;
  injected_ids: string[];
  injected_token_estimate?: number;
  budget_dropped: number;
}): void {
  const ctx = _als.getStore();
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return;
  if (!shouldSample('injection').sampled) return;
  const ev: InjectionEvent = {
    injection_id: randomUUID(),
    trace_id: ctx?.trace_id ?? randomUUID(),
    retrieval_id: opts.retrieval_id,
    injected_ids_json: JSON.stringify(opts.injected_ids),
    injected_count: opts.injected_ids.length,
    injected_token_estimate: opts.injected_token_estimate,
    budget_dropped: opts.budget_dropped,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'injection', payload: ev });
}

/** Set tags on the active trace. No-op if no trace is active. */
export function setTraceTags(tags: Tags): void {
  const ctx = _als.getStore();
  if (!ctx) return;
  ctx.tags = { ...ctx.tags, ...tags };
}

/** Set user_id on the active trace (when available late, e.g. post-auth). */
export function setTraceUserId(user_id: string): void {
  const ctx = _als.getStore();
  if (!ctx) return;
  ctx.user_id = user_id;
}
