// tests/integration/dispatch-novel.test.ts
//
// Integration tests for novel dispatch methods.
// Uses same mock setup as dispatch.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { Config } from '../../src/config.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

// Same mocks as dispatch.test.ts
const mockRetrieve = vi.fn();
vi.mock('../../src/retrieval/index.js', () => ({
  retrieve: (...args: unknown[]) => mockRetrieve(...args),
}));

const mockWriteMemory = vi.fn();
vi.mock('../../src/write/index.js', () => ({
  addMemory: (...args: unknown[]) => mockWriteMemory(...args),
}));

const mockFlushShadowLog = vi.fn();
vi.mock('../../src/retrieval/thompson.js', () => ({
  flushShadowLog: (...args: unknown[]) => mockFlushShadowLog(...args),
}));

vi.mock('../../src/embeddings/index.js', () => ({
  isInitialized: () => false,
  encode: async () => [],
}));

let createCoreDispatch: typeof import('../../src/core/dispatch.js').createCoreDispatch;
let config: Config;

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Test claim',
    subject: 'test',
    scope: 'global',
    validFrom: null,
    validTo: null,
    provenance: 'user-confirmed',
    trustClass: 'confirmed',
    confidence: 1.0,
    sourceHash: 'hash',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: 'approved',
    accessCount: 5,
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
  } as MemoryRecord;
}

function makeMockRepo(): IMemoryRepository {
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    insert: vi.fn().mockResolvedValue('id'),
    update: vi.fn(),
    softDelete: vi.fn(),
    searchFTS: vi.fn().mockResolvedValue([]),
    searchVector: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(makeRecord()),
    getByIds: vi.fn().mockResolvedValue([]),
    getConflicts: vi.fn().mockResolvedValue([]),
    findBySourceHash: vi.fn().mockResolvedValue(null),
    findSimilar: vi.fn().mockResolvedValue([]),
    getPendingReview: vi.fn().mockResolvedValue([]),
    getSpotCheckBatch: vi.fn().mockResolvedValue([]),
    flagForSpotCheck: vi.fn(),
    incrementAccessCount: vi.fn(),
    updateLastAccessed: vi.fn(),
    appendAuditLog: vi
      .fn()
      .mockResolvedValue({
        id: uuid(),
        memoryId: null,
        action: 'created',
        details: null,
        previousHash: null,
        hash: 'h',
        timestamp: new Date().toISOString(),
      }),
    getAuditLog: vi.fn().mockResolvedValue([]),
    getLatestAuditHash: vi.fn().mockResolvedValue(null),
    exportAll: vi.fn().mockReturnValue((async function* () {})()),
    getStats: vi
      .fn()
      .mockResolvedValue({
        totalMemories: 0,
        byTrustClass: {},
        byProvenance: {},
        byScope: {},
        pendingReview: 0,
        averageConfidence: 0,
        oldestMemory: null,
        newestMemory: null,
      }),
    getLastActivityTimestamp: vi.fn().mockResolvedValue(new Date().toISOString()),
    getPromotionCandidates: vi.fn().mockResolvedValue([]),
    countAll: vi.fn().mockResolvedValue(0),
    setMetadata: vi.fn(),
    getMetadata: vi.fn().mockResolvedValue(null),
    // Novel methods
    getMemoryTags: vi.fn().mockResolvedValue(['tag1', 'tag2']),
    setMemoryTags: vi.fn(),
    searchByTag: vi.fn().mockResolvedValue([makeRecord()]),
    getAllTags: vi.fn().mockResolvedValue([{ tag: 'test', count: 5 }]),
    getHubs: vi.fn().mockResolvedValue([]),
    getHubById: vi.fn().mockResolvedValue(null),
    createHub: vi.fn().mockResolvedValue('hub-id'),
    linkToHub: vi.fn(),
    unlinkFromHub: vi.fn(),
    getHubLinks: vi.fn().mockResolvedValue([]),
    getHubMembers: vi.fn().mockResolvedValue([]),
    incrementHubAccessCount: vi.fn(),
    createVersion: vi.fn().mockResolvedValue('ver-id'),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    getInhibitoryMemories: vi.fn().mockResolvedValue([]),
    getActiveInhibitions: vi.fn().mockResolvedValue([]),
    getColdStorageMemories: vi.fn().mockResolvedValue([]),
    moveToColdStorage: vi.fn(),
    resurrectFromColdStorage: vi.fn(),
    getConstraints: vi.fn().mockResolvedValue([]),
    insertConstraint: vi.fn().mockResolvedValue('c-id'),
    deactivateConstraint: vi.fn(),
    getCausalChain: vi.fn().mockResolvedValue([]),
    insertSelfPlayRun: vi.fn().mockResolvedValue('run-id'),
    updateSelfPlayRun: vi.fn(),
    insertSelfPlayResult: vi.fn().mockResolvedValue('res-id'),
    getSelfPlayResults: vi.fn().mockResolvedValue([]),
    getLatestSelfPlayRun: vi.fn().mockResolvedValue(null),
    getFrozenMemories: vi.fn().mockResolvedValue([]),
    freezeMemory: vi.fn(),
    unfreezeMemory: vi.fn(),
    getMetaMemoryStats: vi.fn().mockResolvedValue({
      totalMemories: 10,
      topSubjects: [{ subject: 'test', count: 5 }],
      coverageGaps: [],
      stalestMemories: [],
      mostAccessed: [],
      inhibitoryCount: 0,
      frozenCount: 0,
      coldStorageCount: 0,
      hubCount: 0,
    }),
    incrementCorrectionCount: vi.fn(),
  } as unknown as IMemoryRepository;
}

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  config = loadConfig();
  const mod = await import('../../src/core/dispatch.js');
  createCoreDispatch = mod.createCoreDispatch;
});

describe('CoreDispatch (novel methods)', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let dispatch: ReturnType<typeof createCoreDispatch>;

  beforeEach(() => {
    repo = makeMockRepo();
    dispatch = createCoreDispatch(repo as IMemoryRepository, config);
  });

  describe('freezeMemory', () => {
    it('freezes memory and logs audit', async () => {
      await dispatch.freezeMemory('mem-1');
      expect(repo.freezeMemory).toHaveBeenCalledWith('mem-1');
      expect(repo.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'frozen' }));
    });

    it('throws MemoryNotFoundError for missing memory', async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(dispatch.freezeMemory('nope')).rejects.toThrow('not found');
    });
  });

  describe('unfreezeMemory', () => {
    it('unfreezes memory and logs audit', async () => {
      await dispatch.unfreezeMemory('mem-1');
      expect(repo.unfreezeMemory).toHaveBeenCalledWith('mem-1');
      expect(repo.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'unfrozen' }));
    });
  });

  describe('globalPause', () => {
    it('reads pause state', async () => {
      (repo.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue('true');
      const paused = await dispatch.getGlobalPause();
      expect(paused).toBe(true);
    });

    it('sets pause state', async () => {
      await dispatch.setGlobalPause(true);
      expect(repo.setMetadata).toHaveBeenCalledWith('global_pause', 'true');
    });

    it('returns false when not set', async () => {
      (repo.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      expect(await dispatch.getGlobalPause()).toBe(false);
    });
  });

  describe('tags', () => {
    it('gets tags for a memory', async () => {
      const tags = await dispatch.getMemoryTags('mem-1');
      expect(tags).toEqual(['tag1', 'tag2']);
    });

    it('sets tags on a memory', async () => {
      await dispatch.setMemoryTags('mem-1', ['a', 'b']);
      expect(repo.setMemoryTags).toHaveBeenCalledWith('mem-1', ['a', 'b']);
    });

    it('searches by tag', async () => {
      await dispatch.searchByTag('tag1');
      expect(repo.searchByTag).toHaveBeenCalledWith('tag1', 15);
    });
  });

  describe('correctMemory', () => {
    it('creates version snapshot before updating claim', async () => {
      await dispatch.correctMemory('mem-1', 'New claim', 'Was wrong');
      expect(repo.createVersion).toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith('mem-1', expect.objectContaining({ claim: 'New claim' }));
      expect(repo.incrementCorrectionCount).toHaveBeenCalledWith('mem-1');
      expect(repo.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'correction' }));
    });

    it('throws MemoryNotFoundError for missing memory', async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(dispatch.correctMemory('nope', 'x', 'y')).rejects.toThrow('not found');
    });
  });

  describe('resurrectMemory', () => {
    it('resurrects from cold storage and logs audit', async () => {
      await dispatch.resurrectMemory('mem-1');
      expect(repo.resurrectFromColdStorage).toHaveBeenCalledWith('mem-1');
      expect(repo.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'resurrected' }));
    });
  });

  describe('getMetaMemoryStats', () => {
    it('returns meta-memory stats from repo', async () => {
      const stats = (await dispatch.getMetaMemoryStats()) as { totalMemories: number; topSubjects: unknown[] };
      expect(stats).toHaveProperty('totalMemories', 10);
      expect(stats).toHaveProperty('topSubjects');
    });
  });

  describe('getVersionHistory', () => {
    it('delegates to repo', async () => {
      await dispatch.getVersionHistory('mem-1');
      expect(repo.getVersionHistory).toHaveBeenCalledWith('mem-1');
    });
  });

  describe('hubs', () => {
    it('gets hubs', async () => {
      await dispatch.getHubs();
      expect(repo.getHubs).toHaveBeenCalledWith(20);
    });

    it('gets hub members', async () => {
      await dispatch.getHubMembers('hub-1');
      expect(repo.getHubMembers).toHaveBeenCalledWith('hub-1', 20);
    });
  });

  describe('coldStorage', () => {
    it('gets cold storage', async () => {
      await dispatch.getColdStorage();
      expect(repo.getColdStorageMemories).toHaveBeenCalledWith(50);
    });
  });
});
