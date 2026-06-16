/**
 * Wedge 1.5 Phase 1: telemetry primitive types.
 *
 * Public interface for the telemetry module. All other modules
 * (trace, storage, sampling) import from here.
 *
 * Design notes:
 *   - All IDs are UUIDv4 strings, generated lazily at event creation.
 *   - Timestamps are ISO 8601 strings (matches existing demiurge convention).
 *   - Durations are integer milliseconds.
 *   - Tags are arbitrary JSON-serializable objects, stored as TEXT in SQLite.
 *   - Status fields use string literal unions, not enums, for forward-compat
 *     (new branches can be added without enum churn).
 */

/** ISO 8601 timestamp in UTC. */
export type IsoTimestamp = string;

/** UUIDv4 string. */
export type Uuid = string;

/** Tags are arbitrary structured data attached to spans/events. */
export type Tags = Record<string, string | number | boolean | null>;

/**
 * Top-level trace covering a single request from entry to flush.
 */
export interface Trace {
  trace_id: Uuid;
  entry: 'mcp' | 'rest' | 'bench' | 'cli' | 'internal';
  started_at: IsoTimestamp;
  ended_at?: IsoTimestamp;
  duration_ms?: number;
  status?: 'ok' | 'error' | 'partial';
  user_id?: string;
  conversation_id?: string;
  request_size_bytes?: number;
  response_size_bytes?: number;
  error_type?: string;
  tags?: Tags;
}

/**
 * Operation span. Nests under a trace, optionally under a parent span.
 */
export interface Span {
  span_id: Uuid;
  trace_id: Uuid;
  parent_span_id?: Uuid;
  name: string;
  started_at: IsoTimestamp;
  duration_ms: number;
  tags?: Tags;
}

/**
 * Branching decision (Adjudicator-precursor sites).
 */
export interface DecisionEvent {
  decision_id: Uuid;
  trace_id: Uuid;
  span_id?: Uuid;
  decision_type:
    | 'detect_injection'
    | 'trust_branch'
    | 'dedup_check'
    | 'consensus_aggregate'
    | 'conflict_surface'
    | 'budget_filter'
    | 'refusal_evaluate'
    | 'temporal_resolver'
    | 'query_classify'
    | 'router_answer_model'
    | 'cache_lookup'
    | 'provider_failover'
    | 'cell_primary_used'
    | 'query_route_cell'
    | 'warming_cycle'
    | 'plan_executor'
    | 'materializer.adjudication'
    | 'vault_encrypt'
    | 'vault_decrypt_refused'
    | 'vault_injection_caught_unencrypted'
    | 'read_injection_l2'
    | 'read_injection_l3'
    | 'read_defense_null_stub';
  branch_taken: string;
  inputs_json?: string;
  confidence?: number;
  outcome?: string;
  duration_ms?: number;
  created_at: IsoTimestamp;
}

export interface ConflictEvent {
  conflict_set_id: Uuid;
  trace_id: Uuid;
  member_ids_json: string;
  resolution: string;
  asof?: IsoTimestamp;
  surfaced: boolean;
  created_at: IsoTimestamp;
}

export interface RefusalEvent {
  refusal_id: Uuid;
  trace_id: Uuid;
  refusal_type: string;
  reason: string;
  evidence_json?: string;
  calibration_score?: number;
  created_at: IsoTimestamp;
}

export interface LlmCallEvent {
  call_id: Uuid;
  trace_id: Uuid;
  span_id?: Uuid;
  provider: string;
  model: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  latency_ms?: number;
  cache_hit: boolean;
  retry_count: number;
  status: 'ok' | 'error' | 'timeout' | 'rate_limited';
  created_at: IsoTimestamp;
}

export interface CacheEvent {
  event_id: Uuid;
  trace_id?: Uuid;
  cache_name: string;
  event: 'hit' | 'miss' | 'stale' | 'evict' | 'invalidate';
  key_excerpt?: string;
  created_at: IsoTimestamp;
}

export interface AuthEvent {
  auth_id: Uuid;
  trace_id?: Uuid;
  event: 'success' | 'missing_token' | 'invalid_token' | 'wrong_scope' | 'expired';
  user_id?: string;
  endpoint?: string;
  reason?: string;
  ip_excerpt?: string;
  created_at: IsoTimestamp;
}

export interface RateLimitEvent {
  rl_id: Uuid;
  trace_id?: Uuid;
  user_id: string;
  endpoint?: string;
  action: 'allowed' | 'throttled' | 'blocked';
  current_count?: number;
  limit_value?: number;
  created_at: IsoTimestamp;
}

export interface ErrorEvent {
  error_id: Uuid;
  trace_id?: Uuid;
  span_id?: Uuid;
  error_type: string;
  message?: string;
  stack_trace?: string;
  endpoint?: string;
  user_id?: string;
  tags?: Tags;
  created_at: IsoTimestamp;
}

export interface DeprecationEvent {
  dep_id: Uuid;
  trace_id?: Uuid;
  event_type: 'env_read' | 'flag_toggle' | 'migration_run' | 'endpoint_hit';
  target: string;
  source_file?: string;
  created_at: IsoTimestamp;
}

export interface BodyEvent {
  body_id: Uuid;
  trace_id: Uuid;
  kind: 'request' | 'response';
  body_json: string;
  truncated: boolean;
  created_at: IsoTimestamp;
}

/**
 * B1a: per-retrieval event. Captures the candidate-scoring breakdown the
 * weight tuner joins against follow-up turns. `query` is truncated to
 * 500 chars for storage; `query_sha` is the full sha256 so the analyzer
 * can match repeated queries even when truncation collides.
 */
export interface RetrievalEvent {
  retrieval_id: Uuid;
  trace_id: Uuid;
  query: string;
  query_sha: string;
  query_type: string;
  user_id: string;
  conversation_id?: string;
  /** JSON array of {id, claim_excerpt, finalScore, breakdown}. Top-K only (default 50). */
  candidates_json: string;
  /** Total candidates the ranker considered, before truncation for storage. */
  candidates_total: number;
  /** Effective ScoringWeights for this retrieval (JSON). */
  weights_json: string;
  duration_ms: number;
  created_at: IsoTimestamp;
}

/**
 * B1a: per-injection event. The survivors that actually made it into the
 * LLM prompt. The retrieval_id FK lets the analyzer find which candidates
 * were promoted to the prompt vs. dropped by budget compilation.
 */
export interface InjectionEvent {
  injection_id: Uuid;
  trace_id: Uuid;
  retrieval_id: Uuid;
  /** JSON array of memory IDs that made it into the prompt. */
  injected_ids_json: string;
  injected_count: number;
  /** Token estimate from the S4 budget compiler, when available. */
  injected_token_estimate?: number;
  /** Number of candidates dropped by the budget compiler. */
  budget_dropped: number;
  created_at: IsoTimestamp;
}

/** Union of all event types the writer can flush. */
export type TelemetryEvent =
  | { kind: 'trace'; payload: Trace }
  | { kind: 'span'; payload: Span }
  | { kind: 'decision'; payload: DecisionEvent }
  | { kind: 'conflict'; payload: ConflictEvent }
  | { kind: 'refusal'; payload: RefusalEvent }
  | { kind: 'llm_call'; payload: LlmCallEvent }
  | { kind: 'cache_event'; payload: CacheEvent }
  | { kind: 'auth_event'; payload: AuthEvent }
  | { kind: 'rate_limit_event'; payload: RateLimitEvent }
  | { kind: 'error'; payload: ErrorEvent }
  | { kind: 'deprecation'; payload: DeprecationEvent }
  | { kind: 'body'; payload: BodyEvent }
  | { kind: 'retrieval'; payload: RetrievalEvent }
  | { kind: 'injection'; payload: InjectionEvent };

/** Sampling decision result. */
export interface SamplingDecision {
  sampled: boolean;
  rate: number;
  reason?: string;
}
