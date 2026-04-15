import type { IMemoryRepository } from '../repository/interface.js';

/**
 * Meta-memory: inject what the system knows ABOUT its memories.
 * One SQL query. 50-100 tokens in output. Massive context signal.
 *
 * "I have 342 memories across 18 subjects. Top subjects: flutter (89),
 * architecture (45), security (23). 3 memories are frozen. 2 inhibitions active.
 * Stalest memory: 47 days old."
 */

export async function buildMetaMemoryHeader(
  repo: IMemoryRepository,
): Promise<string> {
  const stats = await repo.getMetaMemoryStats();

  const parts: string[] = [];
  parts.push(`Memory system: ${stats.totalMemories} memories`);

  if (stats.topSubjects.length > 0) {
    const top3 = stats.topSubjects.slice(0, 3)
      .map((s) => `${s.subject} (${s.count})`)
      .join(', ');
    parts.push(`top subjects: ${top3}`);
  }

  if (stats.hubCount > 0) parts.push(`${stats.hubCount} hubs`);
  if (stats.inhibitoryCount > 0) parts.push(`${stats.inhibitoryCount} inhibitions`);
  if (stats.frozenCount > 0) parts.push(`${stats.frozenCount} frozen`);
  if (stats.coldStorageCount > 0) parts.push(`${stats.coldStorageCount} in cold storage`);

  if (stats.stalestMemories.length > 0) {
    const stalest = stats.stalestMemories[0]!;
    const ageDays = Math.floor(
      (Date.now() - new Date(stalest.lastAccessed).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (ageDays > 7) parts.push(`stalest: ${ageDays}d old`);
  }

  return parts.join('. ') + '.';
}
