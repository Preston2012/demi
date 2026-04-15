import { describe, it, expect, vi, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';
import type { MemoryRecord } from '../../src/schema/memory.js';

vi.mock('../../src/embeddings/index.js', () => ({
  isInitialized: () => false,
  encode: async () => [],
}));

let buildInjectionPayload: typeof import('../../src/inject/index.js').buildInjectionPayload;
let formatForContext: typeof import('../../src/inject/index.js').formatForContext;
let formatForContextWithMeta: typeof import('../../src/inject/index.js').formatForContextWithMeta;
let buildMetaMemoryHeader: typeof import('../../src/inject/meta.js').buildMetaMemoryHeader;

const now = new Date().toISOString();

function makeCandidate(overrides: Partial<MemoryRecord> = {}, score = 0.8): FinalScoredCandidate {
  const record: MemoryRecord = {
    id: uuid(),
    claim: 'Claim',
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
  return {
    id: record.id,
    candidate: {
      id: record.id,
      record,
      lexicalScore: 0.5,
      vectorScore: 0.3,
      source: 'both',
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    },
    finalScore: score,
    scoreBreakdown: {
      lexicalComponent: 0.15,
      vectorComponent: 0.12,
      provenanceComponent: 0.15,
      freshnessComponent: 0.1,
      confirmedBonus: 0.15,
      contradictionPenalty: 0,
    },
  };
}

function makeRetrievalResult(candidates: FinalScoredCandidate[]) {
  return {
    candidates,
    metadata: {
      query: 'test',
      candidatesGenerated: candidates.length,
      candidatesAfterFilter: candidates.length,
      candidatesReturned: candidates.length,
      timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
    },
  };
}

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const inject = await import('../../src/inject/index.js');
  buildInjectionPayload = inject.buildInjectionPayload;
  formatForContext = inject.formatForContext;
  formatForContextWithMeta = inject.formatForContextWithMeta;
  const meta = await import('../../src/inject/meta.js');
  buildMetaMemoryHeader = meta.buildMetaMemoryHeader;
});

describe('Injection pipeline (novel features)', () => {
  describe('budget compiler', () => {
    it('ensures diversity when one subject dominates', () => {
      const candidates = [
        ...Array.from({ length: 10 }, (_, i) =>
          makeCandidate({ claim: `Flutter rule ${i}`, subject: 'flutter' }, 0.9 - i * 0.01),
        ),
        makeCandidate({ claim: 'TS rule 1', subject: 'typescript' }, 0.7),
        makeCandidate({ claim: 'TS rule 2', subject: 'typescript' }, 0.65),
      ];
      const result = buildInjectionPayload(makeRetrievalResult(candidates) as never, 5);

      const subjects = result.memories.map((m) => m.subject);
      expect(subjects).toContain('typescript');
      expect(subjects.filter((s) => s === 'flutter').length).toBeLessThan(5);
    });

    it('passes everything through when under budget', () => {
      const candidates = [makeCandidate({ claim: 'A' }, 0.9), makeCandidate({ claim: 'B' }, 0.8)];
      const result = buildInjectionPayload(makeRetrievalResult(candidates) as never, 15);
      expect(result.memories.length).toBe(2);
    });
  });

  describe('typed injection', () => {
    it('groups hub memories under Principles header', () => {
      const candidates = [
        makeCandidate({ claim: 'Quality gates first', subject: 'hub:principle' }, 0.9),
        makeCandidate({ claim: 'Use FTS5 for search', subject: 'architecture' }, 0.8),
      ];
      const payload = buildInjectionPayload(makeRetrievalResult(candidates) as never, 15);
      const text = formatForContext(payload);
      expect(text).toContain('Principles:');
      expect(text).toContain('Quality gates first');
    });
  });

  describe('meta-memory header', () => {
    it('builds compact header from repo stats', async () => {
      const repo = {
        getMetaMemoryStats: vi.fn().mockResolvedValue({
          totalMemories: 342,
          topSubjects: [
            { subject: 'flutter', count: 89 },
            { subject: 'architecture', count: 45 },
          ],
          coverageGaps: [],
          stalestMemories: [],
          mostAccessed: [],
          inhibitoryCount: 2,
          frozenCount: 3,
          coldStorageCount: 5,
          hubCount: 4,
        }),
      } as unknown as IMemoryRepository;

      const header = await buildMetaMemoryHeader(repo);
      expect(header).toContain('342 memories');
      expect(header).toContain('flutter (89)');
      expect(header).toContain('4 hubs');
      expect(header).toContain('2 inhibitions');
      expect(header).toContain('3 frozen');
    });

    it('formatForContextWithMeta includes meta header', async () => {
      const repo = {
        getMetaMemoryStats: vi.fn().mockResolvedValue({
          totalMemories: 10,
          topSubjects: [{ subject: 'test', count: 10 }],
          coverageGaps: [],
          stalestMemories: [],
          mostAccessed: [],
          inhibitoryCount: 0,
          frozenCount: 0,
          coldStorageCount: 0,
          hubCount: 0,
        }),
      } as unknown as IMemoryRepository;

      const payload = buildInjectionPayload(
        makeRetrievalResult([makeCandidate({ claim: 'Test memory' })]) as never,
        15,
      );
      const text = await formatForContextWithMeta(payload, repo);
      expect(text).toContain('10 memories');
      expect(text).toContain('Memory Context');
    });
  });
});
