#!/usr/bin/env npx tsx
/**
 * Bench 3 (Multi-Hop Chain), runner.
 *
 * Per scenario: fresh `:memory:` repo, embeddings init (multi-hop needs
 * semantic recall to find indirect-link facts that share few keywords).
 * Each fact inserted via `dispatch.addMemory`. Answer model: gpt-4.1-mini.
 * Two scores: LLM-judge correctness (gpt-4o-mini) + deterministic
 * evidence-chain coverage.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callLLM } from '../llm-caller.js';
import { FixtureSchema, type Scenario } from './schema.js';
import { judgeAnswer, evidenceCoverage, type EvidenceMap } from './judge.js';

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  'Answer the question by chaining facts from the context. Be concise (1 short sentence). ' +
  'If multiple facts are needed, combine them. Do not invent facts not in the context.';

interface MultiHopQuestionResult {
  qid: string;
  scenario_id: string;
  type: '2-hop' | '3-hop';
  question: string;
  expected_answer: string;
  predicted_answer: string;
  correct: boolean;
  evidence_chain: string[];
  evidence_coverage: number;
  retrieved_ids: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface MultiHopSummary {
  totalQuestions: number;
  correct: number;
  accuracy: number;
  by2Hop: { total: number; correct: number; accuracy: number };
  by3Hop: { total: number; correct: number; accuracy: number };
  meanEvidenceCoverage: number;
  hallucinationRate: number;
  meanRetrievalMs: number;
}

interface MultiHopReport {
  benchmark: 'multi-hop-chain';
  timestamp: string;
  config: {
    mode: 'mini' | 'full';
    answerModel: string;
    judgeModel: string;
    scenarios: number;
  };
  methodology: {
    note: string;
    metric: string;
    ceiling: number;
  };
  summary: MultiHopSummary;
  results: MultiHopQuestionResult[];
}

function summarize(results: MultiHopQuestionResult[]): MultiHopSummary {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const two = results.filter((r) => r.type === '2-hop');
  const three = results.filter((r) => r.type === '3-hop');
  const c2 = two.filter((r) => r.correct).length;
  const c3 = three.filter((r) => r.correct).length;
  const meanCov = total ? results.reduce((a, b) => a + b.evidence_coverage, 0) / total : 0;
  const correctResults = results.filter((r) => r.correct);
  const hallucinations = correctResults.filter((r) => r.evidence_coverage < 1).length;
  const halluRate = correctResults.length ? hallucinations / correctResults.length : 0;
  const meanRet = total ? results.reduce((a, b) => a + b.retrieval_time_ms, 0) / total : 0;
  return {
    totalQuestions: total,
    correct,
    accuracy: total ? correct / total : 0,
    by2Hop: { total: two.length, correct: c2, accuracy: two.length ? c2 / two.length : 0 },
    by3Hop: { total: three.length, correct: c3, accuracy: three.length ? c3 / three.length : 0 },
    meanEvidenceCoverage: meanCov,
    hallucinationRate: halluRate,
    meanRetrievalMs: meanRet,
  };
}

async function runScenario(scenario: Scenario, config: Record<string, unknown>): Promise<MultiHopQuestionResult[]> {
  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' } as any);
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch = createCoreDispatch(repo as any, config as any);

  const factIdToRecordId: EvidenceMap = new Map();
  for (const f of scenario.facts) {
    try {
      const result = await dispatch.addMemory({
        claim: f.text,
        subject: f.entities[0] ?? scenario.scenario_id,
        source: 'user',
        confidence: 0.95,
      });
      factIdToRecordId.set(f.fact_id, result.id);
    } catch (err) {
      console.error('SEED_ERROR:', err instanceof Error ? err.message : String(err));
    }
  }

  const out: MultiHopQuestionResult[] = [];
  for (const q of scenario.questions) {
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 80, 0, {
        cacheKey: 'demiurge:multi-hop:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
    const totalMs = performance.now() - totalStart;

    const retrievedIds = searchResult.raw.candidates.map((c) => c.id);
    const cov = evidenceCoverage(q, retrievedIds, factIdToRecordId);
    let correct: boolean;
    try {
      correct = await judgeAnswer(q, predicted);
    } catch {
      correct = false;
    }

    out.push({
      qid: q.question_id,
      scenario_id: scenario.scenario_id,
      type: q.type,
      question: q.question,
      expected_answer: q.answer,
      predicted_answer: predicted,
      correct,
      evidence_chain: q.evidence_chain,
      evidence_coverage: cov,
      retrieved_ids: retrievedIds,
      memories_injected: retrievedIds.length,
      retrieval_time_ms: retrievalMs,
      total_time_ms: totalMs,
    });
  }

  await repo.close();
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const mode: 'mini' | 'full' = mini ? 'mini' : 'full';
  const fixtureArg = args.indexOf('--fixture');
  const fixturePath =
    fixtureArg !== -1 ? resolve(args[fixtureArg + 1]!) : resolve(__dirname, 'fixtures/scenarios.json');

  // S68: bench-env profile sets TEST_MODE/STONE/ROUTING/TEMPORAL/BI_TEMPORAL/DEDUP/CIRCUIT_BREAKER.
  const { ensureBenchEnv } = await import('../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../lib/bench-telemetry.js');
  ensureBenchEnv('multi-hop-chain');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  // Embeddings: try to init for semantic recall. Soft-fail if model missing
  // (lexical-only retrieval still works, just may miss some indirect links).
  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('FIXTURE INVALID:', parsed.error.issues);
    process.exit(1);
  }
  const allScenarios = parsed.data.scenarios;
  const scenariosToRun = mode === 'mini' ? allScenarios.slice(0, 15) : allScenarios.slice(0, 60);
  console.log(`Bench 3: multi-hop-chain [${mode}] → ${scenariosToRun.length} scenarios from ${fixturePath}`);

  const allResults: MultiHopQuestionResult[] = [];
  for (let i = 0; i < scenariosToRun.length; i++) {
    const sc = scenariosToRun[i]!;
    const r = await runScenario(sc, config as unknown as Record<string, unknown>);
    allResults.push(...r);
    if ((i + 1) % 5 === 0 || i === scenariosToRun.length - 1) {
      const pct = ((allResults.filter((x) => x.correct).length / allResults.length) * 100).toFixed(1);
      console.log(`  [${i + 1}/${scenariosToRun.length}] ${allResults.length} Qs, ${pct}% correct`);
    }
  }

  const summary = summarize(allResults);
  const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const report: MultiHopReport = {
    benchmark: 'multi-hop-chain',
    timestamp: new Date().toISOString(),
    config: {
      mode,
      answerModel: ANSWER_MODEL,
      judgeModel: 'gpt-4o-mini',
      scenarios: scenariosToRun.length,
    },
    methodology: {
      note:
        'Multi-hop entity-chain reasoning. Fresh :memory: repo per scenario, embeddings ' +
        'init for semantic recall. LLM-as-judge (gpt-4o-mini) for answer correctness, ' +
        'deterministic evidence-chain coverage decoupled.',
      metric: 'LLM judge 0/1 + evidence coverage |retrieved ∩ chain| / |chain|',
      ceiling: 1.0,
    },
    summary,
    results: allResults,
  };

  const path = resolve(outputDir, `multi-hop-chain-${isoSafe}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);

  console.log('\n=== Final scores ===');
  console.log(
    `  Overall:        ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.totalQuestions})`,
  );
  console.log(
    `  2-hop:          ${(summary.by2Hop.accuracy * 100).toFixed(1)}% (${summary.by2Hop.correct}/${summary.by2Hop.total})`,
  );
  console.log(
    `  3-hop:          ${(summary.by3Hop.accuracy * 100).toFixed(1)}% (${summary.by3Hop.correct}/${summary.by3Hop.total})`,
  );
  console.log(`  Mean coverage:  ${(summary.meanEvidenceCoverage * 100).toFixed(1)}%`);
  console.log(
    `  Halluc. rate:   ${(summary.hallucinationRate * 100).toFixed(1)}% (correct answers w/ partial evidence)`,
  );
  console.log(`  Mean ret ms:    ${summary.meanRetrievalMs.toFixed(1)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runScenario, summarize };
