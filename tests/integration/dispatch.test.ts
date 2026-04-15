import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { Config } from '../../src/config.js';
import { Provenance, TrustClass, ReviewStatus, Scope, type MemoryRecord } from '../../src/schema/memory.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';

// Mock retrieval, write, inject, thompson, embeddings
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

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/core/dispatch.js');
  createCoreDispatch = mod.createCoreDispatch;
});

beforeEach(() => {
  mockRetrieve.mockReset();
  mockWriteMemory.mockReset();
  mockFlushShadowLog.mockReset();
  mockFlushShadowLog.mockResolvedValue(undefined);
});

// --- Helpers ---

function mockConfig(): Config {
  return {
    port: 3100,
    host: '127.0.0.1',
    authToken: 'a'.repeat(32),
    dbPath: ':memory:',
    walMode: false,
    modelPath: '',
    embeddingDim: 1024,
    embeddingQueueSize: 100,
    maxInjectedRules: 15,
    lexicalWeight: 0.3,
    vectorWeight: 0.4,
    provenanceWeight: 0.15,
    freshnessWeight: 0.1,
    confirmedBonus: 0.15,
    contradictionPenaltyBase: 0.1,
    contradictionPenaltyMax: 0.3,
    freshnessHalfLifeDays: 30,
    candidateOverfetchMultiplier: 3,
    confidenceThreshold: 0.7,
    spotCheckRate: 0,
    consensusThreshold: 0.5,
    consensusProvider: 'anthropic',
    consensusModel: 'claude-sonnet-4-20250514',
    consensusMinAgreement: 2,
    inactivityLockDays: 30,
    writeRatePerMinute: 100,
    readRatePerMinute: 1000,
    auditSnapshotIntervalHours: 24,
    backupPath: '/tmp/demiurge-test',
    thompsonShadowEnabled: false,
    logLevel: 'error',
  } as Config;
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Test claim',
    subject: 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.QUARANTINED,
    confidence: 0.8,
    sourceHash: 'h',
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

function makeScoredCandidate(record: MemoryRecord): FinalScoredCandidate {
  return {
    id: record.id,
    candidate: {
      id: record.id,
      record,
      lexicalScore: 0.5,
      vectorScore: 0.5,
      source: 'both' as const,
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    },
    finalScore: 0.75,
    scoreBreakdown: {
      lexicalComponent: 0.15,
      vectorComponent: 0.2,
      provenanceComponent: 0.1,
      freshnessComponent: 0.1,
      confirmedBonus: 0,
      contradictionPenalty: 0,
    },
  };
}

function createMockRepo(): IMemoryRepository {
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    insert: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn(),
    searchFTS: vi.fn().mockResolvedValue([]),
    searchVector: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    getByIds: vi.fn().mockResolvedValue([]),
    getConflicts: vi.fn(),
    findBySourceHash: vi.fn().mockResolvedValue(null),
    findSimilar: vi.fn().mockResolvedValue([]),
    getPendingReview: vi.fn().mockResolvedValue([]),
    getSpotCheckBatch: vi.fn(),
    flagForSpotCheck: vi.fn(),
    incrementAccessCount: vi.fn().mockResolvedValue(undefined),
    updateLastAccessed: vi.fn(),
    appendAuditLog: vi.fn().mockResolvedValue({ id: uuid() }),
    getAuditLog: vi.fn(),
    getLatestAuditHash: vi.fn(),
    exportAll: vi.fn().mockReturnValue(
      (async function* () {
        /* empty */
      })(),
    ),
    getStats: vi.fn().mockResolvedValue({
      totalMemories: 0,
      byTrustClass: { confirmed: 0, 'auto-approved': 0, quarantined: 0, rejected: 0 },
      byProvenance: { 'user-confirmed': 0, 'llm-extracted-confident': 0, 'llm-extracted-quarantine': 0, imported: 0 },
      byScope: { global: 0, project: 0, session: 0 },
      pendingReview: 0,
      averageConfidence: 0,
      oldestMemory: null,
      newestMemory: null,
    }),
    getLastActivityTimestamp: vi.fn().mockResolvedValue(new Date().toISOString()),
    countAll: vi.fn().mockResolvedValue(0),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(new Date().toISOString()),
    getActiveInhibitions: vi.fn().mockResolvedValue([]),
    getHubLinks: vi.fn().mockResolvedValue([]),
    getPromotionCandidates: vi.fn().mockResolvedValue([]),
    getMemoryTags: vi.fn().mockResolvedValue([]),
    setMemoryTags: vi.fn().mockResolvedValue(undefined),
    searchByTag: vi.fn().mockResolvedValue([]),
    getAllTags: vi.fn().mockResolvedValue([]),
    getHubs: vi.fn().mockResolvedValue([]),
    getHubById: vi.fn().mockResolvedValue(null),
    createHub: vi.fn().mockResolvedValue('hub-id'),
    linkToHub: vi.fn().mockResolvedValue(undefined),
    unlinkFromHub: vi.fn().mockResolvedValue(undefined),
    getHubMembers: vi.fn().mockResolvedValue([]),
    incrementHubAccessCount: vi.fn().mockResolvedValue(undefined),
    createVersion: vi.fn().mockResolvedValue('v-id'),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    getInhibitoryMemories: vi.fn().mockResolvedValue([]),
    getColdStorageMemories: vi.fn().mockResolvedValue([]),
    moveToColdStorage: vi.fn().mockResolvedValue(undefined),
    resurrectFromColdStorage: vi.fn().mockResolvedValue(undefined),
    getConstraints: vi.fn().mockResolvedValue([]),
    insertConstraint: vi.fn().mockResolvedValue('c-id'),
    deactivateConstraint: vi.fn().mockResolvedValue(undefined),
    getCausalChain: vi.fn().mockResolvedValue([]),
    insertSelfPlayRun: vi.fn().mockResolvedValue('sp-id'),
    updateSelfPlayRun: vi.fn().mockResolvedValue(undefined),
    insertSelfPlayResult: vi.fn().mockResolvedValue('spr-id'),
    getSelfPlayResults: vi.fn().mockResolvedValue([]),
    getLatestSelfPlayRun: vi.fn().mockResolvedValue(null),
    getFrozenMemories: vi.fn().mockResolvedValue([]),
    freezeMemory: vi.fn().mockResolvedValue(undefined),
    unfreezeMemory: vi.fn().mockResolvedValue(undefined),
    getMetaMemoryStats: vi.fn().mockResolvedValue({
      totalMemories: 0,
      topSubjects: [],
      coverageGaps: [],
      stalestMemories: [],
      mostAccessed: [],
      inhibitoryCount: 0,
      frozenCount: 0,
      coldStorageCount: 0,
      hubCount: 0,
    }),
    incrementCorrectionCount: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMemoryRepository;
}

// --- Tests ---

describe('CoreDispatch', () => {
  describe('search', () => {
    it('returns injection payload and context text', async () => {
      const repo = createMockRepo();
      const record = makeRecord({ trustClass: TrustClass.AUTO_APPROVED, subject: 'prefs' });
      mockRetrieve.mockResolvedValue({
        candidates: [makeScoredCandidate(record)],
        metadata: {
          query: 'test',
          candidatesGenerated: 2,
          candidatesAfterFilter: 1,
          candidatesReturned: 1,
          timings: { lexicalMs: 1, vectorMs: 1, mergeAndScoreMs: 1, totalMs: 3 },
        },
      });

      const dispatch = createCoreDispatch(repo, mockConfig());
      const result = await dispatch.search('test');

      expect(result.payload.memories).toHaveLength(1);
      expect(result.contextText).toContain('Memory Context');
      expect(result.raw.candidates).toHaveLength(1);
    });

    it('throws CircuitBreakerActiveError when locked', async () => {
      const repo = createMockRepo();
      const old = new Date(Date.now() - 60 * 86400000).toISOString();
      (repo.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(old);

      const dispatch = createCoreDispatch(repo, mockConfig());
      const { CircuitBreakerActiveError } = await import('../../src/errors.js');
      await expect(dispatch.search('test')).rejects.toThrow(CircuitBreakerActiveError);
    });

    it('records access via decay tracker', async () => {
      const repo = createMockRepo();
      const record = makeRecord();
      mockRetrieve.mockResolvedValue({
        candidates: [makeScoredCandidate(record)],
        metadata: {
          query: 'test',
          candidatesGenerated: 1,
          candidatesAfterFilter: 1,
          candidatesReturned: 1,
          timings: { lexicalMs: 1, vectorMs: 1, mergeAndScoreMs: 1, totalMs: 3 },
        },
      });

      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.search('test');

      // Give fire-and-forget a tick
      await new Promise((r) => setTimeout(r, 10));
      expect(repo.incrementAccessCount).toHaveBeenCalled();
    });
  });

  describe('addMemory', () => {
    it('delegates to write pipeline', async () => {
      const repo = createMockRepo();
      mockWriteMemory.mockResolvedValue({
        id: uuid(),
        trustClass: TrustClass.AUTO_APPROVED,
        action: 'stored',
        reason: 'Auto-approved',
      });

      const dispatch = createCoreDispatch(repo, mockConfig());
      const result = await dispatch.addMemory({ claim: 'Test claim' });

      expect(mockWriteMemory).toHaveBeenCalled();
      expect(result.action).toBe('stored');
    });

    it('records activity on non-rejected write', async () => {
      const repo = createMockRepo();
      mockWriteMemory.mockResolvedValue({
        id: uuid(),
        trustClass: TrustClass.AUTO_APPROVED,
        action: 'stored',
        reason: 'Auto-approved',
      });

      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.addMemory({ claim: 'Test' });

      await new Promise((r) => setTimeout(r, 10));
      expect(repo.setMetadata).toHaveBeenCalledWith('last_activity', expect.any(String));
    });

    it('skips activity recording on rejected write', async () => {
      const repo = createMockRepo();
      mockWriteMemory.mockResolvedValue({
        id: uuid(),
        trustClass: TrustClass.REJECTED,
        action: 'rejected',
        reason: 'Duplicate',
      });

      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.addMemory({ claim: 'Test' });

      await new Promise((r) => setTimeout(r, 10));
      // setMetadata is called by circuitBreaker init check, but NOT by recordActivity
      expect(repo.setMetadata).not.toHaveBeenCalledWith('last_activity', expect.any(String));
    });
  });

  describe('confirmMemory', () => {
    it('updates trust class and logs audit', async () => {
      const repo = createMockRepo();
      const memory = makeRecord({ trustClass: TrustClass.QUARANTINED });
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(memory);

      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.confirmMemory(memory.id, 'Verified by user');

      expect(repo.update).toHaveBeenCalledWith(
        memory.id,
        expect.objectContaining({
          trustClass: TrustClass.CONFIRMED,
          reviewStatus: ReviewStatus.APPROVED,
        }),
      );
      expect(repo.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryId: memory.id,
          action: 'confirmed',
        }),
      );
    });

    it('throws MemoryNotFoundError for missing memory', async () => {
      const repo = createMockRepo();
      const dispatch = createCoreDispatch(repo, mockConfig());
      const { MemoryNotFoundError } = await import('../../src/errors.js');
      await expect(dispatch.confirmMemory('nope')).rejects.toThrow(MemoryNotFoundError);
    });

    it('throws ValidationError for invalid transition', async () => {
      const repo = createMockRepo();
      const memory = makeRecord({ trustClass: TrustClass.CONFIRMED });
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(memory);

      const dispatch = createCoreDispatch(repo, mockConfig());
      const { ValidationError } = await import('../../src/errors.js');
      await expect(dispatch.confirmMemory(memory.id)).rejects.toThrow(ValidationError);
    });
  });

  describe('rejectMemory', () => {
    it('updates trust class and logs audit', async () => {
      const repo = createMockRepo();
      const memory = makeRecord({ trustClass: TrustClass.QUARANTINED });
      (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(memory);

      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.rejectMemory(memory.id, 'Not useful');

      expect(repo.update).toHaveBeenCalledWith(
        memory.id,
        expect.objectContaining({
          trustClass: TrustClass.REJECTED,
          reviewStatus: ReviewStatus.REJECTED,
        }),
      );
      expect(repo.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'rejected',
        }),
      );
    });
  });

  describe('getStats', () => {
    it('assembles SystemStats', async () => {
      const repo = createMockRepo();
      const dispatch = createCoreDispatch(repo, mockConfig());
      const stats = await dispatch.getStats();

      expect(stats.totalMemories).toBe(0);
      expect(typeof stats.circuitBreakerActive).toBe('boolean');
      expect(typeof stats.uptimeSeconds).toBe('number');
      expect(stats.thompsonShadowEnabled).toBe(false);
    });
  });

  describe('exportBrain', () => {
    it('logs audit entry and returns iterable', async () => {
      const repo = createMockRepo();
      const dispatch = createCoreDispatch(repo, mockConfig());
      const iterable = await dispatch.exportBrain();

      expect(repo.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'export',
        }),
      );
      expect(iterable).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('flushes Thompson shadow log', async () => {
      const repo = createMockRepo();
      const dispatch = createCoreDispatch(repo, mockConfig());
      await dispatch.shutdown();

      expect(mockFlushShadowLog).toHaveBeenCalled();
    });
  });
});
