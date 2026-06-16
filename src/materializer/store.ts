/**
 * Wedge 3: materializations row CRUD.
 *
 * Single-row PK lookup on cache_key for the hot read path; insert wraps
 * the JSON serialization of assertions + adjudication_state. Access stats
 * (hit_count, last_accessed_at) are updated fire-and-forget after the
 * projection has been returned, so the lock-criterion p95 < 5ms on cache
 * hits isn't dominated by an UPDATE that competes with WAL fsync.
 */

import type Database from 'better-sqlite3-multiple-ciphers';

import type { ExtractedClaim } from '../extract/index.js';

import type { AdjudicationResult } from './types.js';

export interface MaterializationRow {
  cacheKey: string;
  policyId: string;
  stoneWindowStart: number | null;
  stoneWindowEnd: number | null;
  conversationId: string | null;
  asofAnchor: string | null;
  assertions: ExtractedClaim[];
  adjudicationState: AdjudicationResult;
  costUsd: number;
  createdAt: string;
  lastAccessedAt: string;
  hitCount: number;
  staleAt: string | null;
}

interface DbRow {
  cache_key: string;
  policy_id: string;
  stone_window_start: number | null;
  stone_window_end: number | null;
  conversation_id: string | null;
  asof_anchor: string | null;
  assertions: string;
  adjudication_state: string;
  cost_usd: number;
  created_at: string;
  last_accessed_at: string;
  hit_count: number;
  stale_at: string | null;
}

function rowToMaterialization(row: DbRow): MaterializationRow {
  return {
    cacheKey: row.cache_key,
    policyId: row.policy_id,
    stoneWindowStart: row.stone_window_start,
    stoneWindowEnd: row.stone_window_end,
    conversationId: row.conversation_id,
    asofAnchor: row.asof_anchor,
    assertions: JSON.parse(row.assertions) as ExtractedClaim[],
    adjudicationState: JSON.parse(row.adjudication_state) as AdjudicationResult,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    hitCount: row.hit_count,
    staleAt: row.stale_at,
  };
}

export function getMaterialization(db: Database.Database, cacheKey: string): MaterializationRow | null {
  const row = db
    .prepare(
      'SELECT cache_key, policy_id, stone_window_start, stone_window_end, conversation_id, asof_anchor, assertions, adjudication_state, cost_usd, created_at, last_accessed_at, hit_count, stale_at FROM materializations WHERE cache_key = ?',
    )
    .get(cacheKey) as DbRow | undefined;
  return row ? rowToMaterialization(row) : null;
}

export interface InsertMaterializationInput {
  cacheKey: string;
  policyId: string;
  conversationId: string;
  stoneWindowStart: number;
  stoneWindowEnd: number;
  asofAnchor: string;
  assertions: ExtractedClaim[];
  adjudicationState: AdjudicationResult;
  costUsd?: number;
}

/**
 * Insert a fresh row. Returns true on success, false if the row already
 * existed (PK collision -- harmless race: another caller materialized the
 * same key concurrently and won).
 */
export function insertMaterialization(db: Database.Database, input: InsertMaterializationInput): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      'INSERT OR IGNORE INTO materializations (cache_key, policy_id, stone_window_start, stone_window_end, conversation_id, asof_anchor, assertions, adjudication_state, cost_usd, created_at, last_accessed_at, hit_count, stale_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)',
    )
    .run(
      input.cacheKey,
      input.policyId,
      input.stoneWindowStart,
      input.stoneWindowEnd,
      input.conversationId,
      input.asofAnchor,
      JSON.stringify(input.assertions),
      JSON.stringify(input.adjudicationState),
      input.costUsd ?? 0,
      now,
      now,
    );
  return result.changes > 0;
}

/**
 * Bump hit_count and last_accessed_at for a cache-hit row. Fire-and-forget:
 * the caller has already returned the projection; this write is for
 * downstream diagnostics, not for correctness. Eventual consistency on
 * hit_count is documented and acceptable.
 */
export function touchMaterialization(db: Database.Database, cacheKey: string): void {
  setImmediate(() => {
    try {
      const now = new Date().toISOString();
      db.prepare('UPDATE materializations SET hit_count = hit_count + 1, last_accessed_at = ? WHERE cache_key = ?').run(
        now,
        cacheKey,
      );
    } catch {
      // Diagnostic-only update. Swallow: a failed touchup must never break
      // the user-facing read path.
    }
  });
}
