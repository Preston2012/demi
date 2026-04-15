import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { MemoryRecord } from '../../src/schema/memory.js';
import { Provenance, TrustClass, ReviewStatus, Scope } from '../../src/schema/memory.js';
import type { IMemoryRepository } from '../../src/repository/interface.js';

let createReviewQueue: typeof import('../../src/learn/review-queue.js').createReviewQueue;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/learn/review-queue.js');
  createReviewQueue = mod.createReviewQueue;
});

function mockRepo() {
  return {
    getPendingReview: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn(),
    softDelete: vi.fn(),
    searchFTS: vi.fn(),
    searchVector: vi.fn(),
    getByIds: vi.fn(),
    getConflicts: vi.fn(),
    findBySourceHash: vi.fn(),
    findSimilar: vi.fn(),
    getSpotCheckBatch: vi.fn(),
    flagForSpotCheck: vi.fn(),
    incrementAccessCount: vi.fn(),
    updateLastAccessed: vi.fn(),
    appendAuditLog: vi.fn(),
    getAuditLog: vi.fn(),
    getLatestAuditHash: vi.fn(),
    exportAll: vi.fn(),
    getStats: vi.fn(),
    getLastActivityTimestamp: vi.fn(),
    countAll: vi.fn(),
    setMetadata: vi.fn(),
    getMetadata: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
  } as unknown as IMemoryRepository;
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: 'mem-1',
    claim: 'Test claim',
    subject: 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
    trustClass: TrustClass.QUARANTINED,
    confidence: 0.4,
    sourceHash: 'abc123',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.PENDING,
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

describe('ReviewQueue', () => {
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(() => {
    repo = mockRepo();
  });

  it('fetches pending reviews', async () => {
    const pending = [makeMemory()];
    (repo.getPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue(pending);

    const queue = createReviewQueue(repo);
    const results = await queue.getPending();

    expect(repo.getPendingReview).toHaveBeenCalledWith(50);
    expect(results).toHaveLength(1);
  });

  it('promotes a quarantined memory', async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory());

    const queue = createReviewQueue(repo);
    await queue.decide({ memoryId: 'mem-1', action: 'promote' });

    expect(repo.update).toHaveBeenCalledWith(
      'mem-1',
      expect.objectContaining({
        reviewStatus: 'approved',
        trustClass: 'confirmed',
      }),
    );
  });

  it('rejects a quarantined memory', async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory());

    const queue = createReviewQueue(repo);
    await queue.decide({ memoryId: 'mem-1', action: 'reject', reason: 'Junk' });

    expect(repo.update).toHaveBeenCalledWith(
      'mem-1',
      expect.objectContaining({
        reviewStatus: 'rejected',
        trustClass: 'rejected',
      }),
    );
  });

  it('throws if memory not found', async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const queue = createReviewQueue(repo);
    await expect(queue.decide({ memoryId: 'nope', action: 'promote' })).rejects.toThrow('Memory not found: nope');
  });

  it('throws if memory not pending', async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory({ reviewStatus: ReviewStatus.APPROVED }));

    const queue = createReviewQueue(repo);
    await expect(queue.decide({ memoryId: 'mem-1', action: 'promote' })).rejects.toThrow('not pending review');
  });

  it('spot-check samples at configured rate', () => {
    const queue = createReviewQueue(repo);
    const memories = Array.from({ length: 1000 }, (_, i) => makeMemory({ id: `mem-${i}` }));

    const all = queue.sampleForSpotCheck(memories, 1);
    expect(all).toHaveLength(1000);

    const none = queue.sampleForSpotCheck(memories, 0);
    expect(none).toHaveLength(0);
  });

  it('spot-check respects Math.random for intermediate rates', () => {
    const queue = createReviewQueue(repo);
    const memories = Array.from({ length: 10 }, (_, i) => makeMemory({ id: `mem-${i}` }));

    // Force Math.random to return 0.05 (below 0.1 threshold)
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const allSampled = queue.sampleForSpotCheck(memories, 0.1);
    expect(allSampled).toHaveLength(10);

    // Force Math.random to return 0.5 (above 0.1 threshold)
    spy.mockReturnValue(0.5);
    const noneSampled = queue.sampleForSpotCheck(memories, 0.1);
    expect(noneSampled).toHaveLength(0);

    spy.mockRestore();
  });
});
