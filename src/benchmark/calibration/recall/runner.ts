#!/usr/bin/env npx tsx
/**
 * Recall@K Calibration bench (S51 / D8), runner.
 *
 * Per cluster:
 *   1. Seed 10 memories. Map memory_id → ground-truth `relevant: bool` label.
 *   2. dispatch.search(question, M_max), single retrieval call.
 *   3. For each k ∈ {3, 5, 10, 65}: compute Precision@k, Recall@k, F1@k.
 *   4. AUPRC: sweep k=1..N, integrate precision-recall curve.
 *
 * Aggregate: mean per-K precision/recall/F1, mean AUPRC across clusters.
 *
 * Why this matters: it fixes the contrarian critique that all accuracy
 * numbers condition on UNKNOWN denominators. With held-out labels we have
 * the actual denominator (the relevant set the engine was supposed to find).
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { aupr, precisionRecallAtK, type RankedItem } from '../scorer.js';
import type { RecallClusterResult, RecallFixture, RecallReport } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_RULES_DEFAULT = 100;
const K_VALUES_DEFAULT = [3, 5, 10, 65];

interface CliArgs {
  mode: 'mini' | 'full';
  routed: boolean;
  seed: number;
  maxRules: number;
  fixturePath?: string;
  kValues: number[];
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const mode: 'mini' | 'full' = args.includes('--full') ? 'full' : 'mini';
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1] ?? '42', 10) : 42;
  const mr = args.indexOf('--max-rules');
  const maxRules = mr !== -1 ? parseInt(args[mr + 1] ?? String(MAX_RULES_DEFAULT), 10) : MAX_RULES_DEFAULT;
  const kIdx = args.indexOf('--k');
  const kValues =
    kIdx !== -1 && args[kIdx + 1]
      ? args[kIdx + 1]!.split(',')
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n))
      : K_VALUES_DEFAULT;
  const fp = args.indexOf('--fixture');
  const out: CliArgs = {
    mode,
    routed: args.includes('--routed'),
    seed,
    maxRules,
    kValues,
  };
  if (fp !== -1 && args[fp + 1]) out.fixturePath = args[fp + 1];
  return out;
}

function defaultFixturePath(mode: 'mini' | 'full'): string {
  return resolve(__dirname, '../../../../fixtures/benchmark/calibration/recall', `${mode}.json`);
}

async function runRecall(): Promise<RecallReport> {
  const cli = parseArgs(process.argv);

  // S59A: bench-env preamble overrides .env for ANSWER_ROUTING / STONE /
  // TEMPORAL / BI_TEMPORAL. Then keep legacy single-bench knobs below.
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('product');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const fixturePath = cli.fixturePath ?? defaultFixturePath(cli.mode);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as RecallFixture;
  if (fixture.bench_id !== 'recall') {
    throw new Error(`Expected bench_id 'recall', got '${fixture.bench_id}'`);
  }

  console.log(
    `Recall@K [${cli.mode}] seed=${cli.seed} routed=${cli.routed} → ${fixture.clusters.length} clusters, k=${cli.kValues.join(',')}`,
  );

  const { loadConfig } = await import('../../../config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
  } catch {
    // lexical-only fallback
  }
  const { SqliteMemoryRepository } = await import('../../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../../core/dispatch.js');

  const clusterResults: RecallClusterResult[] = [];

  for (let i = 0; i < fixture.clusters.length; i++) {
    const cluster = fixture.clusters[i]!;
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    // Seed every memory and map its addMemory-returned id back to the
    // fixture's relevance label.
    const memoryIdToRelevant = new Map<string, boolean>();
    let numRelevant = 0;
    for (const m of cluster.memories) {
      try {
        const r = await dispatch.addMemory({
          claim: m.claim,
          subject: 'user',
          source: 'user',
          confidence: 0.95,
          validFrom: m.validFrom,
        });
        if (r.action !== 'rejected') memoryIdToRelevant.set(r.id, m.relevant);
        if (m.relevant) numRelevant++;
      } catch {
        // continue seeding
      }
    }

    const relevantIds = new Set<string>();
    for (const [id, rel] of memoryIdToRelevant.entries()) if (rel) relevantIds.add(id);

    const tStart = performance.now();
    const search = await dispatch.search(cluster.question, cli.maxRules);
    const retrievalMs = performance.now() - tStart;

    const ranked: RankedItem[] = search.rankedCandidates.map((c) => ({ id: c.id, rankedScore: c.score }));

    const metrics = cli.kValues.map((k) => {
      const m = precisionRecallAtK(ranked, relevantIds, k);
      return {
        k,
        retrieved: Math.min(k, ranked.length),
        truePositives: m.truePositives,
        precision: m.precision,
        recall: m.recall,
        f1: m.f1,
      };
    });

    const auprcVal = aupr(ranked, relevantIds);

    const retrievedRelevance = ranked.map((it) => {
      const entry: { memoryId: string; relevant: boolean; rankedScore?: number } = {
        memoryId: it.id,
        relevant: relevantIds.has(it.id),
      };
      if (it.rankedScore !== undefined) entry.rankedScore = it.rankedScore;
      return entry;
    });

    clusterResults.push({
      cluster_id: cluster.cluster_id,
      question: cluster.question,
      numRelevant,
      numTotal: cluster.memories.length,
      metrics,
      auprc: auprcVal,
      retrieval_ms: retrievalMs,
      retrievedRelevance,
    });

    if (typeof (repo as { close?: () => void }).close === 'function') {
      (repo as { close: () => void }).close();
    }

    if ((i + 1) % 10 === 0 || i === fixture.clusters.length - 1) {
      const meanAuprc = clusterResults.reduce((a, c) => a + c.auprc, 0) / clusterResults.length;
      console.log(`  [${i + 1}/${fixture.clusters.length}] mean AUPRC so far: ${meanAuprc.toFixed(3)}`);
    }
  }

  // Aggregate per-K
  const perK: Record<string, { precision: number; recall: number; f1: number }> = {};
  for (const k of cli.kValues) {
    let p = 0;
    let r = 0;
    let f = 0;
    let n = 0;
    for (const c of clusterResults) {
      const m = c.metrics.find((x) => x.k === k);
      if (!m) continue;
      p += m.precision;
      r += m.recall;
      f += m.f1;
      n++;
    }
    perK[`@${k}`] = {
      precision: n > 0 ? p / n : 0,
      recall: n > 0 ? r / n : 0,
      f1: n > 0 ? f / n : 0,
    };
  }
  const meanAuprc =
    clusterResults.length > 0 ? clusterResults.reduce((a, c) => a + c.auprc, 0) / clusterResults.length : 0;

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: RecallReport = {
    benchmark: 'recall',
    timestamp: new Date().toISOString(),
    commit,
    config: { mode: fixture.mode, seed: cli.seed, kValues: cli.kValues },
    summary: {
      totalClusters: clusterResults.length,
      perK,
      meanAuprc,
    },
    clusters: clusterResults,
  };

  const outDir = resolve(__dirname, '../../../../benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `recall-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${out}`);

  console.log('\n=== Recall@K Summary ===');
  console.log(`  Total clusters: ${clusterResults.length}`);
  console.log(`  Mean AUPRC:     ${meanAuprc.toFixed(3)}`);
  for (const [kKey, m] of Object.entries(perK)) {
    console.log(
      `  ${kKey.padEnd(6)}  P=${(m.precision * 100).toFixed(1)}%  R=${(m.recall * 100).toFixed(1)}%  F1=${(m.f1 * 100).toFixed(1)}%`,
    );
  }
  return report;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runRecall().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runRecall };
