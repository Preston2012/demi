/**
 * Packet C3 / Bug 3: persona retrieval boost.
 *
 * Pull all memories tagged `persona = 1` for the user and emit them as
 * ScoredCandidates with a fixed lexical-score boost. The merge layer in
 * `src/retrieval/index.ts` then unions these into the candidate pool, so
 * persona facts surface on adjacent and orthogonal queries (e.g. "what
 * should I have for dinner" surfaces "I am vegetarian").
 *
 * Cheap: a single indexed query on `(user_id, persona)`. No LLM, no
 * embedding round-trip.
 *
 * S67: collapsed N+1, was running ONE indexed scan to get IDs, then a
 * per-ID `repo.getById()` await loop. Now we batch with `repo.getByIds()`
 * (single IN-clause query) which is cheaper for any limit > 1.
 */

import type Database from 'better-sqlite3-multiple-ciphers';
import type { IMemoryRepository } from '../repository/interface.js';
import type { ScoredCandidate } from '../schema/memory.js';

const PERSONA_BOOST_SCORE = 0.6;

export async function fetchPersonaCandidates(
  repo: IMemoryRepository,
  userId: string,
  limit: number = 16,
): Promise<ScoredCandidate[]> {
  const dbAccessor = (repo as { getDatabase?: () => Database.Database }).getDatabase;
  if (!dbAccessor) return [];
  const db = dbAccessor.call(repo);

  // Step 1: cheap indexed scan for persona IDs only, no SELECT * since we'll
  // re-hydrate via repo.getByIds (which uses the canonical rowToRecord).
  const idRows = db
    .prepare(
      `SELECT id FROM memories
       WHERE persona = 1
         AND user_id = ?
         AND deleted_at IS NULL
         AND trust_class != 'rejected'
       ORDER BY confidence DESC, last_accessed DESC
       LIMIT ?`,
    )
    .all(userId, limit) as Array<{ id: string }>;

  if (idRows.length === 0) return [];

  // Step 2: single batched fetch instead of N awaited getById calls.
  const records = await repo.getByIds(
    idRows.map((r) => r.id),
    userId,
  );

  return records.map((record) => ({
    id: record.id,
    record,
    lexicalScore: PERSONA_BOOST_SCORE,
    vectorScore: 0,
    source: 'fts' as const,
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  }));
}
