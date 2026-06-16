#!/usr/bin/env tsx
/**
 * B1b: human-facing analyzer report.
 *
 * Reads the telemetry trace DB (default: ./data/telemetry.db) and prints
 * a markdown report of per-query-type weight recommendations. Use with:
 *
 *   npm run analyze:weights
 *   npm run analyze:weights -- --window 30
 *   npm run analyze:weights -- --apply             # dry-run apply through gates
 *   npm run analyze:weights -- --db ./other.db
 *
 * Read-only by default. `--apply` runs the recommendations through B1c's
 * safety gates and prints what would change, does NOT actually update
 * any config file. Auto-apply at boot is the WEIGHT_TUNER_AUTO_APPLY
 * flag in src/boot.ts.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync } from 'node:fs';
import { analyzeRetrievalQuality, applyRecommendations } from '../src/learn/weight-tuner.js';
import { DEFAULT_WEIGHTS } from '../src/retrieval/scorer.js';

interface Args {
  dbPath: string;
  windowDays: number;
  apply: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    dbPath: process.env.TELEMETRY_DB_PATH ?? './data/telemetry.db',
    windowDays: 7,
    apply: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--db') {
      args.dbPath = argv[++i] ?? args.dbPath;
    } else if (a === '--window') {
      args.windowDays = parseInt(argv[++i] ?? '7', 10);
    } else if (a === '--apply') {
      args.apply = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: analyze:weights [--db <path>] [--window <days>] [--apply] [--json]`);
      process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs();
  if (!existsSync(args.dbPath)) {
    console.error(`Trace DB not found at ${args.dbPath}. Set TELEMETRY_DB_PATH or use --db.`);
    process.exit(1);
  }
  const db = new Database(args.dbPath, { readonly: true });
  try {
    const recs = analyzeRetrievalQuality(db, { windowDays: args.windowDays });

    if (args.json) {
      const payload: Record<string, unknown> = { window_days: args.windowDays, recommendations: recs };
      if (args.apply) {
        const { applied, audit } = applyRecommendations(recs, DEFAULT_WEIGHTS);
        payload.applied = applied;
        payload.audit = audit;
      }
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`# Retrieval weight tuner report`);
    console.log(``);
    console.log(`- DB: \`${args.dbPath}\``);
    console.log(`- Window: ${args.windowDays} day(s)`);
    console.log(`- Buckets found: ${recs.length}`);
    console.log(``);

    if (recs.length === 0) {
      console.log(
        `_No retrieval/injection events in window. Either telemetry is disabled, this is a fresh install, or the window is too narrow._`,
      );
      return;
    }

    for (const rec of recs) {
      console.log(`## query_type: \`${rec.queryType}\``);
      console.log(``);
      console.log(`- Sample size: **${rec.sampleSize}**  confidence: **${rec.confidence}**`);
      if (rec.stats) {
        console.log(
          `- Reuse rate: ${(rec.stats.reuseRate * 100).toFixed(1)}%   pairs analyzed: ${rec.stats.pairsAnalyzed}`,
        );
        console.log(`- Component correlations (reused − not-reused mean):`);
        for (const [k, v] of Object.entries(rec.stats.componentCorrelations)) {
          console.log(`    - \`${k}\`: ${v >= 0 ? '+' : ''}${v.toFixed(4)}`);
        }
      }
      console.log(``);
      console.log(`> ${rec.rationale}`);
      console.log(``);
      if (Object.keys(rec.suggestedDelta).length > 0) {
        console.log(`Suggested deltas (apply via B1c flag or operator copy-edit):`);
        for (const [k, v] of Object.entries(rec.suggestedDelta)) {
          console.log(`  - \`${k}\`: ${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(4)}`);
        }
        console.log(``);
      }
    }

    if (args.apply) {
      console.log(`---`);
      console.log(`# Dry-run apply (no files written)`);
      console.log(``);
      const { applied, audit } = applyRecommendations(recs, DEFAULT_WEIGHTS);
      for (const line of audit) console.log(`  ${line}`);
      console.log(``);
      console.log(`Resulting weights (would be passed to dispatch at boot):`);
      console.log('```json');
      console.log(JSON.stringify(applied, null, 2));
      console.log('```');
    }
  } finally {
    db.close();
  }
}

main();
