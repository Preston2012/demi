import type { IMemoryRepository } from '../repository/interface.js';
import type { MemoryRecord } from '../schema/memory.js';
import { createLogger } from '../config.js';

const logger = createLogger('review-queue');

export interface ReviewDecision {
  memoryId: string;
  action: 'promote' | 'reject';
  reason?: string;
}

export interface ReviewQueueService {
  getPending(limit?: number): Promise<MemoryRecord[]>;
  decide(decision: ReviewDecision): Promise<void>;
  sampleForSpotCheck(memories: MemoryRecord[], rate?: number): MemoryRecord[];
}

export function createReviewQueue(repo: IMemoryRepository): ReviewQueueService {
  return {
    async getPending(limit = 50): Promise<MemoryRecord[]> {
      const results = await repo.getPendingReview(limit);
      logger.debug(`Fetched ${results.length} pending reviews`);
      return results;
    },

    async decide(decision: ReviewDecision): Promise<void> {
      const { memoryId, action, reason } = decision;
      const memory = await repo.getById(memoryId);
      if (!memory) {
        throw new Error(`Memory not found: ${memoryId}`);
      }

      if (memory.reviewStatus !== 'pending') {
        throw new Error(
          `Memory ${memoryId} is not pending review (status: ${memory.reviewStatus})`,
        );
      }

      await repo.update(memoryId, {
        reviewStatus: action === 'promote' ? 'approved' : 'rejected',
        trustClass: action === 'promote' ? 'confirmed' : 'rejected',
        updatedAt: new Date().toISOString(),
      });
      logger.info(
        `Review decision: ${action} on ${memoryId}${reason ? ` (${reason})` : ''}`,
      );
    },

    sampleForSpotCheck(memories: MemoryRecord[], rate = 0.1): MemoryRecord[] {
      return memories.filter(() => Math.random() < rate);
    },
  };
}
