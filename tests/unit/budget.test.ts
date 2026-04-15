import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { MemoryRecord } from '../../src/schema/memory.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';

let compileBudget: typeof import('../../src/inject/budget.js').compileBudget;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/inject/budget.js');
  compileBudget = mod.compileBudget;
});

// --- Helpers ---

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    claim: 'Test claim',
    subject: 'test',
    scope: 'global' as const,
    validFrom: null,
    validTo: null,
    provenance: 'llm-extracted-confident' as const,
    trustClass: 'auto-approved' as const,
    confidence: 0.8,
    sourceHash: 'h',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: 'approved' as const,
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

function makeCandidate(
  subject: string,
  finalScore: number,
  overrides: Partial<MemoryRecord> = {},
): FinalScoredCandidate {
  const record = makeRecord({ subject, ...overrides });
  return {
    id: record.id,
    candidate: {
      id: record.id,
      record,
      lexicalScore: 0.5,
      vectorScore: 0.5,
      source: 'fts' as const,
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    },
    finalScore,
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

// --- Tests ---

describe('compileBudget', () => {
  describe('candidates <= totalSlots', () => {
    it('returns all candidates with no drops when count fits budget', () => {
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('security', 0.8),
        makeCandidate('architecture', 0.7),
      ];

      const result = compileBudget(candidates, 5);

      expect(result.candidates).toHaveLength(3);
      expect(result.dropped).toHaveLength(0);
      expect(result.candidates.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
    });

    it('builds allocation map from all candidates when they all fit', () => {
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.85),
        makeCandidate('security', 0.8),
      ];

      const result = compileBudget(candidates, 10);

      expect(result.allocation['flutter']).toBe(2);
      expect(result.allocation['security']).toBe(1);
      expect(result.dropped).toHaveLength(0);
    });

    it('returns exact same candidates when count equals totalSlots', () => {
      const candidates = [makeCandidate('a', 0.5), makeCandidate('b', 0.4)];

      const result = compileBudget(candidates, 2);

      expect(result.candidates).toHaveLength(2);
      expect(result.dropped).toHaveLength(0);
    });
  });

  describe('candidates > totalSlots', () => {
    it('drops lowest-scoring candidates when over budget', () => {
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.8),
        makeCandidate('flutter', 0.7),
        makeCandidate('flutter', 0.6),
        makeCandidate('flutter', 0.5),
      ];

      const result = compileBudget(candidates, 3);

      expect(result.candidates).toHaveLength(3);
      expect(result.dropped).toHaveLength(2);
      // Dropped candidates should be the lowest-scored
      const selectedScores = result.candidates.map((c) => c.finalScore);
      for (const d of result.dropped) {
        const droppedCandidate = candidates.find((c) => c.id === d.id)!;
        expect(Math.max(...selectedScores)).toBeGreaterThanOrEqual(droppedCandidate.finalScore);
      }
    });

    it('dropped entries include id and reason', () => {
      const candidates = [makeCandidate('flutter', 0.9), makeCandidate('flutter', 0.1), makeCandidate('flutter', 0.05)];

      const result = compileBudget(candidates, 1);

      expect(result.dropped).toHaveLength(2);
      for (const d of result.dropped) {
        expect(d.id).toBeDefined();
        expect(d.reason).toContain('budget');
      }
    });
  });

  describe('minPerCategory', () => {
    it('ensures at least 1 candidate per category present', () => {
      // 3 categories, but only 3 slots: each should get 1
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.85),
        makeCandidate('security', 0.5),
        makeCandidate('architecture', 0.4),
      ];

      const result = compileBudget(candidates, 3, 1);

      // Each category should have at least 1
      expect(result.allocation['flutter']).toBeGreaterThanOrEqual(1);
      expect(result.allocation['security']).toBeGreaterThanOrEqual(1);
      expect(result.allocation['architecture']).toBeGreaterThanOrEqual(1);
      expect(result.candidates).toHaveLength(3);
    });

    it('minPerCategory=2 reserves 2 slots per category when available', () => {
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.85),
        makeCandidate('flutter', 0.8),
        makeCandidate('security', 0.7),
        makeCandidate('security', 0.6),
        makeCandidate('security', 0.5),
      ];

      // 6 candidates, 4 slots, min 2 per category
      const result = compileBudget(candidates, 4, 2);

      expect(result.allocation['flutter']).toBeGreaterThanOrEqual(2);
      expect(result.allocation['security']).toBeGreaterThanOrEqual(2);
      expect(result.candidates).toHaveLength(4);
    });
  });

  describe('maxPerCategory', () => {
    it('caps a single category even when it has highest scores', () => {
      const candidates = [
        makeCandidate('flutter', 0.95),
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.85),
        makeCandidate('flutter', 0.8),
        makeCandidate('security', 0.3),
        makeCandidate('architecture', 0.2),
      ];

      // 6 candidates, 5 slots, max 2 per category
      const result = compileBudget(candidates, 5, 1, 2);

      expect(result.allocation['flutter']).toBeLessThanOrEqual(2);
      // Security and architecture should have gotten slots since flutter was capped
      expect(result.allocation['security']).toBeGreaterThanOrEqual(1);
      expect(result.allocation['architecture']).toBeGreaterThanOrEqual(1);
    });

    it('maxPerCategory=1 limits each category to exactly 1', () => {
      const candidates = [
        makeCandidate('flutter', 0.9),
        makeCandidate('flutter', 0.8),
        makeCandidate('security', 0.7),
        makeCandidate('security', 0.6),
      ];

      const result = compileBudget(candidates, 3, 1, 1);

      expect(result.allocation['flutter']).toBe(1);
      expect(result.allocation['security']).toBe(1);
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('categorization', () => {
    it('categorizes hub subjects as hub', () => {
      const candidates = [
        makeCandidate('hub:principle', 0.9),
        makeCandidate('hub:pattern', 0.8),
        makeCandidate('flutter', 0.7),
      ];

      const result = compileBudget(candidates, 10);

      expect(result.allocation['hub']).toBe(2);
      expect(result.allocation['flutter']).toBe(1);
    });

    it('categorizes procedural memoryType as procedural regardless of subject', () => {
      const candidates = [
        makeCandidate('flutter', 0.9, { memoryType: 'procedural' as const }),
        makeCandidate('security', 0.8, { memoryType: 'procedural' as const }),
      ];

      const result = compileBudget(candidates, 10);

      expect(result.allocation['procedural']).toBe(2);
      expect(result.allocation['flutter']).toBeUndefined();
      expect(result.allocation['security']).toBeUndefined();
    });

    it('uses subject as category for non-hub non-procedural memories', () => {
      const candidates = [makeCandidate('flutter', 0.9), makeCandidate('security', 0.8), makeCandidate('testing', 0.7)];

      const result = compileBudget(candidates, 10);

      expect(result.allocation['flutter']).toBe(1);
      expect(result.allocation['security']).toBe(1);
      expect(result.allocation['testing']).toBe(1);
    });

    it('hub categorization takes precedence over procedural', () => {
      // A hub:xxx subject should be categorized as 'hub' even if memoryType is procedural
      const candidates = [makeCandidate('hub:workflow', 0.9, { memoryType: 'procedural' as const })];

      const result = compileBudget(candidates, 10);

      // The categorize function checks subject.startsWith('hub:') first
      expect(result.allocation['hub']).toBe(1);
      expect(result.allocation['procedural']).toBeUndefined();
    });

    it('budget diversity works across mixed categories under pressure', () => {
      // 3 hub, 2 procedural, 3 flutter -- only 4 slots
      const candidates = [
        makeCandidate('hub:p1', 0.95),
        makeCandidate('hub:p2', 0.9),
        makeCandidate('hub:p3', 0.85),
        makeCandidate('flutter', 0.8, { memoryType: 'procedural' as const }),
        makeCandidate('flutter', 0.75, { memoryType: 'procedural' as const }),
        makeCandidate('flutter', 0.7),
        makeCandidate('flutter', 0.65),
        makeCandidate('flutter', 0.6),
      ];

      const result = compileBudget(candidates, 4, 1, 3);

      // Each present category gets at least 1
      expect(result.allocation['hub']).toBeGreaterThanOrEqual(1);
      expect(result.allocation['procedural']).toBeGreaterThanOrEqual(1);
      expect(result.allocation['flutter']).toBeGreaterThanOrEqual(1);
      expect(result.candidates).toHaveLength(4);
    });
  });
});
