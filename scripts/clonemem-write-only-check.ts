#!/usr/bin/env tsx
/**
 * S53 verification: simulate CloneMem mini's seed phase against the new
 * refusal-first injection validation. Counts rejections to verify zero
 * legitimate-content false positives bleed through to actual writes.
 *
 * Skips the LLM-eval phase, we only care about whether claims that pass
 * extracted-fact validation in S52 still pass under S53 refusal-first.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMemoryRepository } from '../src/repository/sqlite/index.js';
import { createCoreDispatch } from '../src/core/dispatch.js';
import { loadConfig } from '../src/config.js';
import { initialize as initializeEmbeddings, isInitialized } from '../src/embeddings/index.js';

async function main(): Promise<void> {
  process.env.DEMIURGE_API_KEY = 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'error';
  process.env.TEST_MODE = 'true';
  process.env.BENCH_SKIP_CIRCUIT_BREAKER = 'true';

  const config = loadConfig();
  if (!isInitialized()) {
    try {
      await initializeEmbeddings(config.modelPath);
    } catch (err) {
      console.warn('embeddings init failed:', err);
    }
  }

  const tier = '100k';
  const dir = `/root/public-benches/CloneMemBench/data/releases/${tier}`;
  const personas = readdirSync(dir)
    .filter((f) => f.endsWith('_benchmark_en.json'))
    .slice(0, 2); // mini = first 2

  let totalAttempts = 0;
  let writeOK = 0;
  let validationRejected = 0;
  const otherErrors: string[] = [];
  const rejectionReasons: Record<string, number> = {};

  for (const fname of personas) {
    const persona = JSON.parse(readFileSync(join(dir, fname), 'utf8'));
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    const dispatch = createCoreDispatch(repo, config);

    let pSeeded = 0;
    let pRejected = 0;
    for (const ctx of persona.context) {
      totalAttempts++;
      const rawClaim = `[${ctx.medium}] ${ctx.content}`;
      const claim = rawClaim.length > 2000 ? rawClaim.slice(0, 1997) + '...' : rawClaim;
      const validFrom =
        ctx.event_date.includes('Z') || /[+-]\d\d:\d\d$/.test(ctx.event_date) ? ctx.event_date : ctx.event_date + 'Z';
      try {
        const result = await dispatch.addMemory({
          claim,
          subject: 'user',
          source: 'user',
          confidence: 0.95,
          validFrom,
        });
        if (result.action === 'rejected') {
          pRejected++;
          validationRejected++;
          const reason = (result as any).reason ?? 'unknown';
          rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
        } else {
          pSeeded++;
          writeOK++;
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'ValidationError') {
          pRejected++;
          validationRejected++;
          const reason = err.message;
          rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
        } else {
          otherErrors.push(err instanceof Error ? err.message.slice(0, 100) : String(err));
        }
      }
    }
    console.log(`  ${fname}: seeded ${pSeeded}/${persona.context.length}, rejected ${pRejected}`);

    await repo.close();
  }

  console.log();
  console.log(`TOTAL: ${totalAttempts} writes attempted`);
  console.log(`  Seeded OK: ${writeOK}`);
  console.log(`  Validation-rejected: ${validationRejected}`);
  console.log(`  Other errors: ${otherErrors.length}`);
  console.log();
  if (Object.keys(rejectionReasons).length > 0) {
    console.log('REJECTION REASONS:');
    for (const [r, c] of Object.entries(rejectionReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  [${c}] ${r}`);
    }
  }
  if (otherErrors.length > 0) {
    console.log();
    console.log('OTHER ERRORS:');
    for (const e of otherErrors.slice(0, 5)) console.log('  ', e);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
