import { describe, it, expect, vi, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

let identifyHubCandidates: typeof import('../../src/learn/hub-computation.js').identifyHubCandidates;
let promoteToHub: typeof import('../../src/learn/hub-computation.js').promoteToHub;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/learn/hub-computation.js');
  identifyHubCandidates = mod.identifyHubCandidates;
  promoteToHub = mod.promoteToHub;
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
    provenance: 'user-confirmed',
    trustClass: 'confirmed',
    confidence: 0.9,
    sourceHash: 'h',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: 'approved',
    accessCount: 15,
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

function mockRepo(memories: MemoryRecord[]): IMemoryRepository {
  return {
    exportAll: vi.fn().mockImplementation(async function* () {
      for (const m of memories) yield m;
    }),
    getHubLinks: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockImplementation(async (id: string) => memories.find((m) => m.id === id) ?? null),
    createHub: vi.fn().mockResolvedValue('hub-id'),
    linkToHub: vi.fn().mockResolvedValue(undefined),
    appendAuditLog: vi.fn().mockResolvedValue({ id: uuid() }),
  } as unknown as IMemoryRepository;
}

describe('identifyHubCandidates', () => {
  it('returns empty when no confirmed memories', async () => {
    const memories = [makeRecord({ trustClass: 'auto-approved' as MemoryRecord['trustClass'] })];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo);
    expect(candidates).toHaveLength(0);
  });

  it('finds high-access confirmed memories', async () => {
    const memories = [
      makeRecord({ claim: 'Always use DI', accessCount: 20 }),
      makeRecord({ claim: 'Low access', accessCount: 2 }),
    ];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.claim).toBe('Always use DI');
  });

  it('respects minAccessCount filter', async () => {
    const memories = [makeRecord({ accessCount: 5 })];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10);
    expect(candidates).toHaveLength(0);
  });

  it('respects maxClaimLength filter', async () => {
    const longClaim = 'A'.repeat(300);
    const memories = [makeRecord({ claim: longClaim, accessCount: 20 })];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10, 200);
    expect(candidates).toHaveLength(0);
  });

  it('excludes inhibitory memories', async () => {
    const memories = [makeRecord({ accessCount: 20, isInhibitory: true })];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10);
    expect(candidates).toHaveLength(0);
  });

  it('excludes cold storage memories', async () => {
    const memories = [
      makeRecord({ accessCount: 20, interferenceStatus: 'cold' as MemoryRecord['interferenceStatus'] }),
    ];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10);
    expect(candidates).toHaveLength(0);
  });

  it('sorts by score descending', async () => {
    const memories = [
      makeRecord({ claim: 'Low score', accessCount: 11, confidence: 0.5 }),
      makeRecord({ claim: 'High score', accessCount: 50, confidence: 0.95 }),
    ];
    const repo = mockRepo(memories);
    const candidates = await identifyHubCandidates(repo, 10);
    expect(candidates[0]!.claim).toBe('High score');
  });
});

describe('promoteToHub', () => {
  it('creates hub and links source memory', async () => {
    const memId = uuid();
    const memories = [makeRecord({ id: memId, claim: 'Use DI everywhere' })];
    const repo = mockRepo(memories);

    const hub = await promoteToHub(repo, memId);

    expect(hub.claim).toBe('Use DI everywhere');
    expect(hub.hubType).toBe('principle');
    expect(repo.createHub).toHaveBeenCalled();
    expect(repo.linkToHub).toHaveBeenCalledWith(memId, hub.id);
    expect(repo.appendAuditLog).toHaveBeenCalled();
  });

  it('throws for nonexistent memory', async () => {
    const repo = mockRepo([]);
    await expect(promoteToHub(repo, 'nonexistent')).rejects.toThrow('Memory not found');
  });
});
