/**
 * W4 Track A: subject-scoped prior-memories fetch for the adjudicator hook.
 *
 * Owned by the materializer module because:
 *   1. The materializer already binds the DB handle via bindMaterializer().
 *      Doing the fetch here lets every adjudicator implementation receive
 *      pre-fetched data instead of reimplementing timeout + cache + error
 *      swallowing per adjudicator.
 *   2. The materializer's `span('materializer.cold_read')` already wraps
 *      the adjudication region, so this fetch's latency rolls into the
 *      existing cold-read p95 budget naturally.
 *   3. Per design §3, the adjudicator only needs read-only top-K access
 *      scoped to (user_id, subject). It does NOT need a full repo handle.
 *      Pre-fetching keeps the surface narrow.
 *
 * v1 contract per W4 Track A design §3:
 *   - Cap K at 5 memories
 *   - 50ms hard timeout, swallow on miss (return empty)
 *   - Scope by user_id + subject (exact match) + deleted_at IS NULL
 *   - Order by valid_from DESC NULLS LAST so most-recent context wins
 *   - Index used: idx_memories_user_subject (user_id, subject) WHERE deleted_at IS NULL
 *
 * Future v1.1: optional FTS5 fallback when exact subject match returns
 * < K rows. v1 keeps exact-match-only for predictability and to avoid
 * surfacing semantically-adjacent-but-unrelated subjects to the
 * adjudicator. The teacher prompt is calibrated assuming exact-subject
 * results; loose-matching would change the calibration target.
 *
 * Failure modes (all return empty list, NEVER throw to caller):
 *   - DB not bound: defensive empty (called outside materializer ctx)
 *   - SQL error: recordError + empty
 *   - Timeout exceeded: recordError + empty
 *   - subject is empty string: empty (no scope to query against)
 *   - userId is undefined: empty (no partition scope; per repo doctrine
 *     queries without user_id are silently empty rather than leaking
 *     cross-tenant data)
 */

import type Database from 'better-sqlite3-multiple-ciphers';

import { recordError } from '../telemetry/index.js';

/** Single prior-memory result row. Minimal projection, only what the
 *  adjudicator prompt needs. Expanded fields (trust_class, confidence)
 *  are NOT included; the adjudicator should not condition on storage
 *  metadata, only on claim content + temporal anchor. */
export interface PriorMemoryRow {
  claim: string;
  subject: string;
  valid_from: string | null;
}

export interface FetchPriorMemoriesOpts {
  /** Per-call timeout in milliseconds. Default 50ms per design §3. */
  timeoutMs?: number;
  /** Max rows to return. Default 5 per design §3. */
  limit?: number;
}

/**
 * Race a SQLite query against a wall-clock timeout. better-sqlite3 is
 * synchronous, so the "timeout" cannot preempt an in-flight query; what
 * it does is bound the materializer's perception of how long it waited
 * before falling back to empty. If a query genuinely takes longer than
 * the budget, the row data still arrives, but we do not use it.
 *
 * This matters because adjudicator latency is on the write path and we
 * would rather degrade `contradicts_existing` recall than block ingest
 * for tens of milliseconds on a slow disk.
 */
function raceWithTimeout<T>(fn: () => T, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    // Run synchronously on next microtask so the setTimeout has a chance
    // to register before we block on better-sqlite3.
    Promise.resolve().then(() => {
      if (settled) return;
      try {
        const result = fn();
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(result);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        recordError({
          error_type: 'materializer.prior_memories_db_error',
          message: err instanceof Error ? err.message : String(err),
          tags: { source: 'prior-memories' },
        });
        resolve(onTimeout());
      }
    });
  });
}

/**
 * Fetch up to K prior memories matching (user_id, subject) for the
 * adjudicator. Always returns an array. NEVER throws.
 *
 * Caller (materialize()) supplies a pre-bound `db` handle. If the
 * subject is empty or userId undefined, returns [] without touching
 * the DB.
 */
export async function fetchPriorMemoriesForSubject(
  db: Database.Database,
  userId: string | undefined,
  subject: string,
  opts: FetchPriorMemoriesOpts = {},
): Promise<PriorMemoryRow[]> {
  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? 50;

  if (!userId || !subject || subject.length === 0) return [];

  const t0 = Date.now();
  const rows = await raceWithTimeout<PriorMemoryRow[]>(
    () => {
      // Use the existing composite index idx_memories_user_subject
      // (user_id, subject) WHERE deleted_at IS NULL. NULLS LAST handled
      // by COALESCE so valid_from-less memories sort to the end without
      // requiring SQLite NULLS LAST syntax (not portable across all
      // SQLite versions).
      const stmt = db.prepare(`
        SELECT claim, subject, valid_from
        FROM memories
        WHERE user_id = ?
          AND subject = ?
          AND deleted_at IS NULL
        ORDER BY COALESCE(valid_from, '0000') DESC, created_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, subject, limit) as PriorMemoryRow[];
    },
    timeoutMs,
    () => {
      const dt = Date.now() - t0;
      // Only record a timeout if we actually exceeded the budget; this
      // path also catches the DB-error branch (raceWithTimeout calls
      // onTimeout on error too), so guard with the latency check.
      if (dt >= timeoutMs) {
        recordError({
          error_type: 'materializer.prior_memories_timeout',
          message: `fetchPriorMemoriesForSubject exceeded ${timeoutMs}ms (${dt}ms elapsed)`,
          tags: { source: 'prior-memories', user_id: userId, subject },
        });
      }
      return [];
    },
  );

  return rows;
}
