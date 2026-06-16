/**
 * Wedge 2 (S74): assertion_triples backfill.
 *
 * Walks `memories` rows and emits triples for any assertion that doesn't
 * already have them. Used by `scripts/migrate-assertion-triples.ts` (the
 * one-shot CLI) and exercised by tests so the same logic is what's
 * actually run in prod.
 *
 * Idempotent: rows already present in `assertion_triples` are skipped.
 * `forceRewrite` deletes-then-reinserts for matched memories, only used
 * after a deliberate grammar expansion in src/plan/triples.ts.
 *
 * Does not write embeddings, does not call any LLM. Pure decompose + insert.
 */

import type { IMemoryRepository } from '../repository/interface.js';
import { decomposeClaim, computeConflictAnchor } from './triples.js';

export interface BackfillOptions {
  /** Actually write. False = dry-run that returns the plan stats. */
  apply: boolean;
  /** Delete existing triples for matched assertions before reinserting. */
  forceRewrite: boolean;
  /** Per-batch progress callback. Optional. */
  onProgress?: (scanned: number, total: number) => void;
  /** How often `onProgress` fires. */
  batchSize?: number;
}

export interface BackfillStats {
  total: number;
  scanned: number;
  skippedExisting: number;
  written: number;
  triplesWritten: number;
  fallbackRows: number;
  patternRows: number;
}

interface MemoryRow {
  id: string;
  claim: string;
  subject: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number | null;
  conflicts_with: string;
}

interface RawDbHandle {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number };
  };
}

/**
 * Run the backfill against the repository. The function reaches through
 * the sqlite seam to iterate memories rows by SQL, which is faster than
 * paging through a public API and matches the one-shot admin context.
 * Triple writes go through `repo.insertTriples` so the same atomicity
 * guarantees apply.
 */
export async function backfillTriples(repo: IMemoryRepository, opts: BackfillOptions): Promise<BackfillStats> {
  const batchSize = opts.batchSize ?? 500;
  const db = (repo as unknown as { getDb?(): RawDbHandle }).getDb?.();
  if (!db) {
    throw new Error('backfillTriples requires a repository that exposes getDb() (Sqlite impl).');
  }

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL`).all()[0] as {
    n: number;
  };
  const total = totalRow.n;

  const selectStmt = db.prepare(
    `SELECT id, claim, subject, valid_from, valid_to, confidence, conflicts_with
       FROM memories
       WHERE deleted_at IS NULL
       ORDER BY created_at ASC`,
  );

  const stats: BackfillStats = {
    total,
    scanned: 0,
    skippedExisting: 0,
    written: 0,
    triplesWritten: 0,
    fallbackRows: 0,
    patternRows: 0,
  };

  for (const raw of selectStmt.all() as MemoryRow[]) {
    stats.scanned += 1;
    const existing = await repo.hasTriplesForAssertion(raw.id);
    if (existing && !opts.forceRewrite) {
      stats.skippedExisting += 1;
      if (stats.scanned % batchSize === 0) opts.onProgress?.(stats.scanned, total);
      continue;
    }

    const conflictsWith = safeParseUuidArray(raw.conflicts_with);
    const anchor = computeConflictAnchor(raw.id, conflictsWith);
    const triples = decomposeClaim(raw.claim, raw.subject, {
      assertion_id: raw.id,
      valid_from: raw.valid_from,
      valid_to: raw.valid_to,
      confidence: raw.confidence,
      conflict_set_id: anchor,
    });

    if (opts.apply) {
      if (existing && opts.forceRewrite) {
        db.prepare(`DELETE FROM assertion_triples WHERE assertion_id = ?`).run(raw.id);
      }
      await repo.insertTriples(raw.id, triples);
    }

    stats.written += 1;
    stats.triplesWritten += triples.length;
    for (const t of triples) {
      if (t.predicate === null) stats.fallbackRows += 1;
      else stats.patternRows += 1;
    }

    if (stats.scanned % batchSize === 0) opts.onProgress?.(stats.scanned, total);
  }

  return stats;
}

function safeParseUuidArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed;
    return [];
  } catch {
    return [];
  }
}
