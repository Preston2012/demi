import { z } from 'zod';

export const AuditAction = {
  CREATED: 'created',
  UPDATED: 'updated',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  QUARANTINED: 'quarantined',
  DELETED: 'deleted',
  SUPERSEDED: 'superseded',
  ACCESSED: 'accessed',
  CIRCUIT_BREAKER_LOCKED: 'circuit-breaker-locked',
  CIRCUIT_BREAKER_UNLOCKED: 'circuit-breaker-unlocked',
  SPOT_CHECK_FLAGGED: 'spot-check-flagged',
  CONSENSUS_REQUESTED: 'consensus-requested',
  CONSENSUS_COMPLETED: 'consensus-completed',
  EXPORT: 'export',
  BACKUP: 'backup',
  FROZEN: 'frozen',
  UNFROZEN: 'unfrozen',
  MOVED_TO_COLD: 'moved-to-cold',
  RESURRECTED: 'resurrected',
  HUB_CREATED: 'hub-created',
  HUB_LINKED: 'hub-linked',
  HUB_UNLINKED: 'hub-unlinked',
  VERSION_CREATED: 'version-created',
  CONSTRAINT_ADDED: 'constraint-added',
  CONSTRAINT_DEACTIVATED: 'constraint-deactivated',
  SELF_PLAY_STARTED: 'self-play-started',
  SELF_PLAY_COMPLETED: 'self-play-completed',
  CORRECTION: 'correction',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditActionSchema = z.enum([
  AuditAction.CREATED,
  AuditAction.UPDATED,
  AuditAction.CONFIRMED,
  AuditAction.REJECTED,
  AuditAction.QUARANTINED,
  AuditAction.DELETED,
  AuditAction.SUPERSEDED,
  AuditAction.ACCESSED,
  AuditAction.CIRCUIT_BREAKER_LOCKED,
  AuditAction.CIRCUIT_BREAKER_UNLOCKED,
  AuditAction.SPOT_CHECK_FLAGGED,
  AuditAction.CONSENSUS_REQUESTED,
  AuditAction.CONSENSUS_COMPLETED,
  AuditAction.EXPORT,
  AuditAction.BACKUP,
  AuditAction.FROZEN,
  AuditAction.UNFROZEN,
  AuditAction.MOVED_TO_COLD,
  AuditAction.RESURRECTED,
  AuditAction.HUB_CREATED,
  AuditAction.HUB_LINKED,
  AuditAction.HUB_UNLINKED,
  AuditAction.VERSION_CREATED,
  AuditAction.CONSTRAINT_ADDED,
  AuditAction.CONSTRAINT_DEACTIVATED,
  AuditAction.SELF_PLAY_STARTED,
  AuditAction.SELF_PLAY_COMPLETED,
  AuditAction.CORRECTION,
]);

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  memoryId: z.string().uuid().nullable(),
  action: AuditActionSchema,
  details: z.string().max(2000).nullable(),
  previousHash: z.string().nullable(),
  hash: z.string(),
  timestamp: z.string().datetime({ offset: true }),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Fields needed to create a new audit entry.
 * id, hash, previousHash, and timestamp are computed at write time.
 */
export interface NewAuditEntry {
  memoryId: string | null;
  action: AuditAction;
  details: string | null;
}
