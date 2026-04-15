import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../repository/interface.js';
import type { Config } from '../config.js';
import type { SelfPlayRun, SelfPlayResult } from '../schema/memory.js';
import { AuditAction } from '../schema/audit.js';
import { retrieve } from '../retrieval/index.js';
import { createLogger } from '../config.js';

const log = createLogger('self-play');

/**
 * Self-play evaluation: the only idea making quality provable.
 * (Claude's unique contribution from novel council.)
 *
 * Generate queries from stored memories, run retrieval, check if
 * the source memory appears in results. Measures retrieval quality
 * without external benchmarks.
 *
 * Runs every 2-3 days. Cost: retrieval only (no LLM on read path).
 */

export interface SelfPlayConfig {
  queriesPerRun: number;
  topKCheck: number;
}

const DEFAULT_CONFIG: SelfPlayConfig = {
  queriesPerRun: 50,
  topKCheck: 15,
};

/**
 * Run a self-play evaluation batch.
 */
export async function runSelfPlay(
  repo: IMemoryRepository,
  config: Config,
  selfPlayConfig: Partial<SelfPlayConfig> = {},
): Promise<SelfPlayRun> {
  const cfg = { ...DEFAULT_CONFIG, ...selfPlayConfig };
  const runId = uuid();
  const startedAt = new Date().toISOString();

  const run: SelfPlayRun = {
    id: runId,
    startedAt,
    completedAt: null,
    queriesGenerated: 0,
    retrievalsPassed: 0,
    retrievalsFailed: 0,
    notes: null,
  };

  await repo.insertSelfPlayRun(run);
  await repo.appendAuditLog({
    memoryId: null,
    action: AuditAction.SELF_PLAY_STARTED,
    details: `Run ${runId}: ${cfg.queriesPerRun} queries planned`,
  });

  log.info({ runId, queries: cfg.queriesPerRun }, 'Self-play started');

  // Sample memories to generate queries from
  const allMemories: { id: string; claim: string; subject: string }[] = [];
  for await (const record of repo.exportAll()) {
    if (record.trustClass === 'confirmed' || record.trustClass === 'auto-approved') {
      allMemories.push({ id: record.id, claim: record.claim, subject: record.subject });
    }
  }

  if (allMemories.length === 0) {
    run.completedAt = new Date().toISOString();
    run.notes = 'No eligible memories to test';
    await repo.updateSelfPlayRun(runId, run);
    return run;
  }

  // Shuffle and take N
  const sampled = allMemories.sort(() => Math.random() - 0.5).slice(0, cfg.queriesPerRun);

  let passed = 0;
  let failed = 0;

  for (const mem of sampled) {
    // Generate a query from the memory's subject + first few words
    const query = generateQuery(mem.claim, mem.subject);

    try {
      const result = await retrieve(repo, query, config, cfg.topKCheck);
      const foundIds = result.candidates.map((c) => c.id);
      const found = foundIds.includes(mem.id);

      // Score gap: how far from top was it? (0 = top, negative = not found)
      const position = foundIds.indexOf(mem.id);
      const scoreGap = found
        ? (result.candidates[0]?.finalScore ?? 0) - (result.candidates[position]?.finalScore ?? 0)
        : -1;

      const selfPlayResult: SelfPlayResult = {
        id: uuid(),
        runId,
        query,
        expectedMemoryId: mem.id,
        actualMemoryId: found ? mem.id : (foundIds[0] ?? null),
        passed: found,
        scoreGap,
        details: found ? `Found at position ${position + 1}` : `Not in top ${cfg.topKCheck}`,
      };

      await repo.insertSelfPlayResult(selfPlayResult);

      if (found) passed++;
      else failed++;
    } catch (err) {
      failed++;
      log.error({ err, memoryId: mem.id }, 'Self-play query failed');
    }
  }

  run.completedAt = new Date().toISOString();
  run.queriesGenerated = sampled.length;
  run.retrievalsPassed = passed;
  run.retrievalsFailed = failed;
  run.notes = `${passed}/${sampled.length} passed (${((passed / sampled.length) * 100).toFixed(1)}%)`;

  await repo.updateSelfPlayRun(runId, run);
  await repo.appendAuditLog({
    memoryId: null,
    action: AuditAction.SELF_PLAY_COMPLETED,
    details: run.notes,
  });

  log.info({ runId, passed, failed, total: sampled.length }, 'Self-play complete');
  return run;
}

/**
 * Generate a search query from a memory's claim and subject.
 * Uses the subject + key words from the claim.
 */
function generateQuery(claim: string, subject: string): string {
  // Take first 5 significant words from the claim
  const words = claim
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  return `${subject} ${words.join(' ')}`.trim();
}
