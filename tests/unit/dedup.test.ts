import { describe, it, expect, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { computeSourceHash, checkDuplicate } from '../../src/write/dedup.js';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import { Provenance, TrustClass, ReviewStatus, Scope, type MemoryRecord } from '../../src/schema/memory.js';

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Existing claim',
    subject: 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.AUTO_APPROVED,
    confidence: 0.8,
    sourceHash: 'hash',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: now,
    embedding: null,
    permanenceStatus: 'provisional' as const,
    hubId: null,
    hubScore: 0,
    resolution: 3,
    memoryType: 'declarative' as const,
    versionNumber: 1,
    parentVersionId: null,
    frozenAt: null,
    decayScore: 1,
    storageTier: 'active' as const,
    isInhibitory: false,
    inhibitionTarget: null,
    interferenceStatus: 'active' as const,
    correctionCount: 0,
    isFrozen: false,
    causedBy: null,
    leadsTo: null,
    ...overrides,
  };
}

describe('computeSourceHash', () => {
  it('produces consistent hashes', () => {
    const h1 = computeSourceHash('User likes TypeScript');
    const h2 = computeSourceHash('User likes TypeScript');
    expect(h1).toBe(h2);
  });

  it('normalizes before hashing', () => {
    const h1 = computeSourceHash('User likes TypeScript.');
    const h2 = computeSourceHash('user likes typescript');
    expect(h1).toBe(h2);
  });

  it('different claims produce different hashes', () => {
    const h1 = computeSourceHash('User likes TypeScript');
    const h2 = computeSourceHash('User likes Python');
    expect(h1).not.toBe(h2);
  });
});

describe('checkDuplicate', () => {
  it('detects exact duplicate by hash', async () => {
    const existing = makeRecord();
    const repo = {
      findBySourceHash: vi.fn().mockResolvedValue(existing),
      findSimilar: vi.fn(),
    } as unknown as IMemoryRepository;

    const result = await checkDuplicate(repo, 'test claim', null);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.existingId).toBe(existing.id);
  });

  it('returns no duplicate when hash misses', async () => {
    const repo = {
      findBySourceHash: vi.fn().mockResolvedValue(null),
      findSimilar: vi.fn().mockResolvedValue([]),
    } as unknown as IMemoryRepository;

    const embedding = new Array(1024).fill(0.1);
    const result = await checkDuplicate(repo, 'new claim', embedding);
    expect(result.isDuplicate).toBe(false);
  });

  it('detects semantic duplicate', async () => {
    const existing = makeRecord();
    const repo = {
      findBySourceHash: vi.fn().mockResolvedValue(null),
      findSimilar: vi
        .fn()
        .mockResolvedValue([
          { id: existing.id, record: existing, vectorScore: 0.95, lexicalScore: 0, source: 'vector' },
        ]),
    } as unknown as IMemoryRepository;

    const embedding = new Array(1024).fill(0.1);
    const result = await checkDuplicate(repo, 'paraphrased claim', embedding);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('semantic');
    expect(result.similarity).toBe(0.95);
  });

  it('skips semantic check when no embedding', async () => {
    const repo = {
      findBySourceHash: vi.fn().mockResolvedValue(null),
      findSimilar: vi.fn(),
    } as unknown as IMemoryRepository;

    const result = await checkDuplicate(repo, 'claim', null);
    expect(result.isDuplicate).toBe(false);
    expect(repo.findSimilar).not.toHaveBeenCalled();
  });
});
