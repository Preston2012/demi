import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { Config } from '../../src/config.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

// Mock the retrieval module before any imports that reference it
vi.mock('../../src/retrieval/index.js', () => ({
  retrieve: vi.fn().mockResolvedValue({
    candidates: [],
    metadata: {
      query: '',
      candidatesGenerated: 0,
      candidatesAfterFilter: 0,
      candidatesReturned: 0,
      timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
    },
  }),
}));

let runSelfPlay: typeof import('../../src/learn/self-play.js').runSelfPlay;
let retrieve: typeof import('../../src/retrieval/index.js').retrieve;
let config: Config;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  config = loadConfig();

  const mod = await import('../../src/learn/self-play.js');
  runSelfPlay = mod.runSelfPlay;

  const retMod = await import('../../src/retrieval/index.js');
  retrieve = retMod.retrieve;
});

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    claim: 'TypeScript uses structural typing',
    subject: 'TypeScript',
    scope: 'global',
    validFrom: null,
    validTo: null,
    provenance: 'user-confirmed',
    trustClass: 'confirmed',
    confidence: 0.95,
    sourceHash: 'abc123',
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
  };
}

function mockRepo(memories: MemoryRecord[] = []): IMemoryRepository {
  return {
    exportAll: async function* () {
      for (const m of memories) {
        yield m;
      }
    },
    insertSelfPlayRun: vi.fn().mockResolvedValue('run-id'),
    updateSelfPlayRun: vi.fn().mockResolvedValue(undefined),
    insertSelfPlayResult: vi.fn().mockResolvedValue('result-id'),
    appendAuditLog: vi.fn().mockResolvedValue({
      id: 'audit-1',
      memoryId: null,
      action: 'self-play-started',
      details: '',
      previousHash: null,
      hash: 'h1',
      timestamp: new Date().toISOString(),
    }),
  } as unknown as IMemoryRepository;
}

describe('runSelfPlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes with 0 queries when memory store is empty', async () => {
    const repo = mockRepo([]);

    const result = await runSelfPlay(repo, config, { queriesPerRun: 10 });

    expect(result.queriesGenerated).toBe(0);
    expect(result.retrievalsPassed).toBe(0);
    expect(result.retrievalsFailed).toBe(0);
    expect(result.notes).toBe('No eligible memories to test');
    expect(result.completedAt).not.toBeNull();
    expect(repo.insertSelfPlayRun).toHaveBeenCalledOnce();
    expect(repo.updateSelfPlayRun).toHaveBeenCalledOnce();
    // No retrieval calls should have been made
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('skips memories that are not confirmed or auto-approved', async () => {
    const quarantined = makeMemoryRecord({ trustClass: 'quarantined', id: '11111111-1111-1111-1111-111111111111' });
    const rejected = makeMemoryRecord({ trustClass: 'rejected', id: '22222222-2222-2222-2222-222222222222' });
    const repo = mockRepo([quarantined, rejected]);

    const result = await runSelfPlay(repo, config, { queriesPerRun: 10 });

    expect(result.queriesGenerated).toBe(0);
    expect(result.notes).toBe('No eligible memories to test');
  });

  it('result structure has id, startedAt, completedAt, and notes', async () => {
    const repo = mockRepo([]);

    const result = await runSelfPlay(repo, config);

    expect(result).toHaveProperty('id');
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);

    expect(result).toHaveProperty('startedAt');
    expect(typeof result.startedAt).toBe('string');
    // Should be a valid ISO date
    expect(() => new Date(result.startedAt)).not.toThrow();
    expect(new Date(result.startedAt).getTime()).not.toBeNaN();

    expect(result).toHaveProperty('completedAt');
    expect(result.completedAt).not.toBeNull();
    expect(typeof result.completedAt).toBe('string');

    expect(result).toHaveProperty('notes');
    expect(typeof result.notes).toBe('string');
  });

  it('calls retrieve for each sampled confirmed memory', async () => {
    const mem1 = makeMemoryRecord({
      id: '11111111-1111-1111-1111-111111111111',
      claim: 'TypeScript uses structural typing for type checking',
      subject: 'TypeScript',
      trustClass: 'confirmed',
    });
    const mem2 = makeMemoryRecord({
      id: '22222222-2222-2222-2222-222222222222',
      claim: 'Rust uses ownership and borrowing for memory safety',
      subject: 'Rust',
      trustClass: 'auto-approved',
    });

    const repo = mockRepo([mem1, mem2]);

    // Mock retrieve to return empty results (memory not found)
    vi.mocked(retrieve).mockResolvedValue({
      candidates: [],
      metadata: {
        query: '',
        candidatesGenerated: 0,
        candidatesAfterFilter: 0,
        candidatesReturned: 0,
        timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
      },
    });

    const result = await runSelfPlay(repo, config, { queriesPerRun: 10 });

    expect(result.queriesGenerated).toBe(2);
    expect(retrieve).toHaveBeenCalledTimes(2);
    // Both memories not found in empty results => all fail
    expect(result.retrievalsFailed).toBe(2);
    expect(result.retrievalsPassed).toBe(0);
  });

  it('counts retrieval as passed when source memory is in results', async () => {
    const memId = '11111111-1111-1111-1111-111111111111';
    const mem = makeMemoryRecord({
      id: memId,
      claim: 'TypeScript uses structural typing for type checking',
      subject: 'TypeScript',
      trustClass: 'confirmed',
    });

    const repo = mockRepo([mem]);

    vi.mocked(retrieve).mockResolvedValue({
      candidates: [{ id: memId, finalScore: 0.9, candidate: {} as any }],
      metadata: {
        query: 'TypeScript structural typing',
        candidatesGenerated: 1,
        candidatesAfterFilter: 1,
        candidatesReturned: 1,
        timings: { lexicalMs: 1, vectorMs: 1, mergeAndScoreMs: 1, totalMs: 3 },
      },
    });

    const result = await runSelfPlay(repo, config, { queriesPerRun: 10 });

    expect(result.queriesGenerated).toBe(1);
    expect(result.retrievalsPassed).toBe(1);
    expect(result.retrievalsFailed).toBe(0);
    expect(result.notes).toContain('100.0%');
    expect(repo.insertSelfPlayResult).toHaveBeenCalledOnce();

    const insertCall = vi.mocked(repo.insertSelfPlayResult).mock.calls[0][0];
    expect(insertCall.passed).toBe(true);
    expect(insertCall.expectedMemoryId).toBe(memId);
    expect(insertCall.actualMemoryId).toBe(memId);
  });

  it('respects queriesPerRun limit', async () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemoryRecord({
        id: `${String(i + 1).padStart(8, '0')}-0000-0000-0000-000000000000`,
        claim: `Fact number ${i + 1} about programming languages`,
        subject: `Subject${i}`,
        trustClass: 'confirmed',
      }),
    );

    const repo = mockRepo(memories);
    vi.mocked(retrieve).mockResolvedValue({
      candidates: [],
      metadata: {
        query: '',
        candidatesGenerated: 0,
        candidatesAfterFilter: 0,
        candidatesReturned: 0,
        timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
      },
    });

    const result = await runSelfPlay(repo, config, { queriesPerRun: 5 });

    expect(result.queriesGenerated).toBe(5);
    expect(retrieve).toHaveBeenCalledTimes(5);
  });

  it('logs audit entries for start and completion', async () => {
    const mem = makeMemoryRecord({ trustClass: 'confirmed' });
    const repo = mockRepo([mem]);

    vi.mocked(retrieve).mockResolvedValue({
      candidates: [],
      metadata: {
        query: '',
        candidatesGenerated: 0,
        candidatesAfterFilter: 0,
        candidatesReturned: 0,
        timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
      },
    });

    await runSelfPlay(repo, config, { queriesPerRun: 1 });

    const auditCalls = vi.mocked(repo.appendAuditLog).mock.calls;
    // At least 2 audit entries: started + completed
    expect(auditCalls.length).toBeGreaterThanOrEqual(2);
    expect(auditCalls[0][0].action).toBe('self-play-started');
    expect(auditCalls[auditCalls.length - 1][0].action).toBe('self-play-completed');
  });
});
