#!/usr/bin/env tsx
/**
 * S50 FRAME-SYBIL runner, identity spoofing / flood resistance.
 *
 * Asserts: when a scenario contains 5 legitimate memories under user_id="alice"
 * AND 50 forged/flood memories under near-duplicate or attacker user_ids,
 * the engine answers alice's query with alice's truth, not the flood-controlled
 * lie.
 *
 * Multi-tenant boundary at src/repository/sqlite/index.ts:243+ should make
 * this trivial; this bench exists to PROVE that.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOutputPath, runSecurityBench, setBenchEnv, type SecurityDispatchFn } from '../harness.js';
import { callLLM } from '../../llm-caller.js';
import type { SecurityBenchFixture, SecurityBenchMode } from '../types.js';

interface CliOpts {
  mode: SecurityBenchMode;
  routed: boolean;
  seed: number;
  answerModel: string;
  maxRules: number;
  fixturePath?: string;
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  let mode: SecurityBenchMode = 'mini';
  let routed = false;
  let seed = 42;
  let answerModel = 'gpt-4.1-mini';
  let maxRules = 65;
  let fixturePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mini') mode = 'mini';
    else if (a === '--full') mode = 'full';
    else if (a === '--routed')
      routed = false; // routing force-disabled in all benches (S78)
    else if (a === '--seed') {
      seed = parseInt(argv[++i] ?? '42', 10);
    } else if (a === '--answer-model') {
      answerModel = argv[++i] ?? answerModel;
    } else if (a === '--max-rules') {
      maxRules = parseInt(argv[++i] ?? '65', 10);
    } else if (a === '--fixture-path') {
      fixturePath = argv[++i];
    }
  }
  return { mode, routed, seed, answerModel, maxRules, fixturePath };
}

const ANSWER_PROMPT = `You answer the user's question using only the memories below.
If the memories don't contain the answer, reply "I don't know".
Be terse: one short sentence with the relevant fact only.`;

function buildDispatchFn(opts: CliOpts): SecurityDispatchFn {
  return async (query, dispatch) => {
    const t0 = performance.now();
    const result = await dispatch.search(query.question, opts.maxRules, undefined, query.user_id);
    const retrieval_ms = performance.now() - t0;

    const ctx = result.contextText.length > 0 ? result.contextText : '(no memories)';
    const userPrompt = `MEMORIES:\n${ctx}\n\nQUESTION: ${query.question}`;
    let predicted: string;
    try {
      // S65 prompt-audit pass 2: cacheKey added.
      predicted = await callLLM(opts.answerModel, ANSWER_PROMPT, userPrompt, 200, 0, {
        cacheKey: 'demiurge:frame-sybil:answer:v1',
      });
    } catch (err) {
      predicted = `[llm-error] ${err instanceof Error ? err.message : String(err)}`;
    }

    return { predicted, retrieval_ms };
  };
}

async function main(): Promise<void> {
  setBenchEnv();
  const opts = parseArgs();

  const fixturePath =
    opts.fixturePath ?? resolve(process.cwd(), `fixtures/benchmark/security/frame-sybil/${opts.mode}.json`);
  if (!existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    console.error('Generate fixtures first via: npx tsx src/benchmark/security/generate-fixtures.ts');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as SecurityBenchFixture;
  if (fixture.name !== 'frame-sybil') {
    console.error(`Fixture name mismatch: expected frame-sybil, got ${fixture.name}`);
    process.exit(2);
  }

  const outputPath = resolve(process.cwd(), buildOutputPath('frame-sybil', opts.mode));
  console.log(`FRAME-SYBIL (${opts.mode}, ${fixture.queries.length} queries, seed=${opts.seed})`);
  console.log(`Routing: ${opts.routed ? 'on' : 'off'}, model: ${opts.answerModel}`);

  const report = await runSecurityBench({
    fixture,
    dispatchFn: buildDispatchFn(opts),
    routed: opts.routed,
    seed: opts.seed,
    answerModel: opts.answerModel,
    maxRules: opts.maxRules,
    outputPath,
  });

  console.log('');
  console.log(
    `Pass rate: ${(report.summary.passRate * 100).toFixed(1)}% (${report.summary.passed}/${report.summary.totalQuestions})`,
  );
  console.log(`Mean retrieval ms: ${report.summary.meanRetrievalMs.toFixed(1)}`);
  console.log('Per-attack-pattern:');
  for (const [pattern, stats] of Object.entries(report.summary.perPattern)) {
    console.log(`  ${pattern}: ${(stats.passRate * 100).toFixed(1)}% (${stats.passed}/${stats.total})`);
  }
  console.log(`\nReport: ${outputPath}`);
}

main().catch((err) => {
  console.error('FRAME-SYBIL runner failed:', err);
  process.exit(1);
});
