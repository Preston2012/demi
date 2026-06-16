#!/usr/bin/env tsx
/**
 * S74 Wedge 2: backfill assertion_triples for pre-existing memories.
 *
 * Thin CLI wrapper around `backfillTriples` (src/plan/backfill.ts). The
 * core logic lives in src/ so tests exercise the same code path.
 *
 * Usage:
 *
 *   npx tsx scripts/migrate-assertion-triples.ts            # dry-run, prints counts
 *   npx tsx scripts/migrate-assertion-triples.ts --apply    # actually write
 *   npx tsx scripts/migrate-assertion-triples.ts --apply --db ./data/demiurge.db
 *   npx tsx scripts/migrate-assertion-triples.ts --apply --force-rewrite
 *
 * Run on a COPY of prod data first. Verify counts. Then run on prod.
 * Subsequent ingests write triples inline at repo.insert; backfill never
 * needs to re-run unless the grammar in triples.ts materially expands.
 */

import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { SqliteMemoryRepository } from '../src/repository/sqlite/index.js';
import { backfillTriples } from '../src/plan/backfill.js';

interface Args {
  apply: boolean;
  forceRewrite: boolean;
  dbPath?: string;
  batchSize: number;
}

function parseArgs(): Args {
  const args: Args = { apply: false, forceRewrite: false, batchSize: 500 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force-rewrite') args.forceRewrite = true;
    else if (a === '--db' && i + 1 < argv.length) {
      args.dbPath = argv[++i];
    } else if (a === '--batch' && i + 1 < argv.length) {
      const v = parseInt(argv[++i] ?? '500', 10);
      if (Number.isFinite(v) && v > 0) args.batchSize = v;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: migrate-assertion-triples.ts [--apply] [--force-rewrite] [--db PATH] [--batch N]

  --apply           Write triples. Without this flag the script is a dry-run.
  --force-rewrite   Delete existing triples for matched memories, then re-insert.
                    Use after expanding the grammar in src/plan/triples.ts.
  --db PATH         Override the configured DB path.
  --batch N         Rows per progress tick (default 500).
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'a'.repeat(32);
  const config = loadConfig();
  const effectivePath = args.dbPath ?? config.dbPath;

  if (!existsSync(effectivePath) && effectivePath !== ':memory:') {
    console.error(`DB not found at ${effectivePath}. Pass --db <path> or set DB_PATH.`);
    process.exit(2);
  }

  const repo = new SqliteMemoryRepository({ ...config, dbPath: effectivePath });
  await repo.initialize();

  console.log(`db: ${effectivePath}, dry-run: ${!args.apply}, force-rewrite: ${args.forceRewrite}`);

  const stats = await backfillTriples(repo, {
    apply: args.apply,
    forceRewrite: args.forceRewrite,
    batchSize: args.batchSize,
    onProgress: (scanned, total) => {
      console.log(`scanned ${scanned}/${total}`);
    },
  });

  console.log('');
  console.log('--- Backfill summary ---');
  console.log(`Memories to scan:           ${stats.total}`);
  console.log(`Memories scanned:           ${stats.scanned}`);
  console.log(`Already had triples:        ${stats.skippedExisting}`);
  console.log(`Memories ${args.apply ? 'written' : 'WOULD BE written (dry-run)'}: ${stats.written}`);
  console.log(`Triples ${args.apply ? 'written' : 'WOULD BE written'}:           ${stats.triplesWritten}`);
  console.log(`  of which fallback rows: ${stats.fallbackRows} (${pct(stats.fallbackRows, stats.triplesWritten)}%)`);
  console.log(`  of which pattern rows:  ${stats.patternRows} (${pct(stats.patternRows, stats.triplesWritten)}%)`);
  console.log('');
  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to write.');
  }

  await repo.close();
}

function pct(num: number, denom: number): string {
  if (denom === 0) return '0.0';
  return ((num / denom) * 100).toFixed(1);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
