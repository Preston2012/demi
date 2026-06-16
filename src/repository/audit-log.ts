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

// --- R29 WB-3: epoch-aware verification ---

/** Audit action literal for the one-time chain-epoch migration marker. */
export const CHAIN_EPOCH_ACTION = 'chain-epoch-migrated';

export interface EpochVerificationResult extends VerificationResult {
  /** Which segment failed: 'legacy-global', 'epoch', `user=<id>`, or null when valid. */
  scope: string | null;
}

/**
 * Verify a single linear hash chain, tolerating dangling references that are
 * covered by a deletion tombstone. A dangling reference is a previousHash
 * (the first entry's, or one that does not match the immediately-prior entry)
 * pointing at a hash not present in `entries`. It passes ONLY when that hash
 * is in `tombstones`, i.e. the predecessor rows were intentionally deleted and
 * recorded in the manifest. Otherwise a missing predecessor is a break.
 */
function verifyLinearChain(entries: AuditEntry[], tombstones: ReadonlySet<string>): VerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstInvalidEntry: null, error: null };
  }

  const present = new Set(entries.map((e) => e.hash));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
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

    const prevHash = entry.previousHash;
    if (i === 0) {
      // First entry: null (genuine chain start) or a tombstoned head
      // (predecessors intentionally deleted) are both acceptable.
      if (prevHash !== null && !tombstones.has(prevHash)) {
        return {
          valid: false,
          entriesChecked: 1,
          firstInvalidEntry: entry.id,
          error: `First entry ${entry.id} has dangling previousHash ${prevHash} not covered by a deletion tombstone`,
        };
      }
    } else {
      const prior = entries[i - 1]!;
      if (prevHash !== prior.hash) {
        // Not linked to the prior entry. Acceptable only if the referenced
        // predecessor was intentionally deleted (tombstoned) and is genuinely
        // absent from the chain.
        const tolerated = prevHash !== null && tombstones.has(prevHash) && !present.has(prevHash);
        if (!tolerated) {
          return {
            valid: false,
            entriesChecked: i + 1,
            firstInvalidEntry: entry.id,
            error: `Chain break at entry ${entry.id}. previousHash doesn't match prior entry hash and is not a tombstoned deletion.`,
          };
        }
      }
    }
  }

  return { valid: true, entriesChecked: entries.length, firstInvalidEntry: null, error: null };
}

/** Group entries by userId (null/undefined → 'system') and verify each chain. */
function verifyPerUser(entries: AuditEntry[], tombstones: ReadonlySet<string>): EpochVerificationResult {
  const byUser = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    const key = e.userId ?? 'system';
    let bucket = byUser.get(key);
    if (!bucket) {
      bucket = [];
      byUser.set(key, bucket);
    }
    bucket.push(e);
  }

  let totalChecked = 0;
  for (const [userId, userEntries] of byUser) {
    const result = verifyLinearChain(userEntries, tombstones);
    totalChecked += result.entriesChecked;
    if (!result.valid) {
      return { ...result, entriesChecked: totalChecked, scope: `user=${userId}` };
    }
  }
  return { valid: true, entriesChecked: totalChecked, firstInvalidEntry: null, error: null, scope: null };
}

/**
 * R29 WB-3: epoch-aware audit-chain verification.
 *
 * Entries MUST be in global insertion (rowid) order. Behaviour:
 *  - No epoch marker (fresh DB / pre-WB DB): verify per-user chains, exactly
 *    as the S2 verifier did. This keeps single-tenant and post-WB-only data
 *    working with no special casing.
 *  - One epoch marker: validate the marker itself is hash-chained (its own
 *    hash recomputes and it links to the legacy global head), verify the
 *    pre-epoch segment as one GLOBAL chain, and verify the post-epoch segment
 *    PER USER. The marker is the unforgeable boundary between the two eras.
 *  - More than one marker: fail (an extra marker means the boundary was
 *    forged or the DB is corrupt).
 *
 * Dangling references created by intentional deletions (a user delete, or the
 * pre-epoch legacy wipe) are tolerated only when the referenced head is in the
 * tombstone manifest (`tombstonedHashes`).
 */
export function verifyEpochAwareChain(
  entries: AuditEntry[],
  options: { tombstonedHashes?: ReadonlySet<string> } = {},
): EpochVerificationResult {
  const tombstones = options.tombstonedHashes ?? new Set<string>();

  const epochIdxs: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.action === CHAIN_EPOCH_ACTION) epochIdxs.push(i);
  }

  if (epochIdxs.length > 1) {
    return {
      valid: false,
      entriesChecked: entries.length,
      firstInvalidEntry: entries[epochIdxs[1]!]!.id,
      error: `Multiple epoch markers (${epochIdxs.length}); chain boundary is ambiguous or forged.`,
      scope: 'epoch',
    };
  }

  if (epochIdxs.length === 0) {
    return verifyPerUser(entries, tombstones);
  }

  const epochIdx = epochIdxs[0]!;
  const epoch = entries[epochIdx]!;

  // 1. The marker's own hash must recompute (no relabeling its metadata).
  const expectedEpochHash = computeEntryHash(
    {
      memoryId: epoch.memoryId,
      action: epoch.action,
      details: epoch.details,
      timestamp: epoch.timestamp,
    },
    epoch.previousHash,
  );
  if (epoch.hash !== expectedEpochHash) {
    return {
      valid: false,
      entriesChecked: epochIdx + 1,
      firstInvalidEntry: epoch.id,
      error: 'Epoch marker hash mismatch (epoch metadata tampered).',
      scope: 'epoch',
    };
  }

  // 2. Pre-epoch segment is one global chain.
  const pre = entries.slice(0, epochIdx);
  const preResult = verifyLinearChain(pre, tombstones);
  if (!preResult.valid) {
    return { ...preResult, scope: 'legacy-global' };
  }

  // 3. The marker must chain to the legacy global head (or, if the legacy
  //    segment was intentionally wiped, to a tombstoned head).
  if (pre.length > 0) {
    const legacyHead = pre[pre.length - 1]!.hash;
    // A partial wipe can remove the legacy tail including the row the marker
    // chained to; tolerate it only when the marker predecessor hash is
    // covered by a deletion tombstone (same rule as verifyLinearChain gaps).
    const tolerated = epoch.previousHash !== null && tombstones.has(epoch.previousHash);
    if (epoch.previousHash !== legacyHead && !tolerated) {
      return {
        valid: false,
        entriesChecked: epochIdx + 1,
        firstInvalidEntry: epoch.id,
        error: 'Epoch marker does not chain to the legacy global head.',
        scope: 'epoch',
      };
    }
  } else if (epoch.previousHash !== null && !tombstones.has(epoch.previousHash)) {
    return {
      valid: false,
      entriesChecked: 1,
      firstInvalidEntry: epoch.id,
      error: `Epoch marker dangles: legacy head ${epoch.previousHash} absent and not covered by a deletion tombstone.`,
      scope: 'epoch',
    };
  }

  // 4. Post-epoch segment is per-user.
  const post = entries.slice(epochIdx + 1);
  const postResult = verifyPerUser(post, tombstones);
  if (!postResult.valid) {
    return {
      ...postResult,
      entriesChecked: epochIdx + 1 + postResult.entriesChecked,
    };
  }

  return { valid: true, entriesChecked: entries.length, firstInvalidEntry: null, error: null, scope: null };
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
export function loadAndVerifySnapshot(filepath: string, snapshotKey: string): AuditSnapshot | null {
  if (!existsSync(filepath)) return null;

  const raw = readFileSync(filepath, 'utf-8');
  const snapshot = JSON.parse(raw) as AuditSnapshot;

  if (!verifySnapshot(snapshot, snapshotKey)) {
    throw new AuditIntegrityError('snapshot', `Snapshot signature verification failed: ${filepath}`);
  }

  return snapshot;
}
