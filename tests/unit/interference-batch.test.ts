import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

let runInterferenceBatch: typeof import('../../src/learn/interference-batch.js').runInterferenceBatch;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();

  const mod = await import('../../src/learn/interference-batch.js');
  runInterferenceBatch = mod.runInterferenceBatch;
});

const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    claim: 'Some memory claim',
    subject: 'Testing',
    scope: 'global',
    validFrom: null,
    validTo: null,
    provenance: 'user-confirmed',
    trustClass: 'confirmed',
    confidence: 0.9,
    sourceHash: 'hash123',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: 'approved',
    accessCount: 1,
    lastAccessed: NINETY_DAYS_AGO,
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

function mockRepo(memories: MemoryRecord[] = []): IMemoryRepository {
  return {
    exportAll: async function* () {
      for (const m of memories) {
        yield m;
      }
    },
    moveToColdStorage: vi.fn().mockResolvedValue(undefined),
    appendAuditLog: vi.fn().mockResolvedValue({
      id: 'audit-1',
      memoryId: null,
      action: 'moved-to-cold',
      details: '',
      previousHash: null,
      hash: 'h1',
      timestamp: new Date().toISOString(),
    }),
  } as unknown as IMemoryRepository;
}

describe('runInterferenceBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 moved when all memories are frozen', async () => {
    const frozen = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      isFrozen: true,
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const repo = mockRepo([frozen]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('returns 0 moved when all memories are permanent', async () => {
    const permanent = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      permanenceStatus: 'permanent',
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const repo = mockRepo([permanent]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('returns 0 moved when all memories are inhibitory', async () => {
    const inhibitory = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      isInhibitory: true,
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const repo = mockRepo([inhibitory]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('returns 0 moved when all memories are recently accessed (fresh)', async () => {
    const fresh = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 1,
      lastAccessed: YESTERDAY,
    });
    const repo = mockRepo([fresh]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('returns 0 moved when all memories already in cold storage', async () => {
    const cold = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      interferenceStatus: 'cold',
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const repo = mockRepo([cold]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('returns 0 moved when access count meets the threshold', async () => {
    // Default minAccessCount is 3, so a memory with 3 accesses should NOT be moved
    const highAccess = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 3,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const repo = mockRepo([highAccess]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(0);
    expect(repo.moveToColdStorage).not.toHaveBeenCalled();
  });

  it('moves stale low-access memories to cold storage', async () => {
    const stale = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 1,
      lastAccessed: NINETY_DAYS_AGO,
      interferenceStatus: 'active',
      isFrozen: false,
      permanenceStatus: 'provisional',
      isInhibitory: false,
    });
    const repo = mockRepo([stale]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(1);
    expect(repo.moveToColdStorage).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    expect(repo.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: '11111111-1111-1111-1111-111111111111',
        action: 'moved-to-cold',
      }),
    );
  });

  it('moves multiple eligible memories and skips ineligible ones', async () => {
    const eligible1 = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
      interferenceStatus: 'active',
      isFrozen: false,
      permanenceStatus: 'provisional',
      isInhibitory: false,
    });
    const frozen = makeMemoryRecord({
      id: '22222222-2222-2222-2222-222222222222',
      isFrozen: true,
      accessCount: 0,
      lastAccessed: NINETY_DAYS_AGO,
    });
    const eligible2 = makeMemoryRecord({
      id: '33333333-3333-3333-3333-333333333333',
      accessCount: 2,
      lastAccessed: NINETY_DAYS_AGO,
      interferenceStatus: 'active',
      isFrozen: false,
      permanenceStatus: 'provisional',
      isInhibitory: false,
    });
    const repo = mockRepo([eligible1, frozen, eligible2]);

    const result = await runInterferenceBatch(repo);

    expect(result.movedToCold).toBe(2);
    expect(repo.moveToColdStorage).toHaveBeenCalledTimes(2);
    expect(repo.moveToColdStorage).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    expect(repo.moveToColdStorage).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
  });

  it('respects batchLimit', async () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemoryRecord({
        id: `${String(i + 1).padStart(8, '0')}-0000-0000-0000-000000000000`,
        accessCount: 0,
        lastAccessed: NINETY_DAYS_AGO,
        interferenceStatus: 'active',
        isFrozen: false,
        permanenceStatus: 'provisional',
        isInhibitory: false,
      }),
    );
    const repo = mockRepo(memories);

    const result = await runInterferenceBatch(repo, { batchLimit: 3 });

    expect(result.movedToCold).toBe(3);
    expect(repo.moveToColdStorage).toHaveBeenCalledTimes(3);
  });

  it('uses custom staleDays threshold', async () => {
    // Memory accessed 10 days ago. Default staleDays=60 would skip it.
    // But with staleDays=5, it should be moved.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const mem = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 0,
      lastAccessed: tenDaysAgo,
      interferenceStatus: 'active',
      isFrozen: false,
      permanenceStatus: 'provisional',
      isInhibitory: false,
    });
    const repo = mockRepo([mem]);

    const result = await runInterferenceBatch(repo, { staleDays: 5 });

    expect(result.movedToCold).toBe(1);
    expect(repo.moveToColdStorage).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('uses custom minAccessCount threshold', async () => {
    // Memory with 4 accesses. Default minAccessCount=3 would skip it.
    // With minAccessCount=10, it should be moved.
    const mem = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      accessCount: 4,
      lastAccessed: NINETY_DAYS_AGO,
      interferenceStatus: 'active',
      isFrozen: false,
      permanenceStatus: 'provisional',
      isInhibitory: false,
    });
    const repo = mockRepo([mem]);

    const result = await runInterferenceBatch(repo, { minAccessCount: 10 });

    expect(result.movedToCold).toBe(1);
  });
});
