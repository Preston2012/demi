import type { IMemoryRepository } from '../repository/interface.js';
import { createLogger } from '../config.js';

const logger = createLogger('decay');

export interface DecayTracker {
  recordAccess(memoryId: string): Promise<void>;
  recordAccessBatch(memoryIds: string[]): Promise<void>;
  computeFreshnessScore(lastAccessed: string, accessCount: number): number;
}

export interface DecayConfig {
  /** Half-life in days. Access count of 0 at this age = 0.5 freshness. Default 30. */
  halfLifeDays: number;
  /** Bonus per access, capped. Default 0.02. */
  accessBonus: number;
  /** Max bonus from access count. Default 0.3. */
  maxAccessBonus: number;
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  accessBonus: 0.02,
  maxAccessBonus: 0.3,
};

export function createDecayTracker(
  repo: IMemoryRepository,
  config: Partial<DecayConfig> = {},
): DecayTracker {
  const cfg = { ...DEFAULT_DECAY_CONFIG, ...config };

  return {
    async recordAccess(memoryId: string): Promise<void> {
      await repo.incrementAccessCount(memoryId);
      logger.debug(`Access recorded: ${memoryId}`);
    },

    async recordAccessBatch(memoryIds: string[]): Promise<void> {
      await Promise.all(memoryIds.map((id) => repo.incrementAccessCount(id)));
      logger.debug(`Batch access recorded: ${memoryIds.length} memories`);
    },

    computeFreshnessScore(lastAccessed: string, accessCount: number): number {
      const lastDate = new Date(lastAccessed);
      if (isNaN(lastDate.getTime())) return 0;

      const ageDays =
        (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 0) return 1;

      const decayFactor = Math.pow(0.5, ageDays / cfg.halfLifeDays);
      const accessBonusValue = Math.min(
        accessCount * cfg.accessBonus,
        cfg.maxAccessBonus,
      );

      return Math.min(decayFactor + accessBonusValue, 1);
    },
  };
}
