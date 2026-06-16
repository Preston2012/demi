/**
 * Wedge 1.5 Phase 1: telemetry storage layer.
 *
 * Ring-buffer event writer with async batch flush. Hot path adds ~1μs
 * (push to ring buffer), not 100μs (synchronous DB insert).
 *
 * Lifecycle:
 *   1. enqueue(event), hot path, lock-free push to ring buffer
 *   2. Background timer flushes every flushIntervalMs OR when ring is half-full
 *   3. flush(), drains ring, batches by table, single transaction per flush
 *   4. close(), final flush, stop timer, close DB
 *
 * When TELEMETRY_ENABLED=false, no DB is opened and no buffer is allocated.
 * Every enqueue call is a no-op. Zero overhead.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TelemetryEvent } from './types.js';
import { runTelemetryMigrations } from './migrations.js';

/** Storage configuration. */
export interface StorageConfig {
  dbPath: string;
  enabled: boolean;
  flushIntervalMs: number;
  ringBufferSize: number;
  /**
   * W4.5: when set (64-char hex), the telemetry DB is opened with SQLCipher
   * pragmas matching the memory repo's S50 dialect. Sourced from the same
   * `config.dbEncryptionKey` the memory repo uses; the boot wiring passes it
   * through when VAULT_DB_ENCRYPTION_ENABLED=true.
   */
  dbEncryptionKey?: string;
}

/**
 * TelemetryStorage owns the SQLite handle and the ring buffer.
 * Single instance per process. Acquired via getStorage().
 */
export class TelemetryStorage {
  private db: Database.Database | null = null;
  private buffer: TelemetryEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private config: StorageConfig;
  private flushing = false;
  private droppedCount = 0;
  private insertFailures: Record<string, number> = {};
  private loggedKinds: Set<string> = new Set();

  // Prepared statements (built lazily on first flush after migrations).
  private stmts: Record<string, Database.Statement> | null = null;

  constructor(config: StorageConfig) {
    this.config = config;
    if (config.enabled) {
      this.open();
    }
  }

  /** Open the DB, run migrations, start the flush timer. */
  private open(): void {
    if (this.db) return;
    // Ensure parent directory exists.
    try {
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
    } catch {
      // dir exists or no permission; let Database open() report
    }
    this.db = new Database(this.config.dbPath);
    // W4.5: SQLCipher pragmas BEFORE any other pragma or DDL, matching the
    // S50 dialect used by the memory repo (`cipher_compatibility = 4` +
    // `key = "x'...'"`). :memory: telemetry DBs ignore encryption.
    if (this.config.dbEncryptionKey && this.config.dbPath !== ':memory:') {
      this.db.pragma(`key = "x'${this.config.dbEncryptionKey}'"`);
      this.db.pragma('cipher_compatibility = 4');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    runTelemetryMigrations(this.db);
    this.prepareStatements();
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Swallow flush errors to keep telemetry from breaking the engine.
        // Real errors are logged in flush() itself.
      });
    }, this.config.flushIntervalMs);
    // Allow Node to exit even if flushTimer is pending.
    this.flushTimer.unref();
  }

  /** Build prepared INSERT statements for each event table. */
  private prepareStatements(): void {
    if (!this.db) return;
    this.stmts = {
      trace: this.db.prepare(`
        INSERT OR REPLACE INTO traces
        (trace_id, entry, started_at, ended_at, duration_ms, status, user_id, conversation_id, request_size_bytes, response_size_bytes, error_type, tags)
        VALUES (@trace_id, @entry, @started_at, @ended_at, @duration_ms, @status, @user_id, @conversation_id, @request_size_bytes, @response_size_bytes, @error_type, @tags)
      `),
      span: this.db.prepare(`
        INSERT OR REPLACE INTO spans
        (span_id, trace_id, parent_span_id, name, started_at, duration_ms, tags)
        VALUES (@span_id, @trace_id, @parent_span_id, @name, @started_at, @duration_ms, @tags)
      `),
      decision: this.db.prepare(`
        INSERT OR REPLACE INTO decisions
        (decision_id, trace_id, span_id, decision_type, branch_taken, inputs_json, confidence, outcome, duration_ms, created_at)
        VALUES (@decision_id, @trace_id, @span_id, @decision_type, @branch_taken, @inputs_json, @confidence, @outcome, @duration_ms, @created_at)
      `),
      conflict: this.db.prepare(`
        INSERT OR REPLACE INTO conflicts
        (conflict_set_id, trace_id, member_ids_json, resolution, asof, surfaced, created_at)
        VALUES (@conflict_set_id, @trace_id, @member_ids_json, @resolution, @asof, @surfaced, @created_at)
      `),
      refusal: this.db.prepare(`
        INSERT OR REPLACE INTO refusals
        (refusal_id, trace_id, refusal_type, reason, evidence_json, calibration_score, created_at)
        VALUES (@refusal_id, @trace_id, @refusal_type, @reason, @evidence_json, @calibration_score, @created_at)
      `),
      llm_call: this.db.prepare(`
        INSERT OR REPLACE INTO llm_calls
        (call_id, trace_id, span_id, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, cache_hit, retry_count, status, created_at)
        VALUES (@call_id, @trace_id, @span_id, @provider, @model, @tokens_in, @tokens_out, @cost_usd, @latency_ms, @cache_hit, @retry_count, @status, @created_at)
      `),
      cache_event: this.db.prepare(`
        INSERT OR REPLACE INTO cache_events
        (event_id, trace_id, cache_name, event, key_excerpt, created_at)
        VALUES (@event_id, @trace_id, @cache_name, @event, @key_excerpt, @created_at)
      `),
      auth_event: this.db.prepare(`
        INSERT OR REPLACE INTO auth_events
        (auth_id, trace_id, event, user_id, endpoint, reason, ip_excerpt, created_at)
        VALUES (@auth_id, @trace_id, @event, @user_id, @endpoint, @reason, @ip_excerpt, @created_at)
      `),
      rate_limit_event: this.db.prepare(`
        INSERT OR REPLACE INTO rate_limit_events
        (rl_id, trace_id, user_id, endpoint, action, current_count, limit_value, created_at)
        VALUES (@rl_id, @trace_id, @user_id, @endpoint, @action, @current_count, @limit_value, @created_at)
      `),
      error: this.db.prepare(`
        INSERT OR REPLACE INTO errors
        (error_id, trace_id, span_id, error_type, message, stack_trace, endpoint, user_id, tags, created_at)
        VALUES (@error_id, @trace_id, @span_id, @error_type, @message, @stack_trace, @endpoint, @user_id, @tags, @created_at)
      `),
      deprecation: this.db.prepare(`
        INSERT OR REPLACE INTO deprecation_events
        (dep_id, trace_id, event_type, target, source_file, created_at)
        VALUES (@dep_id, @trace_id, @event_type, @target, @source_file, @created_at)
      `),
      body: this.db.prepare(`
        INSERT OR REPLACE INTO bodies
        (body_id, trace_id, kind, body_json, truncated, created_at)
        VALUES (@body_id, @trace_id, @kind, @body_json, @truncated, @created_at)
      `),
      // B1a: retrieval + injection capture for the weight tuner.
      retrieval: this.db.prepare(`
        INSERT OR REPLACE INTO retrievals
        (retrieval_id, trace_id, query, query_sha, query_type, user_id, conversation_id,
         candidates_json, candidates_total, weights_json, duration_ms, created_at)
        VALUES (@retrieval_id, @trace_id, @query, @query_sha, @query_type, @user_id, @conversation_id,
                @candidates_json, @candidates_total, @weights_json, @duration_ms, @created_at)
      `),
      injection: this.db.prepare(`
        INSERT OR REPLACE INTO injections
        (injection_id, trace_id, retrieval_id, injected_ids_json, injected_count,
         injected_token_estimate, budget_dropped, created_at)
        VALUES (@injection_id, @trace_id, @retrieval_id, @injected_ids_json, @injected_count,
                @injected_token_estimate, @budget_dropped, @created_at)
      `),
    };
  }

  /**
   * Push an event to the ring buffer. Hot path. No I/O.
   *
   * If the buffer is full, increment droppedCount and discard. We choose
   * loss-of-newest over loss-of-oldest because dropping arrivals is cheaper
   * and the lost events are most likely to be redundant (same trace as
   * earlier buffered events).
   */
  enqueue(event: TelemetryEvent): void {
    if (!this.config.enabled || !this.db) return;
    if (this.buffer.length >= this.config.ringBufferSize) {
      this.droppedCount++;
      return;
    }
    this.buffer.push(event);
    // Eager flush when half-full to bound write latency on busy hosts.
    if (this.buffer.length >= this.config.ringBufferSize / 2) {
      // Don't await; fire-and-forget.
      this.flush().catch(() => undefined);
    }
  }

  /**
   * Drain the ring buffer and batch-insert into telemetry.db.
   * Single transaction per flush. Reentrancy-safe (early return if a flush
   * is already in flight).
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.db || !this.stmts) return;
    if (this.buffer.length === 0) return;

    this.flushing = true;
    try {
      // Snapshot + clear so new arrivals don't block this flush.
      const batch = this.buffer;
      this.buffer = [];

      const tx = this.db.transaction(() => {
        for (const event of batch) {
          try {
            const stmt = this.stmts![event.kind];
            if (!stmt) continue;
            // Normalize boolean to 0/1 for SQLite columns.
            const row = normalizeForSqlite(event.payload as unknown as Record<string, unknown>);
            stmt.run(row);
          } catch (err) {
            // Telemetry must never crash the engine, but Phase 2 burned a
            // day on a silently-swallowed insert error. Track per-kind
            // failure counts and emit ONE warn per kind so the next
            // schema/payload mismatch is loud.
            this.insertFailures[event.kind] = (this.insertFailures[event.kind] ?? 0) + 1;
            if (!this.loggedKinds.has(event.kind)) {
              this.loggedKinds.add(event.kind);
              const msg = err instanceof Error ? err.message : String(err);
              // eslint-disable-next-line no-console
              console.warn(`[telemetry] insert failure (kind=${event.kind}): ${msg}`);
            }
          }
        }
      });
      tx();
    } finally {
      this.flushing = false;
    }
  }

  /** Number of dropped events (ring buffer overflow). For health checks. */
  getDroppedCount(): number {
    return this.droppedCount;
  }

  /** Per-kind insert failure counts. Surfaces silent-swallow scenarios. */
  getInsertFailures(): Record<string, number> {
    return { ...this.insertFailures };
  }

  /** Number of events currently buffered (not yet flushed). */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /** Is telemetry actively writing? */
  isEnabled(): boolean {
    return this.config.enabled && this.db !== null;
  }

  /** DB path for read-only query connections. Phase 3 query layer uses this. */
  getDbPath(): string | null {
    if (!this.config.enabled) return null;
    return this.config.dbPath;
  }

  /** Final flush + close. Idempotent. */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.db) {
      try {
        this.flush().catch(() => undefined);
        this.db.close();
      } catch {
        // closing best-effort
      }
      this.db = null;
    }
  }
}

/**
 * Convert a TS payload to a SQLite-binding-friendly row.
 * - Boolean → 0/1
 * - undefined → null (better-sqlite3 expects null for NULL columns)
 * - Tags object → JSON string
 */
function normalizeForSqlite(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) {
      out[k] = null;
    } else if (typeof v === 'boolean') {
      out[k] = v ? 1 : 0;
    } else if (k === 'tags' && typeof v === 'object' && v !== null) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Singleton storage instance management.
// ---------------------------------------------------------------------------

let _storage: TelemetryStorage | null = null;

/**
 * Initialize the singleton storage. Called once at process startup
 * from the public telemetry entry point. Idempotent.
 */
export function initStorage(config: StorageConfig): TelemetryStorage {
  if (_storage) return _storage;
  _storage = new TelemetryStorage(config);
  return _storage;
}

/** Return the singleton storage, or null if uninitialized. */
export function getStorage(): TelemetryStorage | null {
  return _storage;
}

/** Reset the singleton (test-only). */
export function resetStorage(): void {
  if (_storage) {
    _storage.close();
  }
  _storage = null;
}

/** Generate a UUIDv4. Helper for callers that don't want to import crypto. */
export function newUuid(): string {
  return randomUUID();
}
