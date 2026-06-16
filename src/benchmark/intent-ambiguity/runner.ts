#!/usr/bin/env npx tsx
/**
 * Bench 6 (Intent Inference Under Ambiguity), runner.
 *
 * Per scenario: fresh `:memory:` repo. All facts inserted via
 * dispatch.addMemory(source='user'). Embeddings init for semantic recall
 * (ambiguity sometimes hinges on contextual closeness rather than literal
 * keyword match).
 *
 * LLM judge (gpt-4o-mini) returns 1.0 / 0.5 / 0.0. Disambiguation rate is
 * deterministic and decoupled from the judge.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callLLM } from '../llm-caller.js';
import { FixtureSchema, type Scenario, type Fact } from './schema.js';
import { judgeAnswer, disambiguationRate } from './judge.js';

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  'Answer the question using the context. The question may be ambiguous; pick ' +
  'the interpretation that fits the context best. Be concise (1 sentence).';

interface IntentQuestionResult {
  qid: string;
  scenario_id: string;
  ambiguity_type: string;
  question: string;
  preferred_entity: string;
  preferred_answer: string;
  incorrect_entity: string;
  predicted_answer: string;
  /** Judge score: 1 / 0.5 / 0. */
  score: number;
  disambiguation_rate: number;
  preferred_retrieved: boolean;
  retrieved_ids: string[];
  retrieved_about: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface IntentSummary {
  totalQuestions: number;
  /** Mean of judge scores (range 0..1, with 0.5 for partial credit). */
  meanScore: number;
  /** % of questions scored 1.0. */
  exactCorrect: number;
  /** % of questions scored ≥0.5. */
  partialOrBetter: number;
  perAmbiguityType: Record<string, { total: number; meanScore: number; meanDisambig: number }>;
  meanDisambiguationRate: number;
  /** % of wrong answers (score=0) where preferred entity facts WERE retrieved (model failed to use them). */
  confusionRate: number;
  meanRetrievalMs: number;
}

interface IntentReport {
  benchmark: 'intent-ambiguity';
  timestamp: string;
  config: { mode: 'mini' | 'full'; answerModel: string; judgeModel: string; scenarios: number };
  methodology: { note: string; metric: string; ceiling: number };
  summary: IntentSummary;
  results: IntentQuestionResult[];
}

function summarize(results: IntentQuestionResult[]): IntentSummary {
  const total = results.length;
  const meanScore = total ? results.reduce((a, b) => a + b.score, 0) / total : 0;
  const exact = total ? results.filter((r) => r.score === 1).length / total : 0;
  const partial = total ? results.filter((r) => r.score >= 0.5).length / total : 0;
  const meanDisambig = total ? results.reduce((a, b) => a + b.disambiguation_rate, 0) / total : 0;
  const meanRet = total ? results.reduce((a, b) => a + b.retrieval_time_ms, 0) / total : 0;

  const perAmb: IntentSummary['perAmbiguityType'] = {};
  for (const r of results) {
    if (!perAmb[r.ambiguity_type]) perAmb[r.ambiguity_type] = { total: 0, meanScore: 0, meanDisambig: 0 };
    const v = perAmb[r.ambiguity_type]!;
    v.total++;
    v.meanScore += r.score;
    v.meanDisambig += r.disambiguation_rate;
  }
  for (const v of Object.values(perAmb)) {
    if (v.total) {
      v.meanScore /= v.total;
      v.meanDisambig /= v.total;
    }
  }

  // Confusion: model got 0 but preferred entity facts WERE retrieved.
  const wrong = results.filter((r) => r.score === 0);
  const confused = wrong.filter((r) => r.preferred_retrieved).length;
  const confusionRate = wrong.length ? confused / wrong.length : 0;

  return {
    totalQuestions: total,
    meanScore,
    exactCorrect: exact,
    partialOrBetter: partial,
    perAmbiguityType: perAmb,
    meanDisambiguationRate: meanDisambig,
    confusionRate,
    meanRetrievalMs: meanRet,
  };
}

async function runScenario(scenario: Scenario, config: Record<string, unknown>): Promise<IntentQuestionResult[]> {
  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = { ...config, dbPath: ':memory:' } as any;
  const repo = new SqliteMemoryRepository(cfg);
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, cfg);

  const factsByRecordId = new Map<string, Fact>();
  for (const fact of scenario.facts) {
    try {
      const result = await dispatch.addMemory({
        claim: fact.text,
        subject: fact.about_entity,
        source: 'user',
        confidence: 0.95,
      });
      if (result.action !== 'rejected') factsByRecordId.set(result.id, fact);
    } catch (err) {
      console.error('SEED_ERROR:', err instanceof Error ? err.message : String(err));
    }
  }

  const out: IntentQuestionResult[] = [];
  for (const q of scenario.questions) {
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 80, 0, {
        cacheKey: 'demiurge:intent-ambig:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
    const totalMs = performance.now() - totalStart;

    const retrievedIds = searchResult.raw.candidates.map((c) => c.id);
    const retrievedAbout = retrievedIds
      .map((id) => factsByRecordId.get(id)?.about_entity)
      .filter((x): x is string => x !== undefined);
    const disambig = disambiguationRate(q, retrievedIds, factsByRecordId);

    let score: number;
    try {
      score = await judgeAnswer(q, predicted);
    } catch {
      score = 0;
    }

    out.push({
      qid: q.question_id,
      scenario_id: scenario.scenario_id,
      ambiguity_type: q.ambiguity_type,
      question: q.question,
      preferred_entity: q.preferred_interpretation.entity,
      preferred_answer: q.preferred_interpretation.answer,
      incorrect_entity: q.incorrect_interpretation.entity,
      predicted_answer: predicted,
      score,
      disambiguation_rate: disambig.rate,
      preferred_retrieved: disambig.preferredRetrieved,
      retrieved_ids: retrievedIds,
      retrieved_about: retrievedAbout,
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
  ensureBenchEnv('intent-ambiguity');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  // Embeddings init (soft-fail on missing model).
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
  const scenariosToRun = mode === 'mini' ? allScenarios.slice(0, 12) : allScenarios.slice(0, 50);
  console.log(`Bench 6: intent-ambiguity [${mode}] → ${scenariosToRun.length} scenarios from ${fixturePath}`);

  const allResults: IntentQuestionResult[] = [];
  for (let i = 0; i < scenariosToRun.length; i++) {
    const sc = scenariosToRun[i]!;
    const r = await runScenario(sc, config as unknown as Record<string, unknown>);
    allResults.push(...r);
    if ((i + 1) % 4 === 0 || i === scenariosToRun.length - 1) {
      const meanSoFar = (allResults.reduce((a, b) => a + b.score, 0) / allResults.length) * 100;
      console.log(`  [${i + 1}/${scenariosToRun.length}] ${allResults.length} Qs, mean score ${meanSoFar.toFixed(1)}%`);
    }
  }

  const summary = summarize(allResults);
  const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const report: IntentReport = {
    benchmark: 'intent-ambiguity',
    timestamp: new Date().toISOString(),
    config: { mode, answerModel: ANSWER_MODEL, judgeModel: 'gpt-4o-mini', scenarios: scenariosToRun.length },
    methodology: {
      note:
        'Intent inference under ambiguity. Fresh :memory: repo per scenario; embeddings ' +
        'init for semantic recall. LLM judge (gpt-4o-mini) gives 3-way score: 1.0 ' +
        '(preferred), 0.5 (incorrect interpretation but plausible), 0 (wrong).',
      metric: 'mean LLM judge score + deterministic disambiguation rate (decoupled)',
      ceiling: 1.0,
    },
    summary,
    results: allResults,
  };

  const path = resolve(outputDir, `intent-ambiguity-${isoSafe}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);

  console.log('\n=== Final scores ===');
  console.log(
    `  Mean score:         ${(summary.meanScore * 100).toFixed(1)}% (1.0=preferred, 0.5=incorrect-but-plausible)`,
  );
  console.log(`  Exact correct:      ${(summary.exactCorrect * 100).toFixed(1)}%`);
  console.log(`  Partial or better:  ${(summary.partialOrBetter * 100).toFixed(1)}%`);
  for (const [t, v] of Object.entries(summary.perAmbiguityType)) {
    console.log(
      `  ${t.padEnd(20)}: score ${(v.meanScore * 100).toFixed(1)}% (n=${v.total}, disambig ${(v.meanDisambig * 100).toFixed(1)}%)`,
    );
  }
  console.log(
    `  Disambig rate:      ${(summary.meanDisambiguationRate * 100).toFixed(1)}% (preferred-entity facts in retrieved set)`,
  );
  console.log(
    `  Confusion rate:     ${(summary.confusionRate * 100).toFixed(1)}% (wrong answers w/ preferred facts available)`,
  );
  console.log(`  Mean retrieval ms:  ${summary.meanRetrievalMs.toFixed(1)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runScenario, summarize };
