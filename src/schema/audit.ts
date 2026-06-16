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
  // B1c: emitted once per boot when WEIGHT_TUNER_AUTO_APPLY=true applies
  // recommendations from the offline analyzer. Details JSON holds the
  // per-component deltas + sample-size/confidence justifications.
  WEIGHT_TUNER_APPLIED: 'weight-tuner-applied',
  // W4.5 Vault subsystem. encrypt / decrypt / delete trace per-secret
  // operations; injection-caught-unencrypted is a loud signal that
  // Position 1 (extraction-time) detection missed a secret that
  // Position 2 (injection-time) caught on read; db-rekey covers
  // operator-driven SQLCipher key rotations; key-source-loaded is
  // emitted once at boot identifying which KeySource fed the engine.
  VAULT_ENCRYPT: 'vault-encrypt',
  VAULT_DECRYPT_AUTHORIZED: 'vault-decrypt-authorized',
  VAULT_DECRYPT_REFUSED: 'vault-decrypt-refused',
  VAULT_DELETE: 'vault-delete',
  VAULT_INJECTION_CAUGHT_UNENCRYPTED: 'vault-injection-caught-unencrypted',
  VAULT_DB_REKEY: 'vault-db-rekey',
  VAULT_KEY_SOURCE_LOADED: 'vault-key-source-loaded',
  // R29 WB-1: one-time migration marker written when an already-populated
  // (legacy) audit_log is upgraded to the per-user chain-head era. It is a
  // hash-chained audit row whose previousHash is the legacy global head, so
  // the boundary cannot be forged or relabeled without breaking the chain.
  // The verifier (verifyEpochAwareChain) validates this event first.
  CHAIN_EPOCH_MIGRATED: 'chain-epoch-migrated',
  // R29 WD-3: a new write re-asserts a value that was previously superseded.
  // The new row supersedes the current opposing row and links the matching
  // historical (already-superseded) row as a recurrence; details JSON carries
  // the revived row id, the superseded-current id, and the match basis.
  REASSERTED_PRIOR_VALUE: 'reasserted-prior-value',
  // R29 WD-4: consensus 'store' on a single-valued, same-attribute subject
  // invalidated the losing conflicting rows. Details JSON carries the losing
  // ids, the subject, and the rationale.
  CONSENSUS_INVALIDATED: 'consensus-invalidated',
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
  AuditAction.WEIGHT_TUNER_APPLIED,
  AuditAction.VAULT_ENCRYPT,
  AuditAction.VAULT_DECRYPT_AUTHORIZED,
  AuditAction.VAULT_DECRYPT_REFUSED,
  AuditAction.VAULT_DELETE,
  AuditAction.VAULT_INJECTION_CAUGHT_UNENCRYPTED,
  AuditAction.VAULT_DB_REKEY,
  AuditAction.VAULT_KEY_SOURCE_LOADED,
  AuditAction.CHAIN_EPOCH_MIGRATED,
  AuditAction.REASSERTED_PRIOR_VALUE,
  AuditAction.CONSENSUS_INVALIDATED,
]);

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  // S2: userId is optional on the schema for back-compat with snapshots
  // written before per-user chains. Verifier groups by this field when
  // present; if a row predates the column, it is treated as user 'system'.
  userId: z.string().nullable().optional(),
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
