import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import { detectExplicitConflicts, detectSubjectConflicts, detectAllConflicts } from '../../src/inject/conflict.js';
import type { FinalScoredCandidate } from '../../src/retrieval/scorer.js';
import {
  Provenance,
  TrustClass,
  PermanenceStatus,
  ReviewStatus,
  Scope,
  type MemoryRecord,
  type ScoredCandidate,
} from '../../src/schema/memory.js';

function makeCandidate(
  overrides: {
    id?: string;
    claim?: string;
    subject?: string;
    conflictsWith?: string[];
    score?: number;
    updatedAt?: string;
  } = {},
): FinalScoredCandidate {
  const now = new Date().toISOString();
  const id = overrides.id ?? uuid();
  const record: MemoryRecord = {
    id,
    claim: overrides.claim ?? 'Test claim',
    subject: overrides.subject ?? 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.AUTO_APPROVED,
    confidence: 0.8,
    sourceHash: 'hash',
    supersedes: null,
    conflictsWith: overrides.conflictsWith ?? [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
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
  };
  const candidate: ScoredCandidate = {
    id,
    record,
    lexicalScore: 0.5,
    vectorScore: 0.5,
    source: 'both',
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
  return {
    id,
    candidate,
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

describe('detectExplicitConflicts', () => {
  it('returns empty for no conflicts', () => {
    const candidates = [makeCandidate(), makeCandidate()];
    expect(detectExplicitConflicts(candidates)).toHaveLength(0);
  });

  it('detects mutual conflict between two candidates', () => {
    const id1 = uuid();
    const id2 = uuid();
    const c1 = makeCandidate({ id: id1, conflictsWith: [id2] });
    const c2 = makeCandidate({ id: id2, conflictsWith: [id1] });
    const notices = detectExplicitConflicts([c1, c2]);
    // Should be deduplicated to 1 notice
    expect(notices).toHaveLength(1);
    expect(notices[0]!.memoryId).toBeDefined();
    expect(notices[0]!.conflictsWithId).toBeDefined();
  });

  it('ignores conflicts with IDs not in result set', () => {
    const c = makeCandidate({ conflictsWith: ['not-in-set'] });
    expect(detectExplicitConflicts([c])).toHaveLength(0);
  });

  it('detects one-way conflict (A conflicts B, B does not list A)', () => {
    const id1 = uuid();
    const id2 = uuid();
    const c1 = makeCandidate({ id: id1, conflictsWith: [id2] });
    const c2 = makeCandidate({ id: id2, conflictsWith: [] });
    const notices = detectExplicitConflicts([c1, c2]);
    expect(notices).toHaveLength(1);
  });
});

describe('detectSubjectConflicts', () => {
  it('returns empty when subjects are unique', () => {
    const c1 = makeCandidate({ subject: 'user', claim: 'Likes dark mode' });
    const c2 = makeCandidate({ subject: 'project', claim: 'Uses TypeScript' });
    expect(detectSubjectConflicts([c1, c2])).toHaveLength(0);
  });

  it('returns empty when same subject has same claim', () => {
    const c1 = makeCandidate({ subject: 'user', claim: 'Likes dark mode' });
    const c2 = makeCandidate({ subject: 'user', claim: 'Likes dark mode' });
    expect(detectSubjectConflicts([c1, c2])).toHaveLength(0);
  });

  it('flags same subject with contradictory claims', () => {
    const c1 = makeCandidate({ subject: 'user', claim: 'Likes dark mode', score: 0.9 });
    const c2 = makeCandidate({ subject: 'user', claim: 'Likes light mode', score: 0.7 });
    const notices = detectSubjectConflicts([c1, c2]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('Multiple memories');
  });

  it('does NOT flag same subject with unrelated claims', () => {
    const c1 = makeCandidate({ subject: 'demiurge', claim: 'Demiurge was verified on 2026-04-08', score: 0.9 });
    const c2 = makeCandidate({
      subject: 'demiurge',
      claim: 'claude.ai connectors use Streamable HTTP transport',
      score: 0.7,
    });
    const notices = detectSubjectConflicts([c1, c2]);
    expect(notices).toHaveLength(0);
  });

  it('case-insensitive subject matching', () => {
    const c1 = makeCandidate({ subject: 'User', claim: 'Claim A', score: 0.9 });
    const c2 = makeCandidate({ subject: 'user', claim: 'Claim B', score: 0.7 });
    expect(detectSubjectConflicts([c1, c2])).toHaveLength(1);
  });

  it('handles 3+ memories about same subject', () => {
    const c1 = makeCandidate({ subject: 'user', claim: 'Claim A', score: 0.9 });
    const c2 = makeCandidate({ subject: 'user', claim: 'Claim B', score: 0.7 });
    const c3 = makeCandidate({ subject: 'user', claim: 'Claim C', score: 0.5 });
    const notices = detectSubjectConflicts([c1, c2, c3]);
    // Winner (c1) conflicts with both c2 and c3
    expect(notices).toHaveLength(2);
  });
});

describe('detectAllConflicts', () => {
  it('merges explicit and subject conflicts', () => {
    const id1 = uuid();
    const id2 = uuid();
    // Explicit conflict
    const c1 = makeCandidate({ id: id1, subject: 'user', claim: 'Likes dark', conflictsWith: [id2], score: 0.9 });
    const c2 = makeCandidate({ id: id2, subject: 'user', claim: 'Likes light', conflictsWith: [id1], score: 0.7 });
    const notices = detectAllConflicts([c1, c2]);
    // Should be deduplicated across both methods
    expect(notices.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for clean candidates', () => {
    const c1 = makeCandidate({ subject: 'a', claim: 'Claim A' });
    const c2 = makeCandidate({ subject: 'b', claim: 'Claim B' });
    expect(detectAllConflicts([c1, c2])).toHaveLength(0);
  });
});
