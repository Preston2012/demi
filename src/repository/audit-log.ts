import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditEntry } from '../schema/audit.js';
import { AuditIntegrityError } from '../errors.js';

/**
 * Audit log verification and snapshot utilities.
 *
 * The hash chain works as follows:
 * - Each audit entry's hash = SHA-256(memoryId + action + details + timestamp + previousHash)
 * - First entry has previousHash = null
 * - Verification walks the chain and recomputes each hash
 * - Any mismatch = tamper detected
 *
 * Snapshots:
 * - Periodic HMAC-signed JSON dumps of the full audit log
 * - Stored off-box (backup volume)
 * - Signature uses a separate snapshot key (not the auth token)
 * - Enables detection of both individual entry and bulk tampering
 */

// --- Hash computation (must match SqliteMemoryRepository.computeAuditHash) ---

export function computeEntryHash(
  entry: {
    memoryId: string | null;
    action: string;
    details: string | null;
    timestamp: string;
  },
  previousHash: string | null,
): string {
  const payload = JSON.stringify({
    memoryId: entry.memoryId,
    action: entry.action,
    details: entry.details,
    timestamp: entry.timestamp,
    previousHash,
  });
  return createHash('sha256').update(payload).digest('hex');
}

// --- Chain verification ---

export interface VerificationResult {
  valid: boolean;
  entriesChecked: number;
  firstInvalidEntry: string | null;
  error: string | null;
}

/**
 * Verify the integrity of an ordered audit log chain.
 * Entries MUST be in insertion order (ascending by timestamp/rowid).
 *
 * Checks:
 * 1. First entry has previousHash = null
 * 2. Each entry's hash matches recomputed hash
 * 3. Each entry's previousHash matches prior entry's hash
 */
export function verifyChain(entries: AuditEntry[]): VerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstInvalidEntry: null, error: null };
  }

  // First entry must have null previousHash
  const first = entries[0]!;
  if (first.previousHash !== null) {
    return {
      valid: false,
      entriesChecked: 1,
      firstInvalidEntry: first.id,
      error: `First entry has non-null previousHash: ${first.previousHash}`,
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // Recompute hash
    const expectedHash = computeEntryHash(
      {
        memoryId: entry.memoryId,
        action: entry.action,
        details: entry.details,
        timestamp: entry.timestamp,
      },
      entry.previousHash,
    );

    if (entry.hash !== expectedHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstInvalidEntry: entry.id,
        error: `Hash mismatch at entry ${entry.id}. Expected: ${expectedHash}, got: ${entry.hash}`,
      };
    }

    // Check chain linkage (entry i+1's previousHash must equal entry i's hash)
    if (i < entries.length - 1) {
      const next = entries[i + 1]!;
      if (next.previousHash !== entry.hash) {
        return {
          valid: false,
          entriesChecked: i + 2,
          firstInvalidEntry: next.id,
          error: `Chain break at entry ${next.id}. previousHash doesn't match prior entry hash.`,
        };
      }
    }
  }

  return { valid: true, entriesChecked: entries.length, firstInvalidEntry: null, error: null };
}

/**
 * Verify chain and throw on failure. Use in critical paths.
 */
export function verifyChainOrThrow(entries: AuditEntry[]): void {
  const result = verifyChain(entries);
  if (!result.valid) {
    throw new AuditIntegrityError(
      result.firstInvalidEntry || 'unknown',
      result.error || 'Unknown audit integrity error',
    );
  }
}

// --- Snapshot signing ---

export interface AuditSnapshot {
  entries: AuditEntry[];
  chainLength: number;
  lastHash: string | null;
  createdAt: string;
  signature: string;
}

/**
 * Create an HMAC-signed snapshot of the audit log.
 * The signature covers the entire entries array + metadata.
 */
export function createSnapshot(entries: AuditEntry[], snapshotKey: string): AuditSnapshot {
  const lastHash = entries.length > 0 ? entries[entries.length - 1]!.hash : null;
  const createdAt = new Date().toISOString();

  const sigPayload = JSON.stringify({
    entries,
    chainLength: entries.length,
    lastHash,
    createdAt,
  });

  const signature = createHmac('sha256', snapshotKey).update(sigPayload).digest('hex');

  return {
    entries,
    chainLength: entries.length,
    lastHash,
    createdAt,
    signature,
  };
}

/**
 * Verify an audit snapshot's HMAC signature.
 */
export function verifySnapshot(snapshot: AuditSnapshot, snapshotKey: string): boolean {
  const sigPayload = JSON.stringify({
    entries: snapshot.entries,
    chainLength: snapshot.chainLength,
    lastHash: snapshot.lastHash,
    createdAt: snapshot.createdAt,
  });

  const expectedSig = createHmac('sha256', snapshotKey).update(sigPayload).digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(snapshot.signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Save snapshot to disk as signed JSON.
 */
export function saveSnapshot(snapshot: AuditSnapshot, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true });
  const filename = `audit-snapshot-${snapshot.createdAt.replace(/[:.]/g, '-')}.json`;
  const filepath = join(backupDir, filename);
  writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filepath;
}

/**
 * Load and verify a snapshot from disk.
 * Returns null if file doesn't exist.
 * Throws AuditIntegrityError if signature is invalid.
 */
export function loadAndVerifySnapshot(
  filepath: string,
  snapshotKey: string,
): AuditSnapshot | null {
  if (!existsSync(filepath)) return null;

  const raw = readFileSync(filepath, 'utf-8');
  const snapshot = JSON.parse(raw) as AuditSnapshot;

  if (!verifySnapshot(snapshot, snapshotKey)) {
    throw new AuditIntegrityError(
      'snapshot',
      `Snapshot signature verification failed: ${filepath}`,
    );
  }

  return snapshot;
}
