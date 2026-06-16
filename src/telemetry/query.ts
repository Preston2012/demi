/**
 * Wedge 1.5 Phase 3: telemetry query layer.
 *
 * Read-side counterpart to storage.ts. CLI and REST admin both consume from
 * here. Each call opens its own read-only better-sqlite3 handle to avoid
 * lock contention with the writer.
 *
 * All queries respect a TimeWindow (since/until/limit). Defaults: last 24h,
 * up to 1000 rows, hard cap 10000.
 *
 * When telemetry is disabled (TELEMETRY_ENABLED=false) every function
 * short-circuits to an empty result (or a zero-filled struct, for the
 * Prometheus gauges).
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { getStorage } from './storage.js';

export interface TimeWindow {
  since?: string;
  until?: string;
  limit?: number;
}

export interface TraceRow {
  trace_id: string;
  entry: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string | null;
  user_id: string | null;
  conversation_id: string | null;
  error_type: string | null;
}

export interface DecisionRow {
  decision_id: string;
  trace_id: string;
  decision_type: string;
  branch_taken: string;
  confidence: number | null;
  outcome: string | null;
  created_at: string;
}

export interface RefusalRow {
  refusal_id: string;
  trace_id: string;
  refusal_type: string;
  reason: string;
  calibration_score: number | null;
  created_at: string;
}

export interface CostRollup {
  provider: string;
  model: string;
  calls: number;
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  latency_ms_mean: number;
  cache_hit_rate: number;
}

export interface ErrorRow {
  error_id: string;
  trace_id: string | null;
  error_type: string;
  message: string | null;
  endpoint: string | null;
  user_id: string | null;
  created_at: string;
}

export interface CacheHitRate {
  cache_name: string;
  hits: number;
  misses: number;
  hit_rate: number | null;
}

export interface RateLimitSummary {
  user_id: string;
  allowed: number;
  throttled: number;
  blocked: number;
}

export interface PromGauges {
  traces_total: number;
  errors_total: number;
  refusals_total: number;
  conflicts_total: number;
  rate_limit_throttled_total: number;
  llm_calls_total: number;
  llm_cost_usd_24h: number;
  request_duration_ms_p50: number;
  request_duration_ms_p95: number;
  request_duration_ms_p99: number;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function openReadDb(): Database.Database | null {
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return null;
  const dbPath = storage.getDbPath();
  if (!dbPath) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function openWriteDb(): Database.Database | null {
  const storage = getStorage();
  if (!storage) return null;
  const dbPath = storage.getDbPath();
  if (!dbPath) return null;
  try {
    return new Database(dbPath);
  } catch {
    return null;
  }
}

function resolveLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function windowClause(window: TimeWindow, column: string): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const since = window.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
  params.since = since;
  let sql = `${column} >= @since`;
  if (window.until) {
    params.until = window.until;
    sql += ` AND ${column} <= @until`;
  }
  return { sql, params };
}

export function queryTraces(window: TimeWindow = {}): TraceRow[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'started_at');
    const limit = resolveLimit(window.limit);
    // A6: bind LIMIT via parameter instead of interpolation. resolveLimit
    // already clamps to a sane integer range, but the parameterized form
    // is the structurally safe pattern, one careless future caller and
    // the interpolated form becomes SQLi.
    const rows = db
      .prepare(
        `SELECT trace_id, entry, started_at, ended_at, duration_ms, status,
                user_id, conversation_id, error_type
         FROM traces
         WHERE ${w.sql}
         ORDER BY started_at DESC
         LIMIT @limit`,
      )
      .all({ ...w.params, limit }) as TraceRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryDecisions(window: TimeWindow & { decision_type?: string } = {}): DecisionRow[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const limit = resolveLimit(window.limit);
    const params: Record<string, string | number> = { ...w.params, limit };
    let extra = '';
    if (window.decision_type) {
      params.decision_type = window.decision_type;
      extra = ' AND decision_type = @decision_type';
    }
    const rows = db
      .prepare(
        `SELECT decision_id, trace_id, decision_type, branch_taken, confidence, outcome, created_at
         FROM decisions
         WHERE ${w.sql}${extra}
         ORDER BY created_at DESC
         LIMIT @limit`,
      )
      .all(params) as DecisionRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryRefusals(window: TimeWindow = {}): RefusalRow[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const limit = resolveLimit(window.limit);
    const rows = db
      .prepare(
        `SELECT refusal_id, trace_id, refusal_type, reason, calibration_score, created_at
         FROM refusals
         WHERE ${w.sql}
         ORDER BY created_at DESC
         LIMIT @limit`,
      )
      .all({ ...w.params, limit }) as RefusalRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryCostByProvider(window: TimeWindow = {}): CostRollup[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const rows = db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS calls,
                COALESCE(SUM(tokens_in), 0) AS tokens_in_total,
                COALESCE(SUM(tokens_out), 0) AS tokens_out_total,
                COALESCE(SUM(cost_usd), 0) AS cost_usd_total,
                COALESCE(AVG(latency_ms), 0) AS latency_ms_mean,
                COALESCE(AVG(CAST(cache_hit AS REAL)), 0) AS cache_hit_rate
         FROM llm_calls
         WHERE ${w.sql}
         GROUP BY provider, model
         ORDER BY cost_usd_total DESC`,
      )
      .all(w.params) as CostRollup[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryErrors(window: TimeWindow & { error_type?: string } = {}): ErrorRow[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const limit = resolveLimit(window.limit);
    const params: Record<string, string | number> = { ...w.params, limit };
    let extra = '';
    if (window.error_type) {
      params.error_type = window.error_type;
      extra = ' AND error_type = @error_type';
    }
    const rows = db
      .prepare(
        `SELECT error_id, trace_id, error_type, message, endpoint, user_id, created_at
         FROM errors
         WHERE ${w.sql}${extra}
         ORDER BY created_at DESC
         LIMIT @limit`,
      )
      .all(params) as ErrorRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryCacheHitRates(window: TimeWindow = {}): CacheHitRate[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const rows = db
      .prepare(
        `SELECT cache_name,
                SUM(CASE WHEN event='hit' THEN 1 ELSE 0 END) AS hits,
                SUM(CASE WHEN event='miss' THEN 1 ELSE 0 END) AS misses,
                CAST(SUM(CASE WHEN event='hit' THEN 1 ELSE 0 END) AS REAL)
                  / NULLIF(SUM(CASE WHEN event IN ('hit','miss') THEN 1 ELSE 0 END), 0) AS hit_rate
         FROM cache_events
         WHERE ${w.sql}
         GROUP BY cache_name
         ORDER BY cache_name`,
      )
      .all(w.params) as CacheHitRate[];
    return rows;
  } finally {
    db.close();
  }
}

export function queryRateLimitSummary(window: TimeWindow = {}): RateLimitSummary[] {
  const db = openReadDb();
  if (!db) return [];
  try {
    const w = windowClause(window, 'created_at');
    const rows = db
      .prepare(
        `SELECT user_id,
                SUM(CASE WHEN action='allowed' THEN 1 ELSE 0 END) AS allowed,
                SUM(CASE WHEN action='throttled' THEN 1 ELSE 0 END) AS throttled,
                SUM(CASE WHEN action='blocked' THEN 1 ELSE 0 END) AS blocked
         FROM rate_limit_events
         WHERE ${w.sql}
         GROUP BY user_id
         ORDER BY (SUM(CASE WHEN action='throttled' THEN 1 ELSE 0 END)
                   + SUM(CASE WHEN action='blocked' THEN 1 ELSE 0 END)) DESC
         LIMIT 100`,
      )
      .all(w.params) as RateLimitSummary[];
    return rows;
  } finally {
    db.close();
  }
}

function zeroGauges(): PromGauges {
  return {
    traces_total: 0,
    errors_total: 0,
    refusals_total: 0,
    conflicts_total: 0,
    rate_limit_throttled_total: 0,
    llm_calls_total: 0,
    llm_cost_usd_24h: 0,
    request_duration_ms_p50: 0,
    request_duration_ms_p95: 0,
    request_duration_ms_p99: 0,
  };
}

export function queryPromGauges(): PromGauges {
  const db = openReadDb();
  if (!db) return zeroGauges();
  try {
    const since = new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
    const params = { since };
    const tracesRow = db.prepare(`SELECT COUNT(*) AS n FROM traces WHERE started_at >= @since`).get(params) as {
      n: number;
    };
    const errorsRow = db.prepare(`SELECT COUNT(*) AS n FROM errors WHERE created_at >= @since`).get(params) as {
      n: number;
    };
    const refusalsRow = db.prepare(`SELECT COUNT(*) AS n FROM refusals WHERE created_at >= @since`).get(params) as {
      n: number;
    };
    const conflictsRow = db.prepare(`SELECT COUNT(*) AS n FROM conflicts WHERE created_at >= @since`).get(params) as {
      n: number;
    };
    const rlThrottledRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM rate_limit_events
         WHERE created_at >= @since AND action IN ('throttled', 'blocked')`,
      )
      .get(params) as { n: number };
    const llmCallsRow = db.prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE created_at >= @since`).get(params) as {
      n: number;
    };
    const llmCostRow = db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE created_at >= @since`)
      .get(params) as { cost: number };

    const durations = db
      .prepare(
        `SELECT duration_ms FROM traces
         WHERE started_at >= @since AND duration_ms IS NOT NULL
         ORDER BY duration_ms ASC`,
      )
      .all(params) as Array<{ duration_ms: number }>;

    function pct(p: number): number {
      if (durations.length === 0) return 0;
      const idx = Math.min(durations.length - 1, Math.floor(durations.length * p));
      return durations[idx]!.duration_ms;
    }

    return {
      traces_total: tracesRow.n,
      errors_total: errorsRow.n,
      refusals_total: refusalsRow.n,
      conflicts_total: conflictsRow.n,
      rate_limit_throttled_total: rlThrottledRow.n,
      llm_calls_total: llmCallsRow.n,
      llm_cost_usd_24h: llmCostRow.cost,
      request_duration_ms_p50: pct(0.5),
      request_duration_ms_p95: pct(0.95),
      request_duration_ms_p99: pct(0.99),
    };
  } catch {
    return zeroGauges();
  } finally {
    db.close();
  }
}

export function pruneOlderThan(retentionDays: number): { rows_deleted: Record<string, number> } {
  const db = openWriteDb();
  if (!db) return { rows_deleted: {} };
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const tables = [
      { table: 'spans', column: 'started_at' },
      { table: 'decisions', column: 'created_at' },
      { table: 'conflicts', column: 'created_at' },
      { table: 'refusals', column: 'created_at' },
      { table: 'llm_calls', column: 'created_at' },
      { table: 'cache_events', column: 'created_at' },
      { table: 'auth_events', column: 'created_at' },
      { table: 'rate_limit_events', column: 'created_at' },
      { table: 'errors', column: 'created_at' },
      { table: 'deprecation_events', column: 'created_at' },
      { table: 'bodies', column: 'created_at' },
      { table: 'traces', column: 'started_at' },
    ];
    const rows_deleted: Record<string, number> = {};
    for (const { table, column } of tables) {
      const info = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
      rows_deleted[table] = info.changes;
    }
    return { rows_deleted };
  } finally {
    db.close();
  }
}
