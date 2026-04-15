import { describe, it, expect, vi, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { Config } from '../../src/config.js';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import {
  Provenance,
  TrustClass,
  ReviewStatus,
  Scope,
  type MemoryRecord,
  type ScoredCandidate,
} from '../../src/schema/memory.js';

// Mock embeddings module so vector search works without ONNX model
vi.mock('../../src/embeddings/index.js', () => ({
  isInitialized: () => true,
  encode: async () => new Array(1024).fill(0),
}));

// Dynamic import to avoid module-level createLogger before config is loaded
let retrieve: (typeof import('../../src/retrieval/index.js'))['retrieve'];

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';

  const { loadConfig } = await import('../../src/config.js');
  loadConfig();

  const retrieval = await import('../../src/retrieval/index.js');
  retrieve = retrieval.retrieve;
});

// --- Mock config ---

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
    backupPath: '/tmp/demiurge-test-backups',
    thompsonShadowEnabled: false,
    logLevel: 'error',
    ...overrides,
  } as Config;
}

// --- Mock record factory ---

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Test memory claim',
    subject: 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.AUTO_APPROVED,
    confidence: 0.8,
    sourceHash: 'hash-' + uuid().slice(0, 8),
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

function candidateFrom(
  record: MemoryRecord,
  lexical: number,
  vector: number,
  source: 'fts' | 'vector' = 'fts',
): ScoredCandidate {
  return {
    id: record.id,
    record,
    lexicalScore: lexical,
    vectorScore: vector,
    source,
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
}

// --- Mock repository ---

function createMockRepo(ftsResults: ScoredCandidate[] = [], vectorResults: ScoredCandidate[] = []): IMemoryRepository {
  return {
    searchFTS: vi.fn().mockResolvedValue(ftsResults),
    searchVector: vi.fn().mockResolvedValue(vectorResults),
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

describe('Retrieval pipeline', () => {
  const config = mockConfig();

  it('returns empty results for no candidates', async () => {
    const repo = createMockRepo([], []);
    const result = await retrieve(repo, 'test query', config);
    expect(result.candidates).toHaveLength(0);
    expect(result.metadata.candidatesGenerated).toBe(0);
  });

  it('returns lexical-only results when vector returns nothing', async () => {
    const record = makeRecord();
    const fts = [candidateFrom(record, 0.8, 0, 'fts')];
    const repo = createMockRepo(fts, []);
    const result = await retrieve(repo, 'test', config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe(record.id);
  });

  it('returns vector-only results when lexical returns nothing', async () => {
    const record = makeRecord();
    const vec = [candidateFrom(record, 0, 0.9, 'vector')];
    const repo = createMockRepo([], vec);
    const result = await retrieve(repo, 'test', config);
    expect(result.candidates).toHaveLength(1);
  });

  it('merges candidates from both sources', async () => {
    const r1 = makeRecord({ claim: 'Lexical match' });
    const r2 = makeRecord({ claim: 'Vector match' });
    const r3 = makeRecord({ claim: 'Both match' });

    const fts = [candidateFrom(r1, 0.9, 0, 'fts'), candidateFrom(r3, 0.6, 0, 'fts')];
    const vec = [candidateFrom(r2, 0, 0.8, 'vector'), candidateFrom(r3, 0, 0.7, 'vector')];

    const repo = createMockRepo(fts, vec);
    const result = await retrieve(repo, 'test', config);

    expect(result.metadata.candidatesGenerated).toBe(3);
    expect(result.candidates.length).toBeLessThanOrEqual(config.maxInjectedRules);
  });

  it('filters out quarantined memories', async () => {
    const confirmed = makeRecord({ trustClass: TrustClass.CONFIRMED });
    const quarantined = makeRecord({ trustClass: TrustClass.QUARANTINED });

    const fts = [candidateFrom(confirmed, 0.9, 0), candidateFrom(quarantined, 0.95, 0)];

    const repo = createMockRepo(fts, []);
    const result = await retrieve(repo, 'test', config);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe(confirmed.id);
  });

  it('filters out rejected memories', async () => {
    const good = makeRecord({ trustClass: TrustClass.AUTO_APPROVED });
    const rejected = makeRecord({ trustClass: TrustClass.REJECTED });

    const fts = [candidateFrom(good, 0.5, 0), candidateFrom(rejected, 0.9, 0)];
    const repo = createMockRepo(fts, []);
    const result = await retrieve(repo, 'test', config);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe(good.id);
  });

  it('respects limit parameter', async () => {
    const records = Array.from({ length: 20 }, () => makeRecord());
    const fts = records.map((r, i) => candidateFrom(r, 1 - i * 0.05, 0));
    const repo = createMockRepo(fts, []);

    const result = await retrieve(repo, 'test', config, 5);
    expect(result.candidates).toHaveLength(5);
    expect(result.metadata.candidatesReturned).toBe(5);
  });

  it('includes timing metadata', async () => {
    const repo = createMockRepo([], []);
    const result = await retrieve(repo, 'test', config);
    expect(result.metadata.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timings.lexicalMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timings.vectorMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timings.mergeAndScoreMs).toBeGreaterThanOrEqual(0);
  });

  it('confirmed memory outranks auto-approved with same search scores', async () => {
    const now = new Date();
    const confirmedRecord = makeRecord({
      trustClass: TrustClass.CONFIRMED,
      provenance: Provenance.USER_CONFIRMED,
      updatedAt: now.toISOString(),
    });
    const autoRecord = makeRecord({
      trustClass: TrustClass.AUTO_APPROVED,
      provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
      updatedAt: now.toISOString(),
    });

    const fts = [candidateFrom(autoRecord, 0.7, 0), candidateFrom(confirmedRecord, 0.7, 0)];

    const repo = createMockRepo(fts, []);
    const result = await retrieve(repo, 'test', config);

    expect(result.candidates[0]!.id).toBe(confirmedRecord.id);
  });

  it('penalizes conflicted memories', async () => {
    const clean = makeRecord({ conflictsWith: [] });
    const conflicted = makeRecord({ conflictsWith: [uuid()] });

    const fts = [candidateFrom(conflicted, 0.9, 0), candidateFrom(clean, 0.9, 0)];

    const repo = createMockRepo(fts, []);
    const result = await retrieve(repo, 'test', config);

    // Clean should rank higher despite same lexical score (no contradiction penalty)
    expect(result.candidates[0]!.id).toBe(clean.id);
  });
});
