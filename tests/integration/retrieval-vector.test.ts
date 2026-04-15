import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  Provenance,
  TrustClass,
  ReviewStatus,
  Scope,
  type MemoryRecord,
  type ScoredCandidate,
} from '../../src/schema/memory.js';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { Config } from '../../src/config.js';

// Mock embeddings: vector path ENABLED
const mockEncode = vi.fn();
vi.mock('../../src/embeddings/index.js', () => ({
  encode: (...args: unknown[]) => mockEncode(...args),
  isInitialized: vi.fn().mockReturnValue(true),
}));

let retrieve: typeof import('../../src/retrieval/index.js').retrieve;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/retrieval/index.js');
  retrieve = mod.retrieve;
});

beforeEach(() => {
  mockEncode.mockReset();
  mockEncode.mockResolvedValue(new Array(1024).fill(0.1));
});

// --- Helpers ---

function mockConfig(overrides: Partial<Config> = {}): Config {
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
    spotCheckRate: 0.1,
    consensusThreshold: 0.5,
    consensusProvider: 'anthropic',
    consensusModel: 'claude-sonnet-4-20250514',
    consensusMinAgreement: 2,
    inactivityLockDays: 30,
    writeRatePerMinute: 100,
    readRatePerMinute: 1000,
    auditSnapshotIntervalHours: 24,
    backupPath: '/tmp/demiurge-test-vec',
    thompsonShadowEnabled: false,
    logLevel: 'error',
    ...overrides,
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
    trustClass: TrustClass.AUTO_APPROVED,
    confidence: 0.8,
    sourceHash: 'h-' + uuid().slice(0, 8),
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

function candidateFrom(record: MemoryRecord, lex: number, vec: number, src: 'fts' | 'vector' = 'fts'): ScoredCandidate {
  return {
    id: record.id,
    record,
    lexicalScore: lex,
    vectorScore: vec,
    source: src,
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
}

function createMockRepo(fts: ScoredCandidate[] = [], vec: ScoredCandidate[] = []): IMemoryRepository {
  return {
    searchFTS: vi.fn().mockResolvedValue(fts),
    searchVector: vi.fn().mockResolvedValue(vec),
    initialize: vi.fn(),
    close: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    getById: vi.fn(),
    getByIds: vi.fn(),
    getConflicts: vi.fn(),
    findBySourceHash: vi.fn(),
    findSimilar: vi.fn(),
    getPendingReview: vi.fn(),
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
    getActiveInhibitions: vi.fn().mockResolvedValue([]),
    getHubLinks: vi.fn().mockResolvedValue([]),
  } as unknown as IMemoryRepository;
}

// --- Tests ---

describe('Retrieval pipeline (vector enabled)', () => {
  const config = mockConfig();

  it('calls encode() when vector is initialized', async () => {
    const repo = createMockRepo([], []);
    await retrieve(repo, 'dark mode preference', config);
    expect(mockEncode).toHaveBeenCalledWith(
      'Represent this sentence for searching relevant passages: dark mode preference',
    );
  });

  it('calls searchVector with encoded embedding', async () => {
    const repo = createMockRepo([], []);
    await retrieve(repo, 'test query', config);
    expect(repo.searchVector).toHaveBeenCalledWith(expect.arrayContaining([0.1]), expect.any(Number));
  });

  it('returns vector-only candidates when FTS returns empty', async () => {
    const r = makeRecord({ claim: 'User prefers dark mode' });
    const repo = createMockRepo([], [candidateFrom(r, 0, 0.85, 'vector')]);
    const result = await retrieve(repo, 'theme preference', config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe(r.id);
    expect(result.candidates[0]!.candidate.source).toBe('vector');
  });

  it('vector score contributes to final ranking', async () => {
    const now = new Date().toISOString();
    const highVec = makeRecord({ claim: 'High vector', updatedAt: now });
    const highLex = makeRecord({ claim: 'High lexical', updatedAt: now });
    const repo = createMockRepo([candidateFrom(highLex, 0.9, 0, 'fts')], [candidateFrom(highVec, 0, 0.9, 'vector')]);
    const result = await retrieve(repo, 'test', config);
    // Vector weight (0.4) > lexical weight (0.3), so high vector wins
    expect(result.candidates[0]!.id).toBe(highVec.id);
  });

  it('degrades to lexical-only when encode() throws EmbeddingError', async () => {
    const { EmbeddingError } = await import('../../src/errors.js');
    mockEncode.mockRejectedValueOnce(new EmbeddingError('Model crashed'));

    const r = makeRecord();
    const repo = createMockRepo([candidateFrom(r, 0.8, 0)], []);
    const result = await retrieve(repo, 'test', config);
    // Should still return lexical results
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe(r.id);
  });

  it('propagates non-EmbeddingError from encode()', async () => {
    mockEncode.mockRejectedValueOnce(new TypeError('Unexpected null'));

    const repo = createMockRepo([], []);
    await expect(retrieve(repo, 'test', config)).rejects.toThrow(TypeError);
  });

  it('merges same ID from FTS and vector with combined scores', async () => {
    const r = makeRecord();
    const repo = createMockRepo([candidateFrom(r, 0.7, 0, 'fts')], [candidateFrom(r, 0, 0.8, 'vector')]);
    const result = await retrieve(repo, 'test', config);
    expect(result.candidates).toHaveLength(1);
    expect(result.metadata.candidatesGenerated).toBe(1);
    // Both score components should contribute
    const breakdown = result.candidates[0]!.scoreBreakdown;
    expect(breakdown.lexicalComponent).toBeGreaterThan(0);
    expect(breakdown.vectorComponent).toBeGreaterThan(0);
  });
});
