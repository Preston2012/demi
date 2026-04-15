import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { IMemoryRepository } from '../../src/repository/interface.js';

let createCircuitBreaker: typeof import('../../src/learn/circuit-breaker.js').createCircuitBreaker;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/learn/circuit-breaker.js');
  createCircuitBreaker = mod.createCircuitBreaker;
});

function mockRepo(lastActivity: string | null = null): IMemoryRepository {
  return {
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(lastActivity),
  } as unknown as IMemoryRepository;
}

describe('CircuitBreaker', () => {
  it('is not locked when recent activity exists', async () => {
    const repo = mockRepo(new Date().toISOString());
    const cb = createCircuitBreaker(repo);
    expect(await cb.isLocked()).toBe(false);
  });

  it('is locked after 30 days of inactivity', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const repo = mockRepo(old.toISOString());
    const cb = createCircuitBreaker(repo);
    expect(await cb.isLocked()).toBe(true);
  });

  it('is locked when no activity ever recorded', async () => {
    const repo = mockRepo(null);
    const cb = createCircuitBreaker(repo);
    expect(await cb.isLocked()).toBe(true);
  });

  it('records activity and resets timer', async () => {
    const repo = mockRepo(null);
    const cb = createCircuitBreaker(repo);
    await cb.recordActivity();
    expect(repo.setMetadata).toHaveBeenCalledWith(
      'last_activity',
      expect.any(String),
    );
  });

  it('respects custom lock threshold', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const repo = mockRepo(old.toISOString());
    const cb = createCircuitBreaker(repo, { lockAfterDays: 7 });
    expect(await cb.isLocked()).toBe(true);
  });

  it('returns Infinity days for invalid date', async () => {
    const repo = mockRepo('garbage');
    const cb = createCircuitBreaker(repo);
    const days = await cb.daysSinceLastActivity();
    expect(days).toBe(Infinity);
  });
});
