/**
 * S59 / TEMPR, temporal-range candidate retriever.
 *
 * Given DateBounds extracted from the query (chrono-node), filter memories
 * whose validity interval overlaps the query bounds, fall back to created_at
 * when bi-temporal columns are NULL. Score by inverse distance from query
 * date midpoint (closer-in-time → higher score).
 *
 * Skips entirely when extractDateBounds returns null. RRF treats missing
 * source as 0 contribution (no renormalization).
 *
 * userId is REQUIRED, every SQL touches user_id at the WHERE level so
 * temporal-range cannot leak rows across user partitions.
 */

import type Database from 'better-sqlite3-multiple-ciphers';
import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate, MemoryRecord } from '../schema/memory.js';
import type { DateBounds } from './query-temporal.js';
import { createLogger } from '../config.js';

const log = createLogger('temporal-range');

export async function searchTemporalRange(
  repo: IMemoryRepository,
  bounds: DateBounds,
  limit: number,
  userId: string,
  _nowIso?: string,
): Promise<ScoredCandidate[]> {
  if (!bounds.from && !bounds.to) return [];

  const repoAny = repo as IMemoryRepository & { getDatabase?: () => Database.Database };
  const db = repoAny.getDatabase?.();
  if (!db) return [];

  const fromIso = bounds.from?.toISOString() ?? null;
  const toIso = bounds.to?.toISOString() ?? null;

  // Overlap predicate. We want memories whose [valid_from, valid_to] interval
  // overlaps [bounds.from, bounds.to]. Either side may be NULL.
  //   memory.valid_from <= bounds.to (or bounds.to is NULL → no upper bound)
  //   memory.valid_to   >= bounds.from (or memory.valid_to is NULL → still valid)
  // Fall back to created_at when valid_from is NULL.
  // SQLite parameter handling: explicit NULL checks because @param can be null.
  const stmt = db.prepare(
    `SELECT * FROM memories
      WHERE user_id = @userId
        AND deleted_at IS NULL
        AND trust_class != 'rejected'
        AND (
          /* upper bound: memory start is at or before query end */
          (@toIso IS NULL OR COALESCE(valid_from, created_at) <= @toIso)
        )
        AND (
          /* lower bound: memory end is at or after query start */
          (@fromIso IS NULL OR valid_to IS NULL OR valid_to >= @fromIso)
        )
      ORDER BY COALESCE(valid_from, created_at) DESC
      LIMIT @limit`,
  );

  const rows = stmt.all({ userId, fromIso, toIso, limit }) as Record<string, unknown>[];
  if (rows.length === 0) return [];

  // Score: inverse distance from query midpoint. Bounded interval midpoint
  // is exact; open interval uses the available end as the anchor.
  const midpointMs = computeMidpoint(bounds.from, bounds.to);

  const out: ScoredCandidate[] = [];
  for (const row of rows) {
    const memDateStr = (row.valid_from as string) || (row.created_at as string);
    const memMs = new Date(memDateStr).getTime();
    const distanceDays = Math.abs(memMs - midpointMs) / (1000 * 60 * 60 * 24);
    // Half-life decay: 30 days → 0.5; 60 days → 0.25; 365 days → ~0.001.
    const score = 1 / (1 + distanceDays / 30);
    const record = rowToRecord(row);
    out.push({
      id: record.id,
      record,
      lexicalScore: 0,
      vectorScore: 0,
      temporalScore: score,
      source: 'temporal',
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    });
  }

  // Re-sort by score descending (most-recent ORDER BY may not match midpoint distance).
  out.sort((a, b) => (b.temporalScore ?? 0) - (a.temporalScore ?? 0));

  log.info(
    {
      from: fromIso,
      to: toIso,
      granularity: bounds.granularity,
      returned: out.length,
    },
    'Temporal-range retrieval',
  );
  return out;
}

function computeMidpoint(from?: Date, to?: Date): number {
  if (from && to) return (from.getTime() + to.getTime()) / 2;
  if (from) return from.getTime();
  if (to) return to.getTime();
  return Date.now(); // unreachable given the early-return above
}

/**
 * Minimal row → MemoryRecord mapping for the temporal-range candidate path.
 * Uses the same conventions as SqliteMemoryRepository.rowToRecord but is
 * defined here to avoid exporting the private repo helper. Embeddings are
 * not loaded (cross-encoder reranker recomputes on demand from candidate text).
 */
function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    userId: (row.user_id as string) || 'system',
    externalRef: (row.external_ref as string) || null,
    claim: row.claim as string,
    subject: row.subject as string,
    scope: row.scope as MemoryRecord['scope'],
    validFrom: (row.valid_from as string) || null,
    validTo: (row.valid_to as string) || null,
    provenance: row.provenance as MemoryRecord['provenance'],
    trustClass: row.trust_class as MemoryRecord['trustClass'],
    confidence: row.confidence as number,
    sourceHash: row.source_hash as string,
    supersedes: (row.supersedes as string) || null,
    conflictsWith: JSON.parse((row.conflicts_with as string) || '[]'),
    reviewStatus: row.review_status as MemoryRecord['reviewStatus'],
    accessCount: row.access_count as number,
    lastAccessed: row.last_accessed as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    embedding: null,
    permanenceStatus: (row.permanence_status as MemoryRecord['permanenceStatus']) || 'provisional',
    hubId: (row.hub_id as string) || null,
    hubScore: (row.hub_score as number) ?? 0,
    resolution: (row.resolution as number) ?? 3,
    memoryType: (row.memory_type as MemoryRecord['memoryType']) ?? 'declarative',
    versionNumber: (row.version_number as number) ?? 1,
    parentVersionId: (row.parent_version_id as string) || null,
    frozenAt: (row.frozen_at as string) || null,
    decayScore: (row.decay_score as number) ?? 1,
    storageTier: (row.storage_tier as MemoryRecord['storageTier']) ?? 'active',
    isInhibitory: !!(row.is_inhibitory as number),
    inhibitionTarget: (row.inhibition_target as string) || null,
    interferenceStatus: (row.interference_status as MemoryRecord['interferenceStatus']) ?? 'active',
    correctionCount: (row.correction_count as number) ?? 0,
    isFrozen: !!(row.is_frozen as number),
    causedBy: (row.caused_by as string) || null,
    leadsTo: (row.leads_to as string) || null,
    canonicalFactId: (row.canonical_fact_id as string) || null,
    isCanonical: row.is_canonical === undefined ? true : !!(row.is_canonical as number),
    validAt: (row.valid_at as string) || null,
    invalidAt: (row.invalid_at as string) || null,
    persona: !!(row.persona as number),
    sessionId: (row.session_id as string) || null,
    episodeId: (row.episode_id as string) || null,
  };
}
