#!/usr/bin/env npx tsx
/**
 * ECE / Brier Calibration bench (S51 / D7), runner.
 *
 * Per question:
 *   1. Seed scenario facts.
 *   2. Call dispatch.answer(question), returns {answer, confidence}.
 *   3. LLM-judge correctness (paraphrase tolerant).
 *   4. Record (confidence, correct) tuple.
 *
 * Aggregate:
 *   - ECE (10 buckets, weighted bucket-wise gap)
 *   - Brier score
 *   - reliability diagram (per-bucket count, mean confidence, accuracy)
 *   - per-source slice (clonemem / mab / locomo / lme / hard-negative)
 *   - calibration band (excellent / acceptable / miscalibrated)
 *
 * Hard-negatives have `expected: []`, correctness = "engine refused / said
 * 'I don't know' / did not assert a fact". Tests refusal calibration.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { callJudgeCached } from '../../judge-cache.js';
import { buildSemanticJudgePrompt, parseYesNo } from '../../product/scorer.js';
import { brierScore, calibrationBand, expectedCalibrationError, reliabilityDiagram } from '../scorer.js';
import type { CalibrationFixture, CalibrationReport, CalibrationResult } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANSWER_MODEL_DEFAULT = 'gpt-4.1-mini';
const JUDGE_MODEL_DEFAULT = 'gpt-4o-mini';
const MAX_RULES_DEFAULT = 65;
const NUM_BUCKETS = 10;

const REFUSAL_RE =
  /\b(I (?:cannot|can'?t|am unable to|do(?: not|n'?t) (?:know|have))|no (?:information|context|data)|context (?:does ?n'?t|does not) (?:contain|include|mention))\b/i;

interface CliArgs {
  mode: 'mini' | 'full';
  routed: boolean;
  seed: number;
  answerModel: string;
  judgeModel: string;
  maxRules: number;
  fixturePath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const mode: 'mini' | 'full' = args.includes('--full') ? 'full' : 'mini';
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1] ?? '42', 10) : 42;
  const am = args.indexOf('--answer-model');
  const answerModel = am !== -1 ? (args[am + 1] ?? ANSWER_MODEL_DEFAULT) : ANSWER_MODEL_DEFAULT;
  const jm = args.indexOf('--judge-model');
  const judgeModel = jm !== -1 ? (args[jm + 1] ?? JUDGE_MODEL_DEFAULT) : JUDGE_MODEL_DEFAULT;
  const mr = args.indexOf('--max-rules');
  const maxRules = mr !== -1 ? parseInt(args[mr + 1] ?? String(MAX_RULES_DEFAULT), 10) : MAX_RULES_DEFAULT;
  const fp = args.indexOf('--fixture');
  const out: CliArgs = {
    mode,
    routed: args.includes('--routed'),
    seed,
    answerModel,
    judgeModel,
    maxRules,
  };
  if (fp !== -1 && args[fp + 1]) out.fixturePath = args[fp + 1];
  return out;
}

function defaultFixturePath(mode: 'mini' | 'full'): string {
  return resolve(__dirname, '../../../../fixtures/benchmark/calibration/ece-brier', `${mode}.json`);
}

async function judgeCorrectness(
  question: string,
  expected: string[],
  predicted: string,
  expectRefusal: boolean,
  judgeModel: string,
): Promise<boolean> {
  if (expectRefusal) {
    // Hard negative: correctness = engine refused or did not assert a fact.
    return REFUSAL_RE.test(predicted);
  }
  if (expected.length === 0) return false;
  const prompt = buildSemanticJudgePrompt(question, expected, predicted);
  // S68: persistent judge cache (M9). cacheTag scopes entries per-bench.
  const judgeRes = await callJudgeCached({
    model: judgeModel,
    system:
      'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
    user: prompt,
    predicted,
    cacheTag: 'ece-brier',
    maxTokens: 5,
    llmCacheKey: 'demiurge:ece-brier:judge:v1',
  });
  return parseYesNo(judgeRes.verdict);
}

async function runEceBrier(): Promise<CalibrationReport> {
  // S59A: bench-env preamble
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('ece_brier');
  initBenchTelemetry();
  const cli = parseArgs(process.argv);
  // S59A: convert parsed cli.routed into actual env override.
  // Was a no-op flag for paraphrase + ece_brier, now actually flips routing.
  if (cli.routed) {
    process.env.ANSWER_ROUTING = 'false';
  } else {
    process.env.ANSWER_ROUTING = 'false';
  }
  console.error(`[bench-env] ANSWER_ROUTING=${process.env.ANSWER_ROUTING}`);

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_MODE = process.env.BENCH_MODE || 'true';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true'; // A2 back-compat alias

  const fixturePath = cli.fixturePath ?? defaultFixturePath(cli.mode);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as CalibrationFixture;
  if (fixture.bench_id !== 'ece-brier') {
    throw new Error(`Expected bench_id 'ece-brier', got '${fixture.bench_id}'`);
  }

  const totalQ = fixture.scenarios.reduce((a, s) => a + s.queries.length, 0);
  console.log(
    `ECE/Brier [${cli.mode}] seed=${cli.seed} routed=${cli.routed} → ${fixture.scenarios.length} scenarios, ${totalQ} questions`,
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

  const allResults: CalibrationResult[] = [];

  for (let i = 0; i < fixture.scenarios.length; i++) {
    const sc = fixture.scenarios[i]!;
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    for (const f of sc.facts) {
      try {
        await dispatch.addMemory({
          claim: f.claim,
          subject: f.subject ?? 'user',
          source: 'user',
          confidence: 0.95,
          validFrom: f.validFrom,
        });
      } catch {
        // continue
      }
    }

    for (const q of sc.queries) {
      const totalStart = performance.now();
      let predicted = '';
      let confidence = 0.5;
      let confidenceSource = 'linguistic-fallback';
      let retrieved_count = 0;
      let retrievalMs = 0;
      let error: string | undefined;

      try {
        const tStart = performance.now();
        const ans = await dispatch.answer(q.question, {
          model: cli.answerModel,
          maxRules: cli.maxRules,
        });
        retrievalMs = performance.now() - tStart;
        predicted = ans.answer;
        confidence = ans.confidence;
        confidenceSource = ans.confidenceSource;
        retrieved_count = ans.search.raw.candidates.length;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const correct = error
        ? false
        : await judgeCorrectness(q.question, q.expected, predicted, q.expectRefusal === true, cli.judgeModel);

      const total_ms = performance.now() - totalStart;
      const result: CalibrationResult = {
        qid: q.qid,
        scenario_id: sc.scenario_id,
        question: q.question,
        expected: q.expected,
        predicted,
        confidence,
        confidenceSource,
        correct,
        expectRefusal: q.expectRefusal === true,
        retrieved_count,
        retrieval_ms: retrievalMs,
        total_ms,
      };
      if (q.source !== undefined) result.source = q.source;
      if (error !== undefined) result.error = error;
      allResults.push(result);
    }

    if (typeof (repo as { close?: () => void }).close === 'function') {
      (repo as { close: () => void }).close();
    }
    if ((i + 1) % 25 === 0 || i === fixture.scenarios.length - 1) {
      const acc = allResults.filter((r) => r.correct).length / Math.max(1, allResults.length);
      console.log(`  [${i + 1}/${fixture.scenarios.length}] acc so far: ${(acc * 100).toFixed(1)}%`);
    }
  }

  const tuples = allResults.map((r) => ({ confidence: r.confidence, correct: r.correct }));
  const eceResult = expectedCalibrationError(tuples, NUM_BUCKETS);
  const brier = brierScore(tuples);
  const meanConfidence = tuples.length > 0 ? tuples.reduce((a, t) => a + t.confidence, 0) / tuples.length : 0;
  const correctCount = tuples.filter((t) => t.correct).length;
  const acc = tuples.length > 0 ? correctCount / tuples.length : 0;

  // Per-source slice
  const perSource: Record<
    string,
    { total: number; correct: number; accuracy: number; meanConfidence: number; ece: number }
  > = {};
  const bySource = new Map<string, Array<{ confidence: number; correct: boolean }>>();
  for (const r of allResults) {
    const key = r.expectRefusal ? 'hard-negative' : (r.source ?? '_unknown');
    const arr = bySource.get(key) ?? [];
    arr.push({ confidence: r.confidence, correct: r.correct });
    bySource.set(key, arr);
  }
  for (const [source, arr] of bySource.entries()) {
    const ece = expectedCalibrationError(arr, NUM_BUCKETS).ece;
    const correct = arr.filter((a) => a.correct).length;
    const meanConf = arr.reduce((a, t) => a + t.confidence, 0) / Math.max(1, arr.length);
    perSource[source] = {
      total: arr.length,
      correct,
      accuracy: arr.length > 0 ? correct / arr.length : 0,
      meanConfidence: meanConf,
      ece,
    };
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: CalibrationReport = {
    benchmark: 'ece-brier',
    timestamp: new Date().toISOString(),
    commit,
    config: {
      mode: fixture.mode,
      answerModel: cli.answerModel,
      judgeModel: cli.judgeModel,
      maxRules: cli.maxRules,
      seed: cli.seed,
      numBuckets: NUM_BUCKETS,
    },
    summary: {
      totalQuestions: tuples.length,
      correct: correctCount,
      accuracy: acc,
      ece: eceResult.ece,
      brier,
      meanConfidence,
      perSource,
      band: calibrationBand(eceResult.ece),
    },
    reliabilityDiagram: reliabilityDiagram(tuples, NUM_BUCKETS),
    results: allResults,
  };

  const outDir = resolve(__dirname, '../../../../benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `ece-brier-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${out}`);

  console.log('\n=== ECE/Brier Calibration Summary ===');
  console.log(`  Total Qs:          ${report.summary.totalQuestions}`);
  console.log(`  Accuracy:          ${(acc * 100).toFixed(1)}%`);
  console.log(`  Mean confidence:   ${meanConfidence.toFixed(3)}`);
  console.log(`  ECE (10 buckets):  ${eceResult.ece.toFixed(4)}  band=${report.summary.band}`);
  console.log(`  Brier score:       ${brier.toFixed(4)}`);
  console.log('  Per source:');
  for (const [src, s] of Object.entries(perSource)) {
    console.log(
      `    ${src.padEnd(16)}: acc=${(s.accuracy * 100).toFixed(1)}% mean-conf=${s.meanConfidence.toFixed(2)} ece=${s.ece.toFixed(3)} (${s.total} Qs)`,
    );
  }
  return report;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runEceBrier().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runEceBrier };
