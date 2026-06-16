/**
 * Wedge 1.5 Phase 1: telemetry.db schema migrations.
 *
 * Separate SQLite file from the main memory DB. Append-heavy workload,
 * so a separate file means zero contention with memory reads.
 *
 * Migrations are linear, no rollback. Each run is idempotent (CREATE TABLE
 * IF NOT EXISTS, ALTER TABLE inside pragma checks). Safe to run on every
 * boot of the telemetry storage layer.
 */

import type Database from 'better-sqlite3-multiple-ciphers';

/**
 * Run all telemetry schema migrations on the given database handle.
 *
 * Phase 1 v1: creates the 12 tables that Phase 2 will populate.
 *   - traces, spans (request/operation trees)
 *   - decisions (branching choices)
 *   - conflicts, refusals (Adjudicator-precursor surfaces)
 *   - llm_calls, cache_events (cost + perf)
 *   - auth_events, rate_limit_events (security)
 *   - errors (unhandled + caught-notable)
 *   - deprecation_events (env reads, flag toggles, migration runs)
 *   - bodies (sampled request/response capture)
 */
export function runTelemetryMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      entry TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      status TEXT,
      user_id TEXT,
      conversation_id TEXT,
      request_size_bytes INTEGER,
      response_size_bytes INTEGER,
      error_type TEXT,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_id TEXT,
      decision_type TEXT NOT NULL,
      branch_taken TEXT NOT NULL,
      inputs_json TEXT,
      confidence REAL,
      outcome TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      conflict_set_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      resolution TEXT NOT NULL,
      asof TEXT,
      surfaced INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refusals (
      refusal_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      refusal_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT,
      calibration_score REAL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      call_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      latency_ms INTEGER,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cache_events (
      event_id TEXT PRIMARY KEY,
      trace_id TEXT,
      cache_name TEXT NOT NULL,
      event TEXT NOT NULL,
      key_excerpt TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      auth_id TEXT PRIMARY KEY,
      trace_id TEXT,
      event TEXT NOT NULL,
      user_id TEXT,
      endpoint TEXT,
      reason TEXT,
      ip_excerpt TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limit_events (
      rl_id TEXT PRIMARY KEY,
      trace_id TEXT,
      user_id TEXT NOT NULL,
      endpoint TEXT,
      action TEXT NOT NULL,
      current_count INTEGER,
      limit_value INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS errors (
      error_id TEXT PRIMARY KEY,
      trace_id TEXT,
      span_id TEXT,
      error_type TEXT NOT NULL,
      message TEXT,
      stack_trace TEXT,
      endpoint TEXT,
      user_id TEXT,
      tags TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deprecation_events (
      dep_id TEXT PRIMARY KEY,
      trace_id TEXT,
      event_type TEXT NOT NULL,
      target TEXT NOT NULL,
      source_file TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bodies (
      body_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- B1a: per-retrieval event for the offline weight tuner.
    CREATE TABLE IF NOT EXISTS retrievals (
      retrieval_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      query TEXT NOT NULL,
      query_sha TEXT NOT NULL,
      query_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      candidates_json TEXT NOT NULL,
      candidates_total INTEGER NOT NULL,
      weights_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- B1a: per-injection event. FK retrieval_id back-links to the
    -- retrieval that produced these candidates.
    CREATE TABLE IF NOT EXISTS injections (
      injection_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      retrieval_id TEXT NOT NULL,
      injected_ids_json TEXT NOT NULL,
      injected_count INTEGER NOT NULL,
      injected_token_estimate INTEGER,
      budget_dropped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Indices for time-based queries (CLI + admin REST)
    CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
    CREATE INDEX IF NOT EXISTS idx_traces_user ON traces(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(decision_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_decisions_trace ON decisions(trace_id);
    CREATE INDEX IF NOT EXISTS idx_conflicts_trace ON conflicts(trace_id);
    CREATE INDEX IF NOT EXISTS idx_refusals_trace ON refusals(trace_id);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_trace ON llm_calls(trace_id);
    CREATE INDEX IF NOT EXISTS idx_cache_events_name ON cache_events(cache_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_auth_events_event ON auth_events(event, created_at);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_user ON rate_limit_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_errors_type ON errors(error_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_deprecations_type ON deprecation_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_bodies_trace ON bodies(trace_id);
    CREATE INDEX IF NOT EXISTS idx_retrievals_conv ON retrievals(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_retrievals_qtype ON retrievals(query_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_retrievals_qsha ON retrievals(query_sha);
    CREATE INDEX IF NOT EXISTS idx_injections_retrieval ON injections(retrieval_id);
  `);
}

/**
 * Prune events older than `retentionDays`. Run via cron.
 * Idempotent; safe to call repeatedly.
 */
export function pruneOldEvents(db: Database.Database, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // A6: parameterize the cutoff via prepare/run instead of interpolating
  // the ISO string into the SQL text. The previous form was technically
  // safe (cutoff is internally derived from retentionDays, not user
  // input), but it was a SQLi-shape footgun, one careless future caller
  // and the interpolated form becomes exploitable. The DELETEs run in
  // child-first order so foreign-key references resolve before parents
  // disappear; that ordering is preserved here.
  const prune = (sql: string) => db.prepare(sql).run(cutoff);
  prune(`DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE started_at < ?)`);
  // B1a: child-first, injections reference retrievals.
  prune(`DELETE FROM injections WHERE retrieval_id IN (SELECT retrieval_id FROM retrievals WHERE created_at < ?)`);
  prune(`DELETE FROM retrievals WHERE created_at < ?`);
  prune(`DELETE FROM decisions WHERE created_at < ?`);
  prune(`DELETE FROM conflicts WHERE created_at < ?`);
  prune(`DELETE FROM refusals WHERE created_at < ?`);
  prune(`DELETE FROM llm_calls WHERE created_at < ?`);
  prune(`DELETE FROM cache_events WHERE created_at < ?`);
  prune(`DELETE FROM auth_events WHERE created_at < ?`);
  prune(`DELETE FROM rate_limit_events WHERE created_at < ?`);
  prune(`DELETE FROM errors WHERE created_at < ?`);
  prune(`DELETE FROM deprecation_events WHERE created_at < ?`);
  prune(`DELETE FROM bodies WHERE created_at < ?`);
  prune(`DELETE FROM traces WHERE started_at < ?`);
}
