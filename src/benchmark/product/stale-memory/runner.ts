#!/usr/bin/env npx tsx
/**
 * Stale Memory bench (S51 / D3), runner.
 *
 * Validates S49's bi-temporal supersession on real Wikidata revision data.
 * Per scenario: a (subject, predicate) pair with old_value (past) and
 * new_value (current), seeded into memory either Mode A (only old) or
 * Mode B (both with proper validFrom). The query asks the current value;
 * the engine should return new_value, not old_value.
 *
 * Outcome categories per query:
 *   correct , only new_value in answer
 *   partial , both surfaced (supersession partial)
 *   wrong   , only old_value in answer (supersession failed)
 *   refusal , engine refused; acceptable IF Mode A and engine never had
 *              new_value to surface. Wrong otherwise.
 *
 * Fixture: fixtures/benchmark/product/stale-memory/{mini,full}.json
 *   built by scripts/fetch-wikidata-stale-fixture.py.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callLLM } from '../../llm-caller.js';
import { callJudgeCached } from '../../judge-cache.js';
import { runProductBench, type ScorerInput, type ScorerOutput } from '../harness.js';
import { buildSemanticJudgePrompt, parseYesNo } from '../scorer.js';
import type { ProductFixture, ProductReport } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANSWER_MODEL_DEFAULT = 'gpt-4o-mini';
const JUDGE_MODEL_DEFAULT = 'gpt-4o-mini';
const MAX_RULES_DEFAULT = 65;

const REFUSAL_RE =
  /\b(I (?:cannot|can'?t|am unable to|do(?: not|n'?t) (?:know|have))|no (?:information|context|data|mention)|context (?:does ?n'?t|does not) (?:contain|include|mention))\b/i;

function containsValue(text: string, value: string): boolean {
  if (!value) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(text).includes(norm(value));
}

async function staleMemoryScorer(input: ScorerInput): Promise<ScorerOutput> {
  const meta = (input.query.meta ?? {}) as { mode?: string; old_value?: string; new_value?: string };
  const oldVal = meta.old_value ?? '';
  const newVal = meta.new_value ?? '';
  const mode = meta.mode ?? 'A';
  const predicted = input.predicted ?? '';

  const sawOld = containsValue(predicted, oldVal);
  const sawNew = containsValue(predicted, newVal);
  const refused = REFUSAL_RE.test(predicted);

  let outcome: 'correct' | 'partial' | 'wrong' | 'refusal';
  if (sawNew && !sawOld) outcome = 'correct';
  else if (sawNew && sawOld) outcome = 'partial';
  else if (sawOld && !sawNew) outcome = 'wrong';
  else if (refused) outcome = 'refusal';
  else outcome = 'wrong';

  let correct = outcome === 'correct';
  // Mode A: refusal acceptable because the engine genuinely has no current value.
  if (mode === 'A' && outcome === 'refusal') correct = true;

  // LLM judge fallback for entity-paraphrase tolerance (Microsoft / MSFT / Microsoft Corp)
  // when deterministic check did not find new_value but the LLM may have used a paraphrase.
  let judgeAccepted: boolean | undefined;
  if (!correct && !sawOld && !refused) {
    const prompt = buildSemanticJudgePrompt(
      input.query.question,
      newVal,
      predicted,
      input.judgePromptTemplate ? { promptTemplate: input.judgePromptTemplate } : {},
    );
    try {
      // S68: persistent judge cache (M9). cacheTag = stale-memory.
      // Note: input.callLLM is the harness-provided wrapper; we route directly
      // to callJudgeCached here so the cache layer applies regardless of
      // wrapper. The harness's callLLM remains for the answer call upstream.
      const judgeRes = await callJudgeCached({
        model: input.judgeModel,
        system:
          'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
        user: prompt,
        predicted,
        cacheTag: 'stale-memory',
        maxTokens: 5,
      });
      judgeAccepted = parseYesNo(judgeRes.verdict);
      if (judgeAccepted) {
        outcome = 'correct';
        correct = true;
      }
    } catch {
      // judge failed, keep deterministic outcome
    }
  }

  return {
    correct,
    outcome,
    extra: { mode, oldValue: oldVal, newValue: newVal, sawOld, sawNew, refused, judgeAccepted },
  };
}

function summarizeStaleMemory(report: ProductReport): Record<string, number> {
  const buckets = { correct: 0, partial: 0, wrong: 0, refusal: 0 } as Record<string, number>;
  for (const r of report.results) {
    const o = r.outcome ?? 'wrong';
    buckets[o] = (buckets[o] ?? 0) + 1;
  }
  const total = report.results.length || 1;
  return {
    correctRate: (buckets.correct ?? 0) / total,
    partialRate: (buckets.partial ?? 0) / total,
    wrongRate: (buckets.wrong ?? 0) / total,
    refusalRate: (buckets.refusal ?? 0) / total,
  };
}

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
  return resolve(__dirname, '../../../../fixtures/benchmark/product/stale-memory', `${mode}.json`);
}

export async function loadStaleMemoryFixture(path: string): Promise<ProductFixture> {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as ProductFixture;
  if (raw.bench_id !== 'stale-memory') throw new Error(`Expected bench_id 'stale-memory', got '${raw.bench_id}'`);
  return raw;
}

async function main(): Promise<void> {
  // S59A: bench-env preamble overrides .env for ANSWER_ROUTING / STONE /
  // TEMPORAL / BI_TEMPORAL. Then keep legacy single-bench knobs below.
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('product');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  // Stale-memory seeds historical timestamps; bypass the inactivity breaker.
  process.env.BENCH_SKIP_CIRCUIT_BREAKER = process.env.BENCH_SKIP_CIRCUIT_BREAKER || 'true';

  const cli = parseArgs(process.argv);
  const fixturePath = cli.fixturePath ?? defaultFixturePath(cli.mode);
  const fixture = await loadStaleMemoryFixture(fixturePath);

  console.log(
    `Stale Memory [${cli.mode}] seed=${cli.seed} routed=${cli.routed} → ${fixture.scenarios.length} scenarios`,
  );

  const report = await runProductBench({
    fixture,
    answerModel: cli.answerModel,
    judgeModel: cli.judgeModel,
    maxRules: cli.maxRules,
    seed: cli.seed,
    callLLM,
    customScorer: staleMemoryScorer,
    onProgress: (idx, total) => {
      if (idx % 10 === 0 || idx === total) {
        console.log(`  [${idx}/${total}] scenarios processed`);
      }
    },
  });

  const extra = summarizeStaleMemory(report);
  report.summary.extra = extra;
  console.log('\n=== Stale Memory Summary ===');
  console.log(`  Total Qs:     ${report.summary.totalQuestions}`);
  console.log(`  Correct:      ${(report.summary.accuracy * 100).toFixed(1)}%`);
  console.log(`  Outcome breakdown:`);
  console.log(`    correct:    ${(extra.correctRate! * 100).toFixed(1)}%`);
  console.log(`    partial:    ${(extra.partialRate! * 100).toFixed(1)}%`);
  console.log(`    wrong:      ${(extra.wrongRate! * 100).toFixed(1)}%`);
  console.log(`    refusal:    ${(extra.refusalRate! * 100).toFixed(1)}%`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { staleMemoryScorer, summarizeStaleMemory };
