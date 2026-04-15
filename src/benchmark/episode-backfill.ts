/**
 * Episode Backfill: build episodes from all existing facts in the database.
 * Used during benchmark seeding after facts are loaded and facets populated.
 * 
 * Requires: EPISODES_ENABLED=true, facts seeded, facets backfilled.
 */

import type Database from 'better-sqlite3';
import { buildAllEpisodes } from '../write/episodes.js';

/**
 * Build episodes for all facts in the database.
 * Returns the number of episodes created.
 */
export async function backfillEpisodes(
  db: Database.Database,
  apiKey: string | undefined,
): Promise<number> {
  const episodes = await buildAllEpisodes(db, apiKey);
  return episodes.length;
}
