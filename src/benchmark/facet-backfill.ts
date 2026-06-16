/**
 * Facet Backfill: populate fact_facets for all existing facts in the database.
 * Used during benchmark seeding after facts are loaded but before episodes are built.
 */

import type { IMemoryRepository } from '../repository/interface.js';

/**
 * Backfill facets for all facts in the database.
 * Iterates all records and calls repo.populateFacets on each.
 */
export async function backfillFacets(repo: IMemoryRepository): Promise<number> {
  let count = 0;
  for await (const record of repo.exportAll()) {
    try {
      await repo.populateFacets(record);
      count++;
    } catch (err) {
      console.error(`Facet backfill failed for ${record.id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return count;
}
