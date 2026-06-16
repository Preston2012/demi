/**
 * Packet A: per-query entity boost (Mem0 source-cited).
 *
 * Reference: mem0/memory/main.py:1440-1499
 *   boost = sim × W × (1 / (1 + 0.001 × (n−1)²))
 * where:
 *   sim         = similarity between query entity and stored entity (1.0 for exact match)
 *   W           = entityBoostWeight (cap 0.5 per Mem0)
 *   n           = number of memories linked to that entity (degree → attenuation)
 *
 * Entity matches are aggregated max-pooled per memory (best-of any entity hit).
 * Returns Map<memoryId, boost>. Empty Map if disabled or no query entities.
 */

import type Database from 'better-sqlite3-multiple-ciphers';

export interface EntityBoostConfig {
  enabled: boolean;
  boostWeight: number;
  maxEntities: number;
}

export function computeEntityBoosts(
  db: Database.Database,
  queryEntities: string[],
  userId: string,
  config: EntityBoostConfig,
): Map<string, number> {
  const boosts = new Map<string, number>();
  if (!config.enabled || queryEntities.length === 0) return boosts;

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const e of queryEntities) {
    const k = (e || '').trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      deduped.push(k);
      if (deduped.length >= config.maxEntities) break;
    }
  }
  if (deduped.length === 0) return boosts;

  const stmt = db.prepare(
    `SELECT memory_id, COUNT(*) OVER (PARTITION BY entity_text) AS num_linked
     FROM entity_index WHERE entity_text = ? AND user_id = ?`,
  );

  for (const ent of deduped) {
    const rows = stmt.all(ent, userId) as Array<{ memory_id: string; num_linked: number }>;
    for (const r of rows) {
      const n = Math.max(r.num_linked, 1);
      const att = 1.0 / (1.0 + 0.001 * Math.pow(n - 1, 2));
      const boost = 1.0 * config.boostWeight * att;
      const prev = boosts.get(r.memory_id) ?? 0;
      if (boost > prev) boosts.set(r.memory_id, boost);
    }
  }
  return boosts;
}

/**
 * Regex-only entity extraction: capitalized words and capitalized multi-word phrases.
 * No LLM. Matches the packet's spec.
 */
export function extractQueryEntities(query: string): string[] {
  if (!query) return [];
  return query.match(/[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*/g) || [];
}
