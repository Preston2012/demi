#!/usr/bin/env npx tsx
/**
 * Bench 2 (Cross-Session Temporal), runner.
 *
 * One persistent `:memory:` repo for the whole run (the bench's premise:
 * many sessions accumulate in a single user's memory). Each fact is
 * inserted via `dispatch.addMemory` with explicit `validFrom` so the
 * temporal ordering is preserved. Answer model: gpt-4.1-mini.
 *
 * TEST_MODE=true bypasses conflict-quarantine across the ~350 facts.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { generate, verifyFixturePairwise, type CSTQuestion, type Fact } from './generator.js';
import { judge } from './judge.js';
import { callLLM } from '../llm-caller.js';

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  'Answer the user using only the context. Be concise. If the question asks ' +
  'about timing or order, explicitly say "before" or "after". If you do not ' +
  'find a clear answer in context, say so plainly.';

interface CSTQuestionResult {
  qid: string;
  type: string;
  question: string;
  ref_session_idx: number;
  ref2_session_idx?: number;
  expected_order?: string;
  distinctive: string[];
  predicted_answer: string;
  correct: boolean;
  retrieved_ids: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface CSTSummary {
  totalQuestions: number;
  correct: number;
  accuracy: number;
  perType: Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }>;
}

interface CSTReport {
  benchmark: 'cross-session-temporal';
  timestamp: string;
  config: {
    mode: 'mini' | 'full';
    answerModel: string;
    seed: number;
    sessions: number;
    facts: number;
  };
  methodology: {
    note: string;
    metric: string;
    ceiling: number;
  };
  summary: CSTSummary;
  results: CSTQuestionResult[];
}

function summarize(results: CSTQuestionResult[]): CSTSummary {
  const perType: CSTSummary['perType'] = {};
  for (const r of results) {
    if (!perType[r.type]) perType[r.type] = { total: 0, correct: 0, accuracy: 0, meanRetrievalMs: 0 };
    const slot = perType[r.type]!;
    slot.total++;
    if (r.correct) slot.correct++;
    slot.meanRetrievalMs += r.retrieval_time_ms;
  }
  for (const k of Object.keys(perType)) {
    const v = perType[k]!;
    v.accuracy = v.total ? v.correct / v.total : 0;
    v.meanRetrievalMs = v.total ? v.meanRetrievalMs / v.total : 0;
  }
  const correct = results.filter((r) => r.correct).length;
  return {
    totalQuestions: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    perType,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const mode: 'mini' | 'full' = mini ? 'mini' : 'full';
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;

  // S68 v2: bench-env profile sets TEST_MODE/STONE/ROUTING/TEMPORAL/BI_TEMPORAL/DEDUP/CIRCUIT_BREAKER.
  // BENCH_SKIP_DEDUP=false now that fixtures are pairwise-distinct (bake.ts
  // enforces pairwise cosine < 0.92 against BGE-small; 0.03 margin vs engine
  // dedup at 0.95). Bench measures real production write+retrieval behavior.
  const { ensureBenchEnv } = await import('../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../lib/bench-telemetry.js');
  ensureBenchEnv('cross-session-temporal');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  // S47 fix: embedding model must be initialized so dispatch.search() can use the
  // vector path. Without this, retrieval falls back to lexical-only (FTS5), which
  // cannot bridge topic-meta-queries like 'about food' to facts that don't contain
  // the literal topic word. This was the root cause of the 10pct mini score in S46.
  // Mirrors the pattern in cold-warm and multi-hop-chain runners.
  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const fixture = generate(seed, mode);
  const allFacts: Fact[] = fixture.sessions.flatMap((s) => s.facts);
  console.log(
    `Bench 2: cross-session-temporal [${mode}] seed=${seed} → ${fixture.sessions.length} sessions, ${allFacts.length} facts, ${fixture.questions.length} questions`,
  );

  // S68 v2: runtime sanity probe. Re-verify pairwise cosine against current
  // BGE model. Catches model drift (someone bumped BGE but didn't re-bake).
  // Skip with BENCH_SKIP_FIXTURE_VERIFY=1 if needed for ad-hoc runs.
  if (process.env.BENCH_SKIP_FIXTURE_VERIFY !== '1') {
    const { encode, cosineSimilarity } = await import('../../embeddings/index.js');
    const verifyStart = performance.now();
    try {
      const v = await verifyFixturePairwise(fixture, encode, cosineSimilarity, 0.95);
      const verifyMs = performance.now() - verifyStart;
      console.log(`  Fixture verified: max pairwise cosine ${v.maxObserved.toFixed(4)} (${verifyMs.toFixed(0)}ms)`);
    } catch (err) {
      console.error('FATAL: fixture pairwise verify failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');

  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, config);

  // Seed all facts in chronological order.
  let seeded = 0;
  for (const f of allFacts) {
    try {
      const result = await dispatch.addMemory({
        claim: f.claim,
        subject: 'user',
        source: 'user',
        confidence: 0.95,
        validFrom: f.valid_from,
      });
      if (result.action !== 'rejected') seeded++;
    } catch (err) {
      console.error('SEED_ERROR:', err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`  Seeded: ${seeded}/${allFacts.length} facts`);

  const results: CSTQuestionResult[] = [];
  for (let i = 0; i < fixture.questions.length; i++) {
    const q: CSTQuestion = fixture.questions[i]!;
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 100, 0, {
        cacheKey: 'demiurge:cross-session-temporal:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
    const totalMs = performance.now() - totalStart;
    const judgement = judge(q, predicted);

    const result: CSTQuestionResult = {
      qid: q.qid,
      type: q.type,
      question: q.question,
      ref_session_idx: q.ref_session_idx,
      distinctive: q.distinctive,
      predicted_answer: predicted,
      correct: judgement.correct,
      retrieved_ids: searchResult.raw.candidates.map((c) => c.id),
      memories_injected: searchResult.raw.candidates.length,
      retrieval_time_ms: retrievalMs,
      total_time_ms: totalMs,
    };
    if (q.ref2_session_idx !== undefined) result.ref2_session_idx = q.ref2_session_idx;
    if (q.expected_order) result.expected_order = q.expected_order;
    results.push(result);

    if ((i + 1) % 10 === 0 || i === fixture.questions.length - 1) {
      const pct = ((results.filter((x) => x.correct).length / results.length) * 100).toFixed(1);
      console.log(`  [${i + 1}/${fixture.questions.length}] ${pct}% correct so far`);
    }
  }

  await repo.close();

  const summary = summarize(results);
  const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const report: CSTReport = {
    benchmark: 'cross-session-temporal',
    timestamp: new Date().toISOString(),
    config: {
      mode,
      answerModel: ANSWER_MODEL,
      seed,
      sessions: fixture.sessions.length,
      facts: allFacts.length,
    },
    methodology: {
      note:
        'Cross-session temporal recall. Single persistent :memory: repo. Facts seeded ' +
        'via dispatch.addMemory with explicit validFrom. TEST_MODE bypasses ' +
        'conflict-quarantine. Deterministic judge.',
      metric: '≥3 distinctive nouns for recall; literal "before"/"after" for order',
      ceiling: 1.0,
    },
    summary,
    results,
  };

  const path = resolve(outputDir, `cross-session-temporal-${isoSafe}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);

  console.log('\n=== Final scores ===');
  console.log(`  Overall: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.totalQuestions})`);
  for (const t of ['recent', 'mid', 'distant', 'time-anchored', 'order-aware']) {
    const v = summary.perType[t];
    if (!v) continue;
    console.log(
      `  ${t.padEnd(15)}: ${(v.accuracy * 100).toFixed(1).padStart(5)}% (${v.correct}/${v.total}, mean ret ${v.meanRetrievalMs.toFixed(1)}ms)`,
    );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { summarize };
