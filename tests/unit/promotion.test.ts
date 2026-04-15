import { describe, it, expect } from 'vitest';
import { checkPromotionEligibility, type PromotionConfig } from '../../src/learn/promotion.js';
import {
  PermanenceStatus,
  TrustClass,
  Provenance,
  ReviewStatus,
  Scope,
  type MemoryRecord,
} from '../../src/schema/memory.js';

const PROMO_CONFIG: PromotionConfig = {
  minAccessCount: 3,
  minAgeDays: 7,
  consensusRequired: true,
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'test-id',
    claim: 'Test claim',
    subject: 'test',
    scope: Scope.GLOBAL,
    validFrom: null,
    validTo: null,
    provenance: Provenance.LLM_EXTRACTED_CONFIDENT,
    trustClass: TrustClass.CONFIRMED,
    confidence: 0.9,
    sourceHash: 'hash',
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 10,
    lastAccessed: now,
    createdAt: thirtyDaysAgo,
    updatedAt: now,
    embedding: null,
    permanenceStatus: PermanenceStatus.PROVISIONAL,
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

describe('checkPromotionEligibility', () => {
  it('eligible: provisional, confirmed, enough accesses, old enough', () => {
    const record = makeRecord();
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(true);
  });

  it('not eligible: already permanent', () => {
    const record = makeRecord({ permanenceStatus: PermanenceStatus.PERMANENT });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('not eligible: already promotion-pending', () => {
    const record = makeRecord({ permanenceStatus: PermanenceStatus.PROMOTION_PENDING });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('not eligible: quarantined trust class', () => {
    const record = makeRecord({ trustClass: TrustClass.QUARANTINED });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('not eligible: rejected trust class', () => {
    const record = makeRecord({ trustClass: TrustClass.REJECTED });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('not eligible: too few accesses', () => {
    const record = makeRecord({ accessCount: 1 });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('not eligible: too young', () => {
    const record = makeRecord({ createdAt: new Date().toISOString() });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(false);
  });

  it('eligible: auto-approved trust class', () => {
    const record = makeRecord({ trustClass: TrustClass.AUTO_APPROVED });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(true);
  });

  it('eligible: exactly at thresholds', () => {
    const exactAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const record = makeRecord({ accessCount: 3, createdAt: exactAge });
    expect(checkPromotionEligibility(record, PROMO_CONFIG)).toBe(true);
  });
});
