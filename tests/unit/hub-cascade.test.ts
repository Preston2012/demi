import { describe, it, expect, vi, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

let applyCascade: typeof import('../../src/retrieval/hub-cascade.js').applyCascade;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/retrieval/hub-cascade.js');
  applyCascade = mod.applyCascade;
});

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Test claim',
    subject: 'test',
    scope: 'global',
    validFrom: null,
    validTo: null,
    provenance: 'llm-extracted-confident',
    trustClass: 'auto-approved',
    confidence: 0.8,
    sourceHash: 'h',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: 'approved',
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
  } as MemoryRecord;
}

function makeCandidate(overrides: { id?: string; subject?: string; score?: number } = {}): FinalScoredCandidate {
  const id = overrides.id ?? uuid();
  const record = makeRecord({ id, subject: overrides.subject ?? 'test' });
  return {
    id,
    candidate: {
      id,
      record,
      lexicalScore: 0.5,
      vectorScore: 0.5,
      source: 'fts',
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    },
    finalScore: overrides.score ?? 0.7,
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

function mockRepo(
  hubLinks: Record<string, { hubId: string }[]> = {},
  hubs: Record<string, { id: string; claim: string; hubType: string; createdAt: string; accessCount: number }> = {},
): IMemoryRepository {
  return {
    getHubLinks: vi.fn().mockImplementation(async (memoryId: string) => hubLinks[memoryId] ?? []),
    getHubById: vi.fn().mockImplementation(async (hubId: string) => hubs[hubId] ?? null),
    incrementHubAccessCount: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMemoryRepository;
}

describe('Hub Cascade', () => {
  it('returns empty for no candidates', async () => {
    const repo = mockRepo();
    const result = await applyCascade(repo, [], 15);
    expect(result.candidates).toHaveLength(0);
    expect(result.hubsInjected).toHaveLength(0);
  });

  it('passes through when no hub links exist', async () => {
    const repo = mockRepo();
    const candidates = [makeCandidate(), makeCandidate()];
    const result = await applyCascade(repo, candidates, 15);
    expect(result.candidates).toHaveLength(2);
    expect(result.hubsInjected).toHaveLength(0);
  });

  it('injects hub when spoke has link', async () => {
    const spokeId = uuid();
    const hubId = uuid();
    const repo = mockRepo(
      { [spokeId]: [{ hubId, memoryId: spokeId, linkedAt: new Date().toISOString() }] },
      {
        [hubId]: {
          id: hubId,
          claim: 'Always use DI',
          hubType: 'principle',
          createdAt: new Date().toISOString(),
          accessCount: 5,
        },
      },
    );
    const candidates = [makeCandidate({ id: spokeId })];
    const result = await applyCascade(repo, candidates, 15);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.hubsInjected).toContain(hubId);
    // Hub should be first (principles before implementations)
    expect(result.candidates[0]!.id).toBe(hubId);
  });

  it('does not inject hub already in results', async () => {
    const hubId = uuid();
    const spokeId = uuid();
    const repo = mockRepo(
      { [spokeId]: [{ hubId, memoryId: spokeId, linkedAt: new Date().toISOString() }] },
      {
        [hubId]: {
          id: hubId,
          claim: 'Principle',
          hubType: 'principle',
          createdAt: new Date().toISOString(),
          accessCount: 3,
        },
      },
    );
    // Hub is already in the candidate list
    const candidates = [makeCandidate({ id: hubId }), makeCandidate({ id: spokeId })];
    const result = await applyCascade(repo, candidates, 15);
    expect(result.hubsInjected).toHaveLength(0);
    expect(result.candidates).toHaveLength(2);
  });

  it('respects maxTotal limit', async () => {
    const spokeId = uuid();
    const hubId = uuid();
    const repo = mockRepo(
      { [spokeId]: [{ hubId, memoryId: spokeId, linkedAt: new Date().toISOString() }] },
      {
        [hubId]: {
          id: hubId,
          claim: 'Principle',
          hubType: 'principle',
          createdAt: new Date().toISOString(),
          accessCount: 1,
        },
      },
    );
    // 2 candidates + 1 hub = 3, but maxTotal = 2
    const candidates = [makeCandidate({ id: spokeId }), makeCandidate()];
    const result = await applyCascade(repo, candidates, 2);
    expect(result.candidates).toHaveLength(2);
  });

  it('increments hub access count', async () => {
    const spokeId = uuid();
    const hubId = uuid();
    const repo = mockRepo(
      { [spokeId]: [{ hubId, memoryId: spokeId, linkedAt: new Date().toISOString() }] },
      {
        [hubId]: {
          id: hubId,
          claim: 'Principle',
          hubType: 'principle',
          createdAt: new Date().toISOString(),
          accessCount: 0,
        },
      },
    );
    await applyCascade(repo, [makeCandidate({ id: spokeId })], 15);
    // Give fire-and-forget a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.incrementHubAccessCount).toHaveBeenCalledWith(hubId);
  });
});
