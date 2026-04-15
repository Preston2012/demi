/**
 * Episode Injection: format episodes for context injection.
 * 
 * Double-gated:
 * 1. Query type must be NARRATIVE, TEMPORAL, or SYNTHESIS
 * 2. Cosine similarity between query and episode summary must exceed threshold
 * 
 * Flag: EPISODES_ENABLED=true
 */

import type Database from 'better-sqlite3';

import { createLogger } from '../config.js';

const log = createLogger('inject-episodes');

const DEFAULT_COSINE_THRESHOLD = 0.6;

export interface InjectedEpisode {
  id: string;
  subject: string;
  title: string;
  summary: string;
  timeframe_start: string | null;
  timeframe_end: string | null;
  fact_claims: string[];
  cosine_score: number;
}

/**
 * Search episode_vec for episodes matching the query embedding.
 */
export function searchEpisodeVec(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number = 10,
): Array<{ id: string; score: number }> {
  try {
    const rows = db.prepare(`
      SELECT id, distance FROM episode_vec
      WHERE embedding MATCH ?
      ORDER BY distance ASC
      LIMIT ?
    `).all(new Float32Array(queryEmbedding), limit) as Array<{ id: string; distance: number }>;

    // sqlite-vec returns L2 distance. Convert to cosine-like score (1 - normalized distance)
    return rows.map(r => ({
      id: r.id,
      score: 1 - (r.distance / 2), // Approximate cosine from L2 for normalized vectors
    }));
  } catch (err) {
    log.warn({ err }, 'Episode vec search failed');
    return [];
  }
}

/**
 * Load full episode data with member fact claims.
 */
function loadEpisode(db: Database.Database, episodeId: string): InjectedEpisode | null {
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as Record<string, unknown> | undefined;
  if (!ep) return null;

  const facts = db.prepare(`
    SELECT m.claim FROM episode_facts ef
    JOIN memories m ON m.id = ef.fact_id
    WHERE ef.episode_id = ?
    ORDER BY ef.ordinal ASC
  `).all(episodeId) as Array<{ claim: string }>;

  return {
    id: ep.id as string,
    subject: ep.subject as string,
    title: ep.title as string,
    summary: ep.summary as string,
    timeframe_start: (ep.timeframe_start as string) || null,
    timeframe_end: (ep.timeframe_end as string) || null,
    fact_claims: facts.map(f => f.claim),
    cosine_score: 0,
  };
}

/**
 * Get episode member fact IDs for candidate pool boosting.
 */
export function getEpisodeMemberFactIds(db: Database.Database, episodeId: string): string[] {
  const rows = db.prepare('SELECT fact_id FROM episode_facts WHERE episode_id = ?').all(episodeId) as Array<{ fact_id: string }>;
  return rows.map(r => r.fact_id);
}

/**
 * Retrieve and filter episodes for injection.
 * Returns episodes that pass the cosine threshold gate.
 */
export function getInjectableEpisodes(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number = 5,
): InjectedEpisode[] {
  const threshold = parseFloat(process.env.EPISODE_COSINE_THRESHOLD || String(DEFAULT_COSINE_THRESHOLD));
  const vecResults = searchEpisodeVec(db, queryEmbedding, limit * 2);

  const episodes: InjectedEpisode[] = [];
  for (const vr of vecResults) {
    if (vr.score < threshold) continue;

    const ep = loadEpisode(db, vr.id);
    if (!ep) continue;

    ep.cosine_score = vr.score;
    episodes.push(ep);
    if (episodes.length >= limit) break;
  }

  log.debug({
    searched: vecResults.length,
    aboveThreshold: episodes.length,
    threshold,
  }, 'Episode injection filtering');

  return episodes;
}

/**
 * Format episodes for injection into context.
 * Returns formatted string to insert into injection payload.
 */
export function formatEpisodesForInjection(episodes: InjectedEpisode[]): string {
  if (episodes.length === 0) return '';

  const lines: string[] = [];
  lines.push('=== EPISODES ===');

  for (const ep of episodes) {
    const timeRange = ep.timeframe_start && ep.timeframe_end
      ? `[${ep.timeframe_start} - ${ep.timeframe_end}]`
      : ep.timeframe_start
        ? `[${ep.timeframe_start}]`
        : '';

    lines.push(`## ${ep.title} ${timeRange}`);
    lines.push(ep.summary);
    if (ep.fact_claims.length > 0) {
      lines.push('Supporting details:');
      for (const claim of ep.fact_claims) {
        lines.push(`- ${claim}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
