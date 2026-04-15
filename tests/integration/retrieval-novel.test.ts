import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { Config } from '../../src/config.js';
import type { ScoredCandidate, MemoryRecord } from '../../src/schema/memory.js';

vi.mock('../../src/embeddings/index.js', () => ({
  isInitialized: () => false,
  encode: async () => [],
}));

let retrieve: typeof import('../../src/retrieval/index.js').retrieve;
let config: Config;

const now = new Date().toISOString();

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
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
    sourceHash: 'h',
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

function makeCandidate(overrides: Partial<MemoryRecord> = {}): ScoredCandidate {
  const record = makeRecord(overrides);
  return {
    id: record.id,
    record,
    lexicalScore: 0.8,
    vectorScore: 0,
    source: 'fts',
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
}

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  config = loadConfig();
  const mod = await import('../../src/retrieval/index.js');
  retrieve = mod.retrieve;
});

describe('Retrieval pipeline (novel features)', () => {
  let repo: IMemoryRepository;

  beforeEach(() => {
    repo = {
      searchFTS: vi.fn().mockResolvedValue([]),
      searchVector: vi.fn().mockResolvedValue([]),
      getActiveInhibitions: vi.fn().mockResolvedValue([]),
      getHubLinks: vi.fn().mockResolvedValue([]),
      getHubById: vi.fn().mockResolvedValue(null),
      incrementHubAccessCount: vi.fn().mockResolvedValue(undefined),
      incrementAccessCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryRepository;
  });

  it('excludes cold storage memories from results', async () => {
    const active = makeCandidate({ claim: 'Active memory' });
    const cold = makeCandidate({
      claim: 'Cold memory',
      interferenceStatus: 'cold' as MemoryRecord['interferenceStatus'],
    });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([active, cold]);

    const result = await retrieve(repo, 'test query', config);
    const claims = result.candidates.map((c) => c.candidate.record.claim);
    expect(claims).toContain('Active memory');
    expect(claims).not.toContain('Cold memory');
  });

  it('excludes inhibitory memories from injection', async () => {
    const normal = makeCandidate({ claim: 'Normal memory' });
    const inhibitory = makeCandidate({
      claim: 'Do not use X',
      isInhibitory: true,
      inhibitionTarget: 'x',
    });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([normal, inhibitory]);

    const result = await retrieve(repo, 'test query', config);
    const claims = result.candidates.map((c) => c.candidate.record.claim);
    expect(claims).toContain('Normal memory');
    expect(claims).not.toContain('Do not use X');
  });

  it('suppresses memories targeted by inhibitions', async () => {
    const targetedMemory = makeCandidate({
      claim: 'Old flutter pattern',
      subject: 'flutter',
      confidence: 0.7,
    });
    const otherMemory = makeCandidate({ claim: 'TypeScript tip', subject: 'typescript' });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([targetedMemory, otherMemory]);

    (repo.getActiveInhibitions as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRecord({ isInhibitory: true, inhibitionTarget: 'flutter', confidence: 0.9 }),
    ]);

    const result = await retrieve(repo, 'coding tips', config);
    const subjects = result.candidates.map((c) => c.candidate.record.subject);
    expect(subjects).not.toContain('flutter');
    expect(subjects).toContain('typescript');
  });

  it('does not suppress when inhibition confidence is lower than memory confidence', async () => {
    const strongMemory = makeCandidate({
      claim: 'Important flutter rule',
      subject: 'flutter',
      confidence: 0.95,
    });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([strongMemory]);

    (repo.getActiveInhibitions as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRecord({ isInhibitory: true, inhibitionTarget: 'flutter', confidence: 0.5 }),
    ]);

    const result = await retrieve(repo, 'flutter', config);
    expect(result.candidates.length).toBe(1);
  });

  it('frozen memories skip freshness decay', async () => {
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const frozenOld = makeCandidate({
      claim: 'Frozen old memory',
      isFrozen: true,
      updatedAt: oldDate,
      lastAccessed: oldDate,
    });
    const unfrozenOld = makeCandidate({
      claim: 'Unfrozen old memory',
      isFrozen: false,
      updatedAt: oldDate,
      lastAccessed: oldDate,
    });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([frozenOld, unfrozenOld]);

    const result = await retrieve(repo, 'test', config);
    const frozenScore =
      result.candidates.find((c) => c.candidate.record.claim === 'Frozen old memory')?.finalScore ?? 0;
    const unfrozenScore =
      result.candidates.find((c) => c.candidate.record.claim === 'Unfrozen old memory')?.finalScore ?? 0;
    expect(frozenScore).toBeGreaterThan(unfrozenScore);
  });

  it('hub cascade injects hub when spoke is retrieved', async () => {
    const spoke = makeCandidate({ claim: 'Specific implementation detail' });
    (repo.searchFTS as ReturnType<typeof vi.fn>).mockResolvedValue([spoke]);
    (repo.getHubLinks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { memoryId: spoke.id, hubId: 'hub-1', linkedAt: now },
    ]);
    (repo.getHubById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'hub-1',
      claim: 'Quality gates before processing',
      hubType: 'principle',
      createdAt: now,
      accessCount: 50,
    });

    const result = await retrieve(repo, 'implementation', config);
    const claims = result.candidates.map((c) => c.candidate.record.claim);
    expect(claims).toContain('Quality gates before processing');
    expect(claims).toContain('Specific implementation detail');
  });
});
