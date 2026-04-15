import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  MemoryRecordSchema,
  AddMemoryInputSchema,
  Provenance,
  TrustClass,
  ReviewStatus,
  Scope,
  MemorySource,
  PROVENANCE_SCORES,
  VALID_TRUST_TRANSITIONS,
  isValidTransition,
} from '../../src/schema/memory.js';
import { AuditEntrySchema, AuditAction } from '../../src/schema/audit.js';

// --- Helpers ---

function validMemoryRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'User prefers dark mode.',
    subject: 'user',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.USER_CONFIRMED,
    trustClass: TrustClass.CONFIRMED,
    confidence: 0.95,
    sourceHash: 'abc123def456',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: now,
    embedding: null,
    permanenceStatus: 'provisional',
    hubId: null,
    hubScore: 0,
    resolution: 3,
    memoryType: 'declarative',
    versionNumber: 1,
    parentVersionId: null,
    frozenAt: null,
    decayScore: 1,
    storageTier: 'active',
    isInhibitory: false,
    inhibitionTarget: null,
    interferenceStatus: 'active',
    correctionCount: 0,
    isFrozen: false,
    causedBy: null,
    leadsTo: null,
    ...overrides,
  };
}

function validAuditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    memoryId: uuid(),
    action: AuditAction.CREATED,
    details: 'Initial creation',
    previousHash: null,
    hash: 'sha256-placeholder',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// --- MemoryRecord ---

describe('MemoryRecordSchema', () => {
  it('accepts a valid complete record', () => {
    const record = validMemoryRecord();
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('accepts embedding as 1024-dim float array', () => {
    const embedding = Array.from({ length: 1024 }, () => Math.random());
    const record = validMemoryRecord({ embedding });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('accepts variable embedding dimensions (384d, 1024d, etc)', () => {
    const embedding = Array.from({ length: 100 }, () => Math.random());
    const record = validMemoryRecord({ embedding });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('rejects empty claim', () => {
    const record = validMemoryRecord({ claim: '' });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects claim over 2000 chars', () => {
    const record = validMemoryRecord({ claim: 'x'.repeat(2001) });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID for id', () => {
    const record = validMemoryRecord({ id: 'not-a-uuid' });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const over = validMemoryRecord({ confidence: 1.5 });
    const under = validMemoryRecord({ confidence: -0.1 });
    expect(MemoryRecordSchema.safeParse(over).success).toBe(false);
    expect(MemoryRecordSchema.safeParse(under).success).toBe(false);
  });

  it('rejects invalid provenance', () => {
    const record = validMemoryRecord({ provenance: 'magic' });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects invalid trust class', () => {
    const record = validMemoryRecord({ trustClass: 'maybe' });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('accepts valid conflictsWith array', () => {
    const record = validMemoryRecord({ conflictsWith: [uuid(), uuid()] });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID in conflictsWith', () => {
    const record = validMemoryRecord({ conflictsWith: ['bad-id'] });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects negative accessCount', () => {
    const record = validMemoryRecord({ accessCount: -1 });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('accepts valid supersedes UUID', () => {
    const record = validMemoryRecord({ supersedes: uuid() });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('accepts null for optional datetime fields', () => {
    const record = validMemoryRecord({ validFrom: null, validTo: null });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('accepts ISO datetime strings for validity window', () => {
    const record = validMemoryRecord({
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-12-31T23:59:59.000Z',
    });
    const result = MemoryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });
});

// --- AddMemoryInput ---

describe('AddMemoryInputSchema', () => {
  it('accepts minimal input (claim only)', () => {
    const result = AddMemoryInputSchema.safeParse({ claim: 'User likes TypeScript.' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe(Scope.GLOBAL);
      expect(result.data.source).toBe(MemorySource.LLM);
    }
  });

  it('accepts full input', () => {
    const input = {
      claim: 'User lives in Austin.',
      subject: 'user',
      scope: Scope.GLOBAL,
      source: MemorySource.USER,
      confidence: 0.99,
      validFrom: '2026-01-01T00:00:00.000Z',
    };
    const result = AddMemoryInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects empty claim', () => {
    const result = AddMemoryInputSchema.safeParse({ claim: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid scope', () => {
    const result = AddMemoryInputSchema.safeParse({ claim: 'test', scope: 'universal' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source', () => {
    const result = AddMemoryInputSchema.safeParse({ claim: 'test', source: 'magic' });
    expect(result.success).toBe(false);
  });

  it('rejects confidence > 1', () => {
    const result = AddMemoryInputSchema.safeParse({ claim: 'test', confidence: 2.0 });
    expect(result.success).toBe(false);
  });
});

// --- Enums ---

describe('Enum completeness', () => {
  it('all provenance values have a score', () => {
    for (const p of Object.values(Provenance)) {
      expect(PROVENANCE_SCORES[p]).toBeTypeOf('number');
      expect(PROVENANCE_SCORES[p]).toBeGreaterThanOrEqual(0);
      expect(PROVENANCE_SCORES[p]).toBeLessThanOrEqual(1);
    }
  });

  it('provenance scores rank correctly', () => {
    expect(PROVENANCE_SCORES[Provenance.USER_CONFIRMED]).toBeGreaterThan(
      PROVENANCE_SCORES[Provenance.LLM_EXTRACTED_CONFIDENT],
    );
    expect(PROVENANCE_SCORES[Provenance.LLM_EXTRACTED_CONFIDENT]).toBeGreaterThan(
      PROVENANCE_SCORES[Provenance.IMPORTED],
    );
    expect(PROVENANCE_SCORES[Provenance.IMPORTED]).toBeGreaterThan(
      PROVENANCE_SCORES[Provenance.LLM_EXTRACTED_QUARANTINE],
    );
  });

  it('all trust classes have transition rules', () => {
    for (const tc of Object.values(TrustClass)) {
      expect(VALID_TRUST_TRANSITIONS[tc]).toBeDefined();
      expect(Array.isArray(VALID_TRUST_TRANSITIONS[tc])).toBe(true);
    }
  });
});

// --- Trust transitions ---

describe('Trust class transitions', () => {
  it('quarantined can become confirmed', () => {
    expect(isValidTransition(TrustClass.QUARANTINED, TrustClass.CONFIRMED)).toBe(true);
  });

  it('quarantined can become rejected', () => {
    expect(isValidTransition(TrustClass.QUARANTINED, TrustClass.REJECTED)).toBe(true);
  });

  it('auto-approved can become confirmed', () => {
    expect(isValidTransition(TrustClass.AUTO_APPROVED, TrustClass.CONFIRMED)).toBe(true);
  });

  it('auto-approved can become rejected', () => {
    expect(isValidTransition(TrustClass.AUTO_APPROVED, TrustClass.REJECTED)).toBe(true);
  });

  it('confirmed cannot be demoted to quarantined', () => {
    expect(isValidTransition(TrustClass.CONFIRMED, TrustClass.QUARANTINED)).toBe(false);
  });

  it('confirmed has no valid transitions (immutable except supersede)', () => {
    expect(VALID_TRUST_TRANSITIONS[TrustClass.CONFIRMED]).toHaveLength(0);
  });

  it('rejected is terminal', () => {
    expect(VALID_TRUST_TRANSITIONS[TrustClass.REJECTED]).toHaveLength(0);
  });
});

// --- AuditEntry ---

describe('AuditEntrySchema', () => {
  it('accepts a valid audit entry', () => {
    const entry = validAuditEntry();
    const result = AuditEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts null memoryId for system events', () => {
    const entry = validAuditEntry({
      memoryId: null,
      action: AuditAction.CIRCUIT_BREAKER_LOCKED,
    });
    const result = AuditEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts null details', () => {
    const entry = validAuditEntry({ details: null });
    const result = AuditEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects invalid action', () => {
    const entry = validAuditEntry({ action: 'exploded' });
    const result = AuditEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID id', () => {
    const entry = validAuditEntry({ id: '123' });
    const result = AuditEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('all audit actions are valid enum values', () => {
    for (const action of Object.values(AuditAction)) {
      const entry = validAuditEntry({ action });
      const result = AuditEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });
});
