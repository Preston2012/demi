#!/usr/bin/env npx tsx
/**
 * Paraphrase Stability bench (S51 / D5), runner.
 *
 * Per cluster:
 *   1. Seed 1 fact.
 *   2. Run all 4 paraphrased queries.
 *   3. Compute:
 *      - paraphraseAccuracy: per-question correctness via LLM judge.
 *      - clusterPass: ALL 4 paraphrases correct AND mean pairwise retrieval
 *        Jaccard ≥ 0.8.
 *      - meanJaccard: mean over the 6 cluster-internal pairs.
 *
 * Reports: cluster_pass_rate, paraphrase_accuracy, mean_jaccard, per-form
 * accuracy (canonical / lexical / syntactic / indirect).
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { callLLM } from '../../llm-caller.js';
import { callJudgeCached } from '../../judge-cache.js';
import { buildSemanticJudgePrompt, jaccard, parseYesNo } from '../scorer.js';
import { generate } from './generator.js';
import type { ProductQuestionResult, ProductReport } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANSWER_MODEL_DEFAULT = 'gpt-4o-mini';
const JUDGE_MODEL_DEFAULT = 'gpt-4o-mini';
const MAX_RULES_DEFAULT = 65;
const JACCARD_THRESHOLD = 0.8;

const ANSWER_PROMPT =
  'Answer using only the provided memory context. Be concise. ' +
  'If the context does not contain the answer, say so explicitly.';

interface CliArgs {
  mode: 'mini' | 'full';
  routed: boolean;
  seed: number;
  answerModel: string;
  judgeModel: string;
  maxRules: number;
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
  return { mode, routed: args.includes('--routed'), seed, answerModel, judgeModel, maxRules };
}

function pairwiseJaccard(retrievedSets: ReadonlyArray<ReadonlyArray<string>>): number {
  if (retrievedSets.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < retrievedSets.length; i++) {
    for (let j = i + 1; j < retrievedSets.length; j++) {
      sum += jaccard(retrievedSets[i]!, retrievedSets[j]!);
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 1;
}

async function runParaphrase(): Promise<ProductReport> {
  // S59A: bench-env preamble
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('paraphrase');
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

  const fixture = generate(cli.seed, cli.mode);
  const totalQ = fixture.scenarios.reduce((a, s) => a + s.queries.length, 0);
  console.log(
    `Paraphrase [${cli.mode}] seed=${cli.seed} routed=${cli.routed} → ${fixture.scenarios.length} clusters, ${totalQ} questions`,
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

  const allResults: ProductQuestionResult[] = [];
  const clusterStats: Array<{ clusterId: string; passed: boolean; meanJaccard: number; numCorrect: number }> = [];

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

    const retrievedPerQuery: string[][] = [];
    const correctPerQuery: boolean[] = [];
    for (const q of sc.queries) {
      const totalStart = performance.now();
      let predicted = '';
      let retrieved_count = 0;
      let retrieved_ids: string[] = [];
      let retrieved_claims: string[] = [];
      let retrieval_ms = 0;
      let error: string | undefined;
      let correct = false;

      try {
        const tStart = performance.now();
        const search = await dispatch.search(q.question, cli.maxRules);
        retrieval_ms = performance.now() - tStart;
        retrieved_count = search.raw.candidates.length;
        retrieved_ids = search.raw.candidates.map((c) => c.id);
        retrieved_claims = search.raw.candidates.map((c) => c.candidate.record.claim);

        const userPrompt = `Context:\n${search.contextText}\n\nQuestion: ${q.question}`;
        // S65 prompt-audit pass 2: cacheKey added.
        predicted = await callLLM(cli.answerModel, ANSWER_PROMPT, userPrompt, 200, 0, {
          cacheKey: 'demiurge:paraphrase:answer:v1',
        });

        const judgePrompt = buildSemanticJudgePrompt(q.question, q.expected, predicted);
        // S68: persistent judge cache (M9). cacheTag scopes entries per-bench.
        const judgeRes = await callJudgeCached({
          model: cli.judgeModel,
          system:
            'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
          user: judgePrompt,
          predicted,
          cacheTag: 'paraphrase',
          maxTokens: 5,
          llmCacheKey: 'demiurge:paraphrase:judge:v1',
        });
        correct = parseYesNo(judgeRes.verdict);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      retrievedPerQuery.push(retrieved_ids);
      correctPerQuery.push(correct);

      const total_ms = performance.now() - totalStart;
      const result: ProductQuestionResult = {
        qid: q.qid,
        scenario_id: sc.scenario_id,
        question: q.question,
        expected: q.expected,
        predicted,
        correct,
        retrieved_count,
        retrieved_ids,
        retrieved_claims,
        retrieval_ms,
        total_ms,
      };
      if (q.category !== undefined) result.category = q.category;
      if (error !== undefined) result.error = error;
      allResults.push(result);
    }

    const meanJaccard = pairwiseJaccard(retrievedPerQuery);
    const numCorrect = correctPerQuery.filter(Boolean).length;
    const allCorrect = numCorrect === sc.queries.length;
    const passed = allCorrect && meanJaccard >= JACCARD_THRESHOLD;
    clusterStats.push({ clusterId: sc.scenario_id, passed, meanJaccard, numCorrect });

    if (typeof (repo as { close?: () => void }).close === 'function') {
      (repo as { close: () => void }).close();
    }
    if ((i + 1) % 10 === 0 || i === fixture.scenarios.length - 1) {
      const passRate = clusterStats.filter((c) => c.passed).length / clusterStats.length;
      console.log(`  [${i + 1}/${fixture.scenarios.length}] cluster pass rate so far: ${(passRate * 100).toFixed(1)}%`);
    }
  }

  // Aggregates
  const totalQuestions = allResults.length;
  const correctQuestions = allResults.filter((r) => r.correct).length;
  const paraphraseAccuracy = totalQuestions > 0 ? correctQuestions / totalQuestions : 0;

  const totalClusters = clusterStats.length;
  const passedClusters = clusterStats.filter((c) => c.passed).length;
  const clusterPassRate = totalClusters > 0 ? passedClusters / totalClusters : 0;

  const meanJaccard = totalClusters > 0 ? clusterStats.reduce((a, c) => a + c.meanJaccard, 0) / totalClusters : 0;

  const perCategory: Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }> = {};
  for (const r of allResults) {
    const k = r.category ?? '_uncategorised';
    perCategory[k] = perCategory[k] ?? { total: 0, correct: 0, accuracy: 0, meanRetrievalMs: 0 };
    perCategory[k].total++;
    if (r.correct) perCategory[k].correct++;
    perCategory[k].meanRetrievalMs += r.retrieval_ms;
  }
  for (const k of Object.keys(perCategory)) {
    const c = perCategory[k]!;
    c.accuracy = c.total > 0 ? c.correct / c.total : 0;
    c.meanRetrievalMs = c.total > 0 ? c.meanRetrievalMs / c.total : 0;
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: ProductReport = {
    benchmark: 'paraphrase',
    upstream_version: fixture.upstream_version,
    timestamp: new Date().toISOString(),
    commit,
    config: {
      mode: fixture.mode,
      answerModel: cli.answerModel,
      judgeModel: cli.judgeModel,
      maxRules: cli.maxRules,
      seed: cli.seed,
    },
    summary: {
      totalQuestions,
      correct: correctQuestions,
      accuracy: paraphraseAccuracy,
      perCategory,
      extra: {
        clusterPassRate,
        passedClusters,
        totalClusters,
        meanJaccard,
        paraphraseAccuracy,
      },
    },
    results: allResults,
  };

  const outDir = resolve(__dirname, '../../../../benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `paraphrase-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${out}`);

  console.log('\n=== Paraphrase Stability Summary ===');
  console.log(
    `  Cluster pass rate (all 4 correct + Jaccard≥0.8): ${(clusterPassRate * 100).toFixed(1)}% (${passedClusters}/${totalClusters})`,
  );
  console.log(`  Paraphrase-level accuracy: ${(paraphraseAccuracy * 100).toFixed(1)}%`);
  console.log(`  Mean retrieval Jaccard:    ${meanJaccard.toFixed(3)}`);
  for (const [form, v] of Object.entries(perCategory)) {
    console.log(`    ${form.padEnd(12)}: ${(v.accuracy * 100).toFixed(1)}% (${v.correct}/${v.total})`);
  }
  return report;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runParaphrase().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runParaphrase, pairwiseJaccard };
