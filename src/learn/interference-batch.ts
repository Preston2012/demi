import type { IMemoryRepository } from '../repository/interface.js';
import { AuditAction } from '../schema/audit.js';
import { createLogger } from '../config.js';

const log = createLogger('interference');

/**
 * Interference-based forgetting: move stale, low-access memories
 * to cold storage. Not deletion. Resurrection query can bring them back.
 *
 * Criteria for cold storage:
 * - Not frozen (user explicitly preserved)
 * - Not permanent (earned their spot)
 * - Last accessed > threshold days ago
 * - Access count below threshold
 * - Not inhibitory (suppressors stay active)
 */

export interface InterferenceConfig {
  staleDays: number;
  minAccessCount: number;
  batchLimit: number;
}

const DEFAULT_CONFIG: InterferenceConfig = {
  staleDays: 60,
  minAccessCount: 3,
  batchLimit: 50,
};

export async function runInterferenceBatch(
  repo: IMemoryRepository,
  config: Partial<InterferenceConfig> = {},
): Promise<{ movedToCold: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const cutoffDate = new Date(Date.now() - cfg.staleDays * 24 * 60 * 60 * 1000).toISOString();

  let movedToCold = 0;

  // Iterate through active memories looking for cold storage candidates
  for await (const record of repo.exportAll()) {
    if (movedToCold >= cfg.batchLimit) break;
    if (record.interferenceStatus !== 'active') continue;
    if (record.isFrozen) continue;
    if (record.permanenceStatus === 'permanent') continue;
    if (record.isInhibitory) continue;
    if (record.accessCount >= cfg.minAccessCount) continue;
    if (record.lastAccessed > cutoffDate) continue;

    await repo.moveToColdStorage(record.id);
    await repo.appendAuditLog({
      memoryId: record.id,
      action: AuditAction.MOVED_TO_COLD,
      details: `Stale: ${record.accessCount} accesses, last accessed ${record.lastAccessed}`,
    });

    movedToCold++;
  }

  log.info({ movedToCold }, 'Interference batch complete');
  return { movedToCold };
}
