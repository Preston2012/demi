import { describe, it, expect, beforeAll } from 'vitest';
import type { IMemoryRepository } from '../../src/repository/interface.js';

let createDecayTracker: typeof import('../../src/learn/decay.js').createDecayTracker;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/learn/decay.js');
  createDecayTracker = mod.createDecayTracker;
});

function mockRepo(): IMemoryRepository {
  return {
    incrementAccessCount: async () => {},
    getPendingReview: async () => [],
    getById: async () => null,
    update: async () => {},
    setMetadata: async () => {},
    getMetadata: async () => null,
  } as unknown as IMemoryRepository;
}

describe('DecayTracker.computeFreshnessScore', () => {
  it('returns ~1 for just-accessed memory with 0 access count', async () => {
    const tracker = createDecayTracker(mockRepo());
    const score = tracker.computeFreshnessScore(new Date().toISOString(), 0);
    expect(score).toBeCloseTo(1, 1);
  });

  it('returns ~0.5 at half-life with 0 access count', async () => {
    const tracker = createDecayTracker(mockRepo());
    const halfLifeAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const score = tracker.computeFreshnessScore(halfLifeAgo.toISOString(), 0);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('access count adds bonus up to cap', async () => {
    const tracker = createDecayTracker(mockRepo());
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const noAccess = tracker.computeFreshnessScore(old.toISOString(), 0);
    const withAccess = tracker.computeFreshnessScore(old.toISOString(), 10);
    expect(withAccess).toBeGreaterThan(noAccess);
  });

  it('caps at 1.0', async () => {
    const tracker = createDecayTracker(mockRepo());
    const score = tracker.computeFreshnessScore(new Date().toISOString(), 100);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 on invalid date', async () => {
    const tracker = createDecayTracker(mockRepo());
    const score = tracker.computeFreshnessScore('not-a-date', 5);
    expect(score).toBe(0);
  });

  it('returns 1 for future date', async () => {
    const tracker = createDecayTracker(mockRepo());
    const future = new Date(Date.now() + 86400000);
    const score = tracker.computeFreshnessScore(future.toISOString(), 0);
    expect(score).toBe(1);
  });
});
