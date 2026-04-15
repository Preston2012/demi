import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';

import type { RetrievalResult } from '../../src/retrieval/index.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';
import { Provenance, TrustClass, ReviewStatus, Scope, type MemoryRecord } from '../../src/schema/memory.js';

// Dynamic import for modules that use createLogger at module scope
let buildInjectionPayload: typeof import('../../src/inject/index.js').buildInjectionPayload;
let formatForContext: typeof import('../../src/inject/index.js').formatForContext;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/inject/index.js');
  buildInjectionPayload = mod.buildInjectionPayload;
  formatForContext = mod.formatForContext;
});

function makeScoredCandidate(
  overrides: {
    claim?: string;
    subject?: string;
    conflictsWith?: string[];
    score?: number;
    id?: string;
  } = {},
): FinalScoredCandidate {
  const now = new Date().toISOString();
  const id = overrides.id ?? uuid();
  const record: MemoryRecord = {
    id,
    claim: overrides.claim ?? 'Test memory claim',
    subject: overrides.subject ?? 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.AUTO_APPROVED,
    confidence: 0.85,
    sourceHash: 'h',
    supersedes: null,
    conflictsWith: overrides.conflictsWith ?? [],
    reviewStatus: ReviewStatus.APPROVED,
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
  };
  return {
    id,
    candidate: {
      id,
      record,
      lexicalScore: 0.5,
      vectorScore: 0.5,
      source: 'both' as const,
      hubExpansionScore: 0,
      inhibitionPenalty: 0,
      primingBonus: 0,
      cascadeDepth: 0,
    },
    finalScore: overrides.score ?? 0.75,
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

function makeRetrievalResult(candidates: FinalScoredCandidate[]): RetrievalResult {
  return {
    candidates,
    metadata: {
      query: 'test query',
      candidatesGenerated: candidates.length * 2,
      candidatesAfterFilter: candidates.length,
      candidatesReturned: candidates.length,
      timings: { lexicalMs: 2, vectorMs: 3, mergeAndScoreMs: 1, totalMs: 6 },
    },
  };
}

describe('buildInjectionPayload', () => {
  it('builds payload from retrieval results', () => {
    const candidates = [
      makeScoredCandidate({ claim: 'User likes TS', subject: 'preferences' }),
      makeScoredCandidate({ claim: 'User lives in Austin', subject: 'location' }),
    ];
    const result = makeRetrievalResult(candidates);
    const payload = buildInjectionPayload(result);

    expect(payload.memories).toHaveLength(2);
    expect(payload.memories[0]!.claim).toBe('User likes TS');
    expect(payload.conflicts).toHaveLength(0);
    expect(payload.metadata.queryUsed).toBe('test query');
  });

  it('respects maxRules limit', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeScoredCandidate({ claim: `Claim ${i}` }));
    const payload = buildInjectionPayload(makeRetrievalResult(candidates), 5);
    expect(payload.memories).toHaveLength(5);
  });

  it('returns empty payload for no candidates', () => {
    const payload = buildInjectionPayload(makeRetrievalResult([]));
    expect(payload.memories).toHaveLength(0);
    expect(payload.conflicts).toHaveLength(0);
  });

  it('surfaces explicit conflicts', () => {
    const id1 = uuid();
    const id2 = uuid();
    const c1 = makeScoredCandidate({ id: id1, conflictsWith: [id2] });
    const c2 = makeScoredCandidate({ id: id2, conflictsWith: [id1] });
    const payload = buildInjectionPayload(makeRetrievalResult([c1, c2]));
    expect(payload.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces subject conflicts', () => {
    const c1 = makeScoredCandidate({ subject: 'user', claim: 'Likes dark', score: 0.9 });
    const c2 = makeScoredCandidate({ subject: 'user', claim: 'Likes light', score: 0.7 });
    const payload = buildInjectionPayload(makeRetrievalResult([c1, c2]));
    expect(payload.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('includes provenance in injected memories', () => {
    const c = makeScoredCandidate();
    const payload = buildInjectionPayload(makeRetrievalResult([c]));
    expect(payload.memories[0]!.provenance).toBe(Provenance.LLM_EXTRACTED_CONFIDENT);
    expect(payload.memories[0]!.trustClass).toBe(TrustClass.AUTO_APPROVED);
  });
});

describe('formatForContext', () => {
  it('returns empty string for no memories', () => {
    const payload = buildInjectionPayload(makeRetrievalResult([]));
    expect(formatForContext(payload)).toBe('');
  });

  it('formats memories as numbered list', () => {
    const c1 = makeScoredCandidate({ claim: 'User likes TypeScript' });
    const c2 = makeScoredCandidate({ claim: 'User lives in Austin' });
    const payload = buildInjectionPayload(makeRetrievalResult([c1, c2]));
    const text = formatForContext(payload);

    expect(text).toContain('Memory Context (2 rules)');
    expect(text).toContain('User likes TypeScript');
    expect(text).toContain('User lives in Austin');
    expect(text).toContain('confidence:');
    expect(text).toContain('provenance:');
  });

  it('includes conflict warnings when present', () => {
    const id1 = uuid();
    const id2 = uuid();
    const c1 = makeScoredCandidate({ id: id1, subject: 'user', claim: 'Dark mode', conflictsWith: [id2], score: 0.9 });
    const c2 = makeScoredCandidate({ id: id2, subject: 'user', claim: 'Light mode', conflictsWith: [id1], score: 0.7 });
    const payload = buildInjectionPayload(makeRetrievalResult([c1, c2]));
    const text = formatForContext(payload);

    expect(text).toContain('Conflicts detected:');
  });

  it('does not include conflict section when no conflicts', () => {
    const c = makeScoredCandidate();
    const payload = buildInjectionPayload(makeRetrievalResult([c]));
    const text = formatForContext(payload);
    expect(text).not.toContain('Conflicts');
  });
});
