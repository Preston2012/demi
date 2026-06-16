import type { IMemoryRepository } from '../repository/interface.js';
import { createLogger } from '../config.js';

const logger = createLogger('circuit-breaker');

export interface CircuitBreaker {
  /** Check if injection is locked due to inactivity. */
  isLocked(): Promise<boolean>;
  /** Record activity (write or confirm). Resets the timer. */
  recordActivity(): Promise<void>;
  /** Get days since last activity. */
  daysSinceLastActivity(): Promise<number>;
}

export interface CircuitBreakerConfig {
  /** Days of inactivity before locking injection. Default 30. */
  lockAfterDays: number;
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  lockAfterDays: 30,
};

export function createCircuitBreaker(
  repo: IMemoryRepository,
  config: Partial<CircuitBreakerConfig> = {},
): CircuitBreaker {
  const cfg = { ...DEFAULT_CB_CONFIG, ...config };

  return {
    async isLocked(): Promise<boolean> {
      const days = await this.daysSinceLastActivity();
      const locked = days >= cfg.lockAfterDays;
      if (locked) {
        logger.warn(
          `Circuit breaker LOCKED: ${days} days since last activity (threshold: ${cfg.lockAfterDays})`,
        );
      }
      return locked;
    },

    async recordActivity(): Promise<void> {
      await repo.setMetadata('last_activity', new Date().toISOString());
      logger.debug('Activity recorded, circuit breaker reset');
    },

    async daysSinceLastActivity(): Promise<number> {
      const lastActivity = await repo.getMetadata('last_activity');
      if (!lastActivity) return Infinity;

      const lastDate = new Date(lastActivity);
      if (isNaN(lastDate.getTime())) return Infinity;

      return (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    },
  };
}
