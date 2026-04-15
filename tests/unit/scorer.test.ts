import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  computeFreshness,
  computeProvenanceScore,
  mergeCandidates,
  filterInjectable,
  scoreCandidate,
  rankCandidates,
  DEFAULT_WEIGHTS,
} from '../../src/retrieval/scorer.js';
import {
  Provenance,
  TrustClass,
  PermanenceStatus,
  ReviewStatus,
  Scope,
  type MemoryRecord,
  type ScoredCandidate,
} from '../../src/schema/memory.js';

// --- Helpers ---

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
    sourceHash: 'hash123',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: now,
    embedding: null,
    permanenceStatus: PermanenceStatus.PROVISIONAL,
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

function makeCandidate(
  overrides: {
    lexicalScore?: number;
    vectorScore?: number;
    source?: 'fts' | 'vector' | 'both';
    record?: Partial<MemoryRecord>;
  } = {},
): ScoredCandidate {
  const record = makeRecord(overrides.record);
  return {
    id: record.id,
    record,
    lexicalScore: overrides.lexicalScore ?? 0,
    vectorScore: overrides.vectorScore ?? 0,
    source: overrides.source ?? 'fts',
  };
}

// --- Freshness ---

describe('computeFreshness', () => {
  const halfLife = 30; // days

  it('returns 1.0 for a memory updated just now', () => {
    const now = new Date();
    const score = computeFreshness(now.toISOString(), halfLife, now);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.5 at half-life', () => {
    const now = new Date();
    const halfLifeAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const score = computeFreshness(halfLifeAgo.toISOString(), halfLife, now);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.25 at 2x half-life', () => {
    const now = new Date();
    const twoHalfLivesAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const score = computeFreshness(twoHalfLivesAgo.toISOString(), halfLife, now);
    expect(score).toBeCloseTo(0.25, 2);
  });

  it('returns ~0.125 at 3x half-life', () => {
    const now = new Date();
    const threeHalfLivesAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const score = computeFreshness(threeHalfLivesAgo.toISOString(), halfLife, now);
    expect(score).toBeCloseTo(0.125, 2);
  });

  it('returns 1.0 for future timestamps', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 1000000);
    const score = computeFreshness(future.toISOString(), halfLife, now);
    expect(score).toBe(1.0);
  });

  it('approaches 0 for very old memories', () => {
    const now = new Date();
    const ancient = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const score = computeFreshness(ancient.toISOString(), halfLife, now);
    expect(score).toBeLessThan(0.001);
  });

  it('is monotonically decreasing', () => {
    const now = new Date();
    const scores: number[] = [];
    for (let days = 0; days <= 120; days += 10) {
      const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      scores.push(computeFreshness(past.toISOString(), halfLife, now));
    }
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    }
  });
});

// --- Provenance ---

describe('computeProvenanceScore', () => {
  it('user-confirmed = 1.0', () => {
    expect(computeProvenanceScore(Provenance.USER_CONFIRMED)).toBe(1.0);
  });

  it('llm-extracted-confident = 0.7', () => {
    expect(computeProvenanceScore(Provenance.LLM_EXTRACTED_CONFIDENT)).toBe(0.7);
  });

  it('imported = 0.5', () => {
    expect(computeProvenanceScore(Provenance.IMPORTED)).toBe(0.5);
  });

  it('llm-extracted-quarantine = 0.3', () => {
    expect(computeProvenanceScore(Provenance.LLM_EXTRACTED_QUARANTINE)).toBe(0.3);
  });

  it('ranking order: confirmed > confident > imported > quarantine', () => {
    const confirmed = computeProvenanceScore(Provenance.USER_CONFIRMED);
    const confident = computeProvenanceScore(Provenance.LLM_EXTRACTED_CONFIDENT);
    const imported = computeProvenanceScore(Provenance.IMPORTED);
    const quarantine = computeProvenanceScore(Provenance.LLM_EXTRACTED_QUARANTINE);
    expect(confirmed).toBeGreaterThan(confident);
    expect(confident).toBeGreaterThan(imported);
    expect(imported).toBeGreaterThan(quarantine);
  });
});

// --- Merge ---

describe('mergeCandidates', () => {
  it('merges disjoint sets', () => {
    const a = [makeCandidate({ lexicalScore: 0.8 })];
    const b = [makeCandidate({ vectorScore: 0.9 })];
    const merged = mergeCandidates(a, b);
    expect(merged).toHaveLength(2);
  });

  it('combines duplicates: max scores, source = both', () => {
    const id = uuid();
    const record = makeRecord({ id });
    const a: ScoredCandidate[] = [{ id, record, lexicalScore: 0.8, vectorScore: 0, source: 'fts' }];
    const b: ScoredCandidate[] = [{ id, record, lexicalScore: 0.3, vectorScore: 0.9, source: 'vector' }];
    const merged = mergeCandidates(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.lexicalScore).toBe(0.8);
    expect(merged[0]!.vectorScore).toBe(0.9);
    expect(merged[0]!.source).toBe('both');
  });

  it('handles empty inputs', () => {
    expect(mergeCandidates([], [])).toHaveLength(0);
    const a = [makeCandidate()];
    expect(mergeCandidates(a, [])).toHaveLength(1);
    expect(mergeCandidates([], a)).toHaveLength(1);
  });
});

// --- Filter ---

describe('filterInjectable', () => {
  it('keeps confirmed and auto-approved', () => {
    const candidates = [
      makeCandidate({ record: { trustClass: TrustClass.CONFIRMED } }),
      makeCandidate({ record: { trustClass: TrustClass.AUTO_APPROVED } }),
    ];
    expect(filterInjectable(candidates)).toHaveLength(2);
  });

  it('removes quarantined', () => {
    const candidates = [makeCandidate({ record: { trustClass: TrustClass.QUARANTINED } })];
    expect(filterInjectable(candidates)).toHaveLength(0);
  });

  it('removes rejected', () => {
    const candidates = [makeCandidate({ record: { trustClass: TrustClass.REJECTED } })];
    expect(filterInjectable(candidates)).toHaveLength(0);
  });

  it('mixed: keeps only injectable', () => {
    const candidates = [
      makeCandidate({ record: { trustClass: TrustClass.CONFIRMED } }),
      makeCandidate({ record: { trustClass: TrustClass.QUARANTINED } }),
      makeCandidate({ record: { trustClass: TrustClass.AUTO_APPROVED } }),
      makeCandidate({ record: { trustClass: TrustClass.REJECTED } }),
    ];
    const filtered = filterInjectable(candidates);
    expect(filtered).toHaveLength(2);
    expect(
      filtered.every(
        (c) => c.record.trustClass === TrustClass.CONFIRMED || c.record.trustClass === TrustClass.AUTO_APPROVED,
      ),
    ).toBe(true);
  });
});

// --- Score ---

describe('scoreCandidate', () => {
  const now = new Date();
  const weights = DEFAULT_WEIGHTS;

  it('lexical-only candidate scores correctly', () => {
    const c = makeCandidate({
      lexicalScore: 1.0,
      vectorScore: 0,
      record: { updatedAt: now.toISOString() },
    });
    const result = scoreCandidate(c, weights, now);
    expect(result.scoreBreakdown.lexicalComponent).toBeCloseTo(0.3, 5);
    expect(result.scoreBreakdown.vectorComponent).toBe(0);
  });

  it('vector-only candidate scores correctly', () => {
    const c = makeCandidate({
      lexicalScore: 0,
      vectorScore: 1.0,
      record: { updatedAt: now.toISOString() },
    });
    const result = scoreCandidate(c, weights, now);
    expect(result.scoreBreakdown.vectorComponent).toBeCloseTo(0.4, 5);
    expect(result.scoreBreakdown.lexicalComponent).toBe(0);
  });

  it('confirmed bonus applies only to confirmed trust class', () => {
    const confirmed = makeCandidate({
      record: { trustClass: TrustClass.CONFIRMED, updatedAt: now.toISOString() },
    });
    const autoApproved = makeCandidate({
      record: { trustClass: TrustClass.AUTO_APPROVED, updatedAt: now.toISOString() },
    });
    const r1 = scoreCandidate(confirmed, weights, now);
    const r2 = scoreCandidate(autoApproved, weights, now);
    expect(r1.scoreBreakdown.confirmedBonus).toBe(0.15);
    expect(r2.scoreBreakdown.confirmedBonus).toBe(0);
  });

  it('contradiction penalty scales by conflict count', () => {
    const clean = makeCandidate({ record: { conflictsWith: [], updatedAt: now.toISOString() } });
    const one = makeCandidate({ record: { conflictsWith: [uuid()], updatedAt: now.toISOString() } });
    const three = makeCandidate({ record: { conflictsWith: [uuid(), uuid(), uuid()], updatedAt: now.toISOString() } });
    const five = makeCandidate({
      record: { conflictsWith: [uuid(), uuid(), uuid(), uuid(), uuid()], updatedAt: now.toISOString() },
    });
    expect(scoreCandidate(clean, weights, now).scoreBreakdown.contradictionPenalty).toBe(0);
    expect(scoreCandidate(one, weights, now).scoreBreakdown.contradictionPenalty).toBeCloseTo(0.1, 5);
    expect(scoreCandidate(three, weights, now).scoreBreakdown.contradictionPenalty).toBeCloseTo(0.3, 5);
    expect(scoreCandidate(five, weights, now).scoreBreakdown.contradictionPenalty).toBeCloseTo(0.3, 5);
  });

  it('freshness returns 0 for invalid date', () => {
    expect(computeFreshness('not-a-date', 30, now)).toBe(0);
    expect(computeFreshness('', 30, now)).toBe(0);
  });

  it('negative finalScore is valid (heavily penalized memory)', () => {
    const c = makeCandidate({
      lexicalScore: 0,
      vectorScore: 0,
      record: {
        conflictsWith: [uuid(), uuid(), uuid()],
        provenance: Provenance.LLM_EXTRACTED_QUARANTINE,
        trustClass: TrustClass.AUTO_APPROVED,
        updatedAt: new Date(now.getTime() - 365 * 86400000).toISOString(),
      },
    });
    const result = scoreCandidate(c, weights, now);
    expect(result.finalScore).toBeLessThan(0);
  });

  it('permanent memory gets max freshness regardless of age', () => {
    const ancient = new Date(now.getTime() - 365 * 86400000).toISOString();
    const c = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: {
        updatedAt: ancient,
        permanenceStatus: PermanenceStatus.PERMANENT,
      },
    });
    const result = scoreCandidate(c, weights, now);
    expect(result.scoreBreakdown.freshnessComponent).toBeCloseTo(weights.freshnessWeight, 5);
  });

  it('provisional memory decays normally', () => {
    const ancient = new Date(now.getTime() - 365 * 86400000).toISOString();
    const c = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: {
        updatedAt: ancient,
        permanenceStatus: PermanenceStatus.PROVISIONAL,
      },
    });
    const result = scoreCandidate(c, weights, now);
    expect(result.scoreBreakdown.freshnessComponent).toBeLessThan(weights.freshnessWeight * 0.01);
  });

  it('final score is sum of components minus penalty', () => {
    const c = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: {
        provenance: Provenance.USER_CONFIRMED,
        trustClass: TrustClass.CONFIRMED,
        conflictsWith: [],
        updatedAt: now.toISOString(),
      },
    });
    const result = scoreCandidate(c, weights, now);
    const expected =
      result.scoreBreakdown.lexicalComponent +
      result.scoreBreakdown.vectorComponent +
      result.scoreBreakdown.provenanceComponent +
      result.scoreBreakdown.freshnessComponent +
      result.scoreBreakdown.confirmedBonus -
      result.scoreBreakdown.contradictionPenalty;
    expect(result.finalScore).toBeCloseTo(expected, 10);
  });
});

// --- Rank ---

describe('rankCandidates', () => {
  const now = new Date();
  const weights = DEFAULT_WEIGHTS;

  it('returns highest-scored first', () => {
    const candidates = [
      makeCandidate({ lexicalScore: 0.2, vectorScore: 0.2, record: { updatedAt: now.toISOString() } }),
      makeCandidate({ lexicalScore: 0.9, vectorScore: 0.9, record: { updatedAt: now.toISOString() } }),
      makeCandidate({ lexicalScore: 0.5, vectorScore: 0.5, record: { updatedAt: now.toISOString() } }),
    ];
    const ranked = rankCandidates(candidates, weights, 10, now);
    expect(ranked[0]!.finalScore).toBeGreaterThanOrEqual(ranked[1]!.finalScore);
    expect(ranked[1]!.finalScore).toBeGreaterThanOrEqual(ranked[2]!.finalScore);
  });

  it('respects limit', () => {
    const candidates = Array.from({ length: 20 }, () =>
      makeCandidate({ lexicalScore: Math.random(), record: { updatedAt: now.toISOString() } }),
    );
    const ranked = rankCandidates(candidates, weights, 5, now);
    expect(ranked).toHaveLength(5);
  });

  it('returns fewer than limit if not enough candidates', () => {
    const candidates = [makeCandidate({ lexicalScore: 0.5, record: { updatedAt: now.toISOString() } })];
    const ranked = rankCandidates(candidates, weights, 15, now);
    expect(ranked).toHaveLength(1);
  });

  it('handles empty candidates', () => {
    const ranked = rankCandidates([], weights, 10, now);
    expect(ranked).toHaveLength(0);
  });

  it('tie-breaks by confidence then updatedAt then createdAt', () => {
    const t = now.toISOString();
    // Confidence tie-break
    const c1 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: { confidence: 0.9, updatedAt: t, createdAt: t },
    });
    const c2 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: { confidence: 0.6, updatedAt: t, createdAt: t },
    });
    const ranked1 = rankCandidates([c2, c1], weights, 10, now);
    expect(ranked1[0]!.candidate.record.confidence).toBe(0.9);

    // updatedAt tie-break (same confidence)
    const older = new Date(now.getTime() - 100000).toISOString();
    const c3 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: { confidence: 0.8, updatedAt: t, createdAt: older },
    });
    const c4 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: { confidence: 0.8, updatedAt: older, createdAt: t },
    });
    const ranked2 = rankCandidates([c4, c3], weights, 10, now);
    // c3 has newer updatedAt, should rank first
    expect(ranked2[0]!.candidate.record.updatedAt).toBe(t);
  });

  it('user-confirmed memories rank higher than auto-approved (same scores)', () => {
    const c1 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: {
        provenance: Provenance.USER_CONFIRMED,
        trustClass: TrustClass.CONFIRMED,
        updatedAt: now.toISOString(),
      },
    });
    const c2 = makeCandidate({
      lexicalScore: 0.5,
      vectorScore: 0.5,
      record: {
        provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
        trustClass: TrustClass.AUTO_APPROVED,
        updatedAt: now.toISOString(),
      },
    });
    const ranked = rankCandidates([c2, c1], weights, 10, now);
    // Confirmed gets provenance bonus (1.0 vs 0.7) + confirmed bonus (0.15)
    expect(ranked[0]!.candidate.record.trustClass).toBe(TrustClass.CONFIRMED);
  });
});
