import type { IMemoryRepository } from '../repository/interface.js';
import type { MemoryRecord } from '../schema/memory.js';
import { PermanenceStatus } from '../schema/memory.js';
import { AuditAction } from '../schema/audit.js';
import { createLogger } from '../config.js';
import {
  runPromotionConsensus,
  type EvaluatorConfig,
  type PromotionInput,
} from '../write/consensus.js';

const log = createLogger('promotion');

/**
 * Promotion gate: second consensus checkpoint.
 *
 * Memories that prove useful over time (accessed frequently, old enough)
 * face a second multi-model evaluation before earning permanent status.
 * Permanent memories skip decay entirely — they've earned their spot
 * through real usage and multi-model agreement.
 */

export interface PromotionConfig {
  minAccessCount: number;
  minAgeDays: number;
  consensusRequired: boolean;
}

/**
 * Check if a single memory is eligible for promotion review.
 */
export function checkPromotionEligibility(
  record: MemoryRecord,
  config: PromotionConfig,
): boolean {
  // Only provisional memories can be promoted
  if (record.permanenceStatus !== PermanenceStatus.PROVISIONAL) return false;

  // Must be confirmed or auto-approved (not quarantined/rejected)
  if (record.trustClass !== 'confirmed' && record.trustClass !== 'auto-approved') return false;

  // Must have been accessed enough times
  if (record.accessCount < config.minAccessCount) return false;

  // Must be old enough
  const ageMs = Date.now() - new Date(record.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < config.minAgeDays) return false;

  return true;
}

/**
 * Run a promotion batch: find eligible memories and evaluate them.
 * Returns the number of memories processed.
 */
export async function runPromotionBatch(
  repo: IMemoryRepository,
  evaluators: EvaluatorConfig[],
  config: PromotionConfig,
  minAgreement: number = 2,
  batchLimit: number = 10,
): Promise<number> {
  const candidates = await repo.getPromotionCandidates(
    config.minAccessCount,
    config.minAgeDays,
    batchLimit,
  );

  if (candidates.length === 0) {
    log.debug('No promotion candidates found');
    return 0;
  }

  log.info({ count: candidates.length }, 'Processing promotion candidates');

  let processed = 0;

  for (const memory of candidates) {
    try {
      // Mark as promotion-pending
      await repo.update(memory.id, {
        permanenceStatus: PermanenceStatus.PROMOTION_PENDING,
      });

      if (!config.consensusRequired || evaluators.length < 2) {
        // No consensus required — auto-promote
        await repo.update(memory.id, {
          permanenceStatus: PermanenceStatus.PERMANENT,
        });

        await repo.appendAuditLog({
          memoryId: memory.id,
          action: AuditAction.CONFIRMED,
          details: 'Auto-promoted (consensus not required)',
        });

        log.info({ memoryId: memory.id }, 'Memory auto-promoted to permanent');
        processed++;
        continue;
      }

      // Fetch conflicting claims for context
      const conflictClaims: string[] = [];
      if (memory.conflictsWith.length > 0) {
        const conflictRecords = await repo.getByIds(memory.conflictsWith);
        for (const r of conflictRecords) conflictClaims.push(r.claim);
      }

      const promotionInput: PromotionInput = {
        claim: memory.claim,
        subject: memory.subject,
        createdAt: memory.createdAt,
        accessCount: memory.accessCount,
        lastAccessed: memory.lastAccessed,
        trustClass: memory.trustClass,
        conflicts: conflictClaims,
      };

      const result = await runPromotionConsensus(
        promotionInput,
        evaluators,
        minAgreement,
      );

      if (result.decision === 'promote') {
        await repo.update(memory.id, {
          permanenceStatus: PermanenceStatus.PERMANENT,
        });

        await repo.appendAuditLog({
          memoryId: memory.id,
          action: AuditAction.CONFIRMED,
          details: `Promoted to permanent (${result.unanimous ? 'unanimous' : 'majority'})`,
        });

        log.info({ memoryId: memory.id }, 'Memory promoted to permanent');
      } else if (result.decision === 'reject') {
        await repo.update(memory.id, {
          permanenceStatus: PermanenceStatus.PROVISIONAL,
          trustClass: 'rejected',
          reviewStatus: 'rejected',
        });

        await repo.appendAuditLog({
          memoryId: memory.id,
          action: AuditAction.REJECTED,
          details: `Rejected during promotion review (${result.unanimous ? 'unanimous' : 'majority'})`,
        });

        log.info({ memoryId: memory.id }, 'Memory rejected during promotion');
      } else {
        // keep_provisional — revert from promotion-pending
        await repo.update(memory.id, {
          permanenceStatus: PermanenceStatus.PROVISIONAL,
        });

        await repo.appendAuditLog({
          memoryId: memory.id,
          action: AuditAction.CONSENSUS_COMPLETED,
          details: 'Promotion deferred (keep provisional)',
        });

        log.info({ memoryId: memory.id }, 'Memory kept provisional after promotion review');
      }

      processed++;
    } catch (err) {
      // On error, revert to provisional (don't leave in promotion-pending)
      log.error({ err, memoryId: memory.id }, 'Promotion evaluation failed');
      await repo.update(memory.id, {
        permanenceStatus: PermanenceStatus.PROVISIONAL,
      }).catch(() => {});
    }
  }

  return processed;
}
