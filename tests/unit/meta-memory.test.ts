import { describe, it, expect, vi } from 'vitest';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import type { MetaMemoryStats } from '../../src/schema/memory.js';
import { buildMetaMemoryHeader } from '../../src/inject/meta.js';

// --- Helpers ---

function makeStats(overrides: Partial<MetaMemoryStats> = {}): MetaMemoryStats {
  return {
    totalMemories: 0,
    topSubjects: [],
    coverageGaps: [],
    stalestMemories: [],
    mostAccessed: [],
    inhibitoryCount: 0,
    frozenCount: 0,
    coldStorageCount: 0,
    hubCount: 0,
    ...overrides,
  };
}

function makeMockRepo(stats: MetaMemoryStats): IMemoryRepository {
  return {
    getMetaMemoryStats: vi.fn().mockResolvedValue(stats),
  } as unknown as IMemoryRepository;
}

// --- Tests ---

describe('buildMetaMemoryHeader', () => {
  it('returns descriptive string with populated stats', async () => {
    const stats = makeStats({
      totalMemories: 342,
      topSubjects: [
        { subject: 'flutter', count: 89 },
        { subject: 'architecture', count: 45 },
        { subject: 'security', count: 23 },
      ],
      hubCount: 5,
      frozenCount: 3,
      inhibitoryCount: 2,
      coldStorageCount: 7,
      stalestMemories: [
        {
          id: 'stale-1',
          claim: 'Old fact',
          lastAccessed: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('342 memories');
    expect(header).toContain('flutter (89)');
    expect(header).toContain('architecture (45)');
    expect(header).toContain('security (23)');
    expect(header).toContain('5 hubs');
    expect(header).toContain('3 frozen');
    expect(header).toContain('2 inhibitions');
    expect(header).toContain('7 in cold storage');
    expect(header).toMatch(/stalest: \d+d old/);
    expect(header.endsWith('.')).toBe(true);
  });

  it('returns minimal output with empty stats', async () => {
    const stats = makeStats({ totalMemories: 0 });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toBe('Memory system: 0 memories.');
    // Should NOT contain optional sections
    expect(header).not.toContain('top subjects');
    expect(header).not.toContain('hubs');
    expect(header).not.toContain('frozen');
    expect(header).not.toContain('inhibitions');
    expect(header).not.toContain('stalest');
  });

  it('includes top subjects when present', async () => {
    const stats = makeStats({
      totalMemories: 100,
      topSubjects: [
        { subject: 'dart', count: 40 },
        { subject: 'testing', count: 30 },
      ],
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('top subjects: dart (40), testing (30)');
  });

  it('limits top subjects to 3 even if more are available', async () => {
    const stats = makeStats({
      totalMemories: 200,
      topSubjects: [
        { subject: 'a', count: 50 },
        { subject: 'b', count: 40 },
        { subject: 'c', count: 30 },
        { subject: 'd', count: 20 },
        { subject: 'e', count: 10 },
      ],
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('a (50)');
    expect(header).toContain('b (40)');
    expect(header).toContain('c (30)');
    expect(header).not.toContain('d (20)');
    expect(header).not.toContain('e (10)');
  });

  it('includes hub count when hubs exist', async () => {
    const stats = makeStats({
      totalMemories: 50,
      hubCount: 12,
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('12 hubs');
  });

  it('excludes hub count when zero', async () => {
    const stats = makeStats({
      totalMemories: 50,
      hubCount: 0,
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).not.toContain('hubs');
  });

  it('includes frozen count when frozen memories exist', async () => {
    const stats = makeStats({
      totalMemories: 50,
      frozenCount: 8,
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('8 frozen');
  });

  it('excludes frozen count when zero', async () => {
    const stats = makeStats({
      totalMemories: 50,
      frozenCount: 0,
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).not.toContain('frozen');
  });

  it('omits stalest when lastAccessed is recent (within 7 days)', async () => {
    const stats = makeStats({
      totalMemories: 10,
      stalestMemories: [
        {
          id: 'recent-1',
          claim: 'Recent memory',
          lastAccessed: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).not.toContain('stalest');
  });

  it('includes stalest when lastAccessed exceeds 7 days', async () => {
    const stats = makeStats({
      totalMemories: 10,
      stalestMemories: [
        {
          id: 'old-1',
          claim: 'Ancient memory',
          lastAccessed: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    expect(header).toContain('stalest: 30d old');
  });

  it('joins all parts with periods and ends with a period', async () => {
    const stats = makeStats({
      totalMemories: 100,
      topSubjects: [{ subject: 'flutter', count: 50 }],
      hubCount: 3,
      frozenCount: 1,
    });
    const repo = makeMockRepo(stats);

    const header = await buildMetaMemoryHeader(repo);

    // Format: "Memory system: 100 memories. top subjects: flutter (50). 3 hubs. 1 frozen."
    const parts = header.split('. ');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(header.endsWith('.')).toBe(true);
  });

  it('calls getMetaMemoryStats on the repository', async () => {
    const stats = makeStats({ totalMemories: 1 });
    const repo = makeMockRepo(stats);

    await buildMetaMemoryHeader(repo);

    expect(repo.getMetaMemoryStats).toHaveBeenCalledOnce();
  });
});
