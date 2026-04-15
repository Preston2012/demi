import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  computeEntryHash,
  verifyChain,
  verifyChainOrThrow,
  createSnapshot,
  verifySnapshot,
} from '../../src/repository/audit-log.js';
import { AuditAction } from '../../src/schema/audit.js';
import type { AuditEntry } from '../../src/schema/audit.js';
import { AuditIntegrityError } from '../../src/errors.js';

// --- Helpers ---

function buildChain(length: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let previousHash: string | null = null;

  for (let i = 0; i < length; i++) {
    const entry = {
      memoryId: uuid(),
      action: AuditAction.CREATED as string,
      details: `Entry ${i}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    };

    const hash = computeEntryHash(entry, previousHash);

    entries.push({
      id: uuid(),
      memoryId: entry.memoryId,
      action: entry.action as AuditEntry['action'],
      details: entry.details,
      previousHash,
      hash,
      timestamp: entry.timestamp,
    });

    previousHash = hash;
  }

  return entries;
}

// --- computeEntryHash ---

describe('computeEntryHash', () => {
  it('produces consistent hashes for same input', () => {
    const entry = {
      memoryId: '123e4567-e89b-12d3-a456-426614174000',
      action: AuditAction.CREATED,
      details: 'test',
      timestamp: '2026-04-07T00:00:00.000Z',
    };
    const h1 = computeEntryHash(entry, null);
    const h2 = computeEntryHash(entry, null);
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const base = {
      memoryId: uuid(),
      action: AuditAction.CREATED,
      details: 'test',
      timestamp: '2026-04-07T00:00:00.000Z',
    };
    const h1 = computeEntryHash(base, null);
    const h2 = computeEntryHash({ ...base, details: 'different' }, null);
    expect(h1).not.toBe(h2);
  });

  it('hash changes when previousHash changes', () => {
    const entry = {
      memoryId: uuid(),
      action: AuditAction.CREATED,
      details: 'test',
      timestamp: '2026-04-07T00:00:00.000Z',
    };
    const h1 = computeEntryHash(entry, null);
    const h2 = computeEntryHash(entry, 'abc123');
    expect(h1).not.toBe(h2);
  });

  it('produces 64-char hex string (SHA-256)', () => {
    const entry = {
      memoryId: uuid(),
      action: AuditAction.CREATED,
      details: null,
      timestamp: new Date().toISOString(),
    };
    const hash = computeEntryHash(entry, null);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles null memoryId and details', () => {
    const entry = {
      memoryId: null,
      action: AuditAction.CIRCUIT_BREAKER_LOCKED,
      details: null,
      timestamp: new Date().toISOString(),
    };
    const hash = computeEntryHash(entry, null);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// --- verifyChain ---

describe('verifyChain', () => {
  it('validates an empty chain', () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  it('validates a single-entry chain', () => {
    const chain = buildChain(1);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(1);
  });

  it('validates a 10-entry chain', () => {
    const chain = buildChain(10);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(10);
  });

  it('validates a 100-entry chain', () => {
    const chain = buildChain(100);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(100);
  });

  it('detects tampered hash', () => {
    const chain = buildChain(5);
    chain[2]!.hash = 'tampered_hash_value_000000000000000000000000000000000000';
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntry).toBe(chain[2]!.id);
    expect(result.error).toContain('Hash mismatch');
  });

  it('detects tampered details', () => {
    const chain = buildChain(5);
    chain[3]!.details = 'TAMPERED';
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntry).toBe(chain[3]!.id);
  });

  it('detects tampered memoryId', () => {
    const chain = buildChain(5);
    chain[1]!.memoryId = uuid();
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntry).toBe(chain[1]!.id);
  });

  it('detects tampered timestamp', () => {
    const chain = buildChain(5);
    chain[2]!.timestamp = '2099-01-01T00:00:00.000Z';
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
  });

  it('detects broken chain linkage', () => {
    const chain = buildChain(5);
    // Break the link: set entry 3's previousHash to garbage
    chain[3]!.previousHash = 'wrong_previous_hash_00000000000000000000000000000000';
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntry).toBe(chain[3]!.id);
  });

  it('detects non-null previousHash on first entry', () => {
    const chain = buildChain(3);
    chain[0]!.previousHash = 'should_be_null';
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntry).toBe(chain[0]!.id);
    expect(result.error).toContain('First entry has non-null previousHash');
  });

  it('detects inserted entry in the middle', () => {
    const chain = buildChain(5);
    // Insert a rogue entry between 2 and 3
    const rogue: AuditEntry = {
      id: uuid(),
      memoryId: uuid(),
      action: AuditAction.DELETED,
      details: 'rogue entry',
      previousHash: chain[2]!.hash,
      hash: 'fake_hash_00000000000000000000000000000000000000000000',
      timestamp: new Date().toISOString(),
    };
    chain.splice(3, 0, rogue);
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
  });

  it('detects deleted entry from the middle', () => {
    const chain = buildChain(5);
    // Remove entry 2, breaking the chain
    chain.splice(2, 1);
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
  });
});

// --- verifyChainOrThrow ---

describe('verifyChainOrThrow', () => {
  it('does not throw for valid chain', () => {
    const chain = buildChain(5);
    expect(() => verifyChainOrThrow(chain)).not.toThrow();
  });

  it('throws AuditIntegrityError for invalid chain', () => {
    const chain = buildChain(5);
    chain[2]!.details = 'TAMPERED';
    expect(() => verifyChainOrThrow(chain)).toThrow(AuditIntegrityError);
  });
});

// --- Snapshots ---

describe('Snapshot signing', () => {
  const snapshotKey = 'test-snapshot-key-for-unit-tests-only';

  it('creates and verifies a valid snapshot', () => {
    const chain = buildChain(5);
    const snapshot = createSnapshot(chain, snapshotKey);

    expect(snapshot.chainLength).toBe(5);
    expect(snapshot.lastHash).toBe(chain[4]!.hash);
    expect(snapshot.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(true);
  });

  it('detects wrong key', () => {
    const chain = buildChain(3);
    const snapshot = createSnapshot(chain, snapshotKey);
    expect(verifySnapshot(snapshot, 'wrong-key')).toBe(false);
  });

  it('detects tampered entries after signing', () => {
    const chain = buildChain(3);
    const snapshot = createSnapshot(chain, snapshotKey);
    snapshot.entries[1]!.details = 'TAMPERED';
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(false);
  });

  it('detects tampered chainLength after signing', () => {
    const chain = buildChain(3);
    const snapshot = createSnapshot(chain, snapshotKey);
    snapshot.chainLength = 999;
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(false);
  });

  it('detects tampered lastHash after signing', () => {
    const chain = buildChain(3);
    const snapshot = createSnapshot(chain, snapshotKey);
    snapshot.lastHash = 'tampered';
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(false);
  });

  it('detects tampered createdAt after signing', () => {
    const chain = buildChain(3);
    const snapshot = createSnapshot(chain, snapshotKey);
    snapshot.createdAt = '2099-01-01T00:00:00.000Z';
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(false);
  });

  it('handles empty chain snapshot', () => {
    const snapshot = createSnapshot([], snapshotKey);
    expect(snapshot.chainLength).toBe(0);
    expect(snapshot.lastHash).toBeNull();
    expect(verifySnapshot(snapshot, snapshotKey)).toBe(true);
  });

  it('different chains produce different signatures', () => {
    const chain1 = buildChain(3);
    const chain2 = buildChain(3);
    const snap1 = createSnapshot(chain1, snapshotKey);
    const snap2 = createSnapshot(chain2, snapshotKey);
    expect(snap1.signature).not.toBe(snap2.signature);
  });
});
