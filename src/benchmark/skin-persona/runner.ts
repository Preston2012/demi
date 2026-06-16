#!/usr/bin/env npx tsx
/**
 * Bench 4 (Skin Persona Consistency), runner.
 *
 * Per persona-trace: fresh `:memory:` repo, insert all persona facts via
 * `dispatch.addMemory({source: 'user', ...})`, then run the trace's questions.
 * TEST_MODE=true bypasses validators so all facts land regardless of mild
 * conflicts. Answer model: gpt-4.1-mini.
 *
 * Reports persona-leak rate (orthogonal Qs that mention persona keyword) and
 * exclusion-violation rate (relevant Qs that mention forbidden item).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { generate, type SkinPersonaTrace } from './generator.js';
import { judge } from './judge.js';
import { callLLM } from '../llm-caller.js';

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  "You are answering for a specific user. Use the context to respect the user's " +
  'preferences and constraints. Be concise (1-3 sentences). If the context is ' +
  'irrelevant to the question, answer the question without referencing it.';

interface SkinPersonaQuestionResult {
  qid: string;
  trace_id: string;
  persona: string;
  type: string;
  question: string;
  expected_keywords: string[];
  expected_excludes: string[];
  persona_keywords: string[];
  predicted_answer: string;
  correct: boolean;
  persona_leak: boolean;
  exclusion_violation: boolean;
  /** Did the retrieval surface at least one of the persona constraint claims? */
  persona_injected: boolean;
  retrieved_ids: string[];
  retrieved_claims: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface SkinPersonaSummary {
  totalQuestions: number;
  correct: number;
  accuracy: number;
  perType: Record<string, { total: number; correct: number; accuracy: number }>;
  perPersona: Record<string, { total: number; correct: number; accuracy: number }>;
  /** % of unrelated-control answers that leaked persona keyword. */
  personaLeakRate: number;
  /** % of relevant answers that mentioned a forbidden item. */
  exclusionViolationRate: number;
  /** % of relevant questions where retrieval surfaced ≥1 persona constraint claim. */
  personaInjectionRate: number;
  meanRetrievalMs: number;
}

interface SkinPersonaReport {
  benchmark: 'skin-persona';
  timestamp: string;
  config: { mode: 'mini' | 'full'; answerModel: string; seed: number };
  methodology: { note: string; metric: string; ceiling: number };
  summary: SkinPersonaSummary;
  results: SkinPersonaQuestionResult[];
}

function summarize(results: SkinPersonaQuestionResult[]): SkinPersonaSummary {
  const perType: SkinPersonaSummary['perType'] = {};
  const perPersona: SkinPersonaSummary['perPersona'] = {};
  for (const r of results) {
    if (!perType[r.type]) perType[r.type] = { total: 0, correct: 0, accuracy: 0 };
    perType[r.type]!.total++;
    if (r.correct) perType[r.type]!.correct++;
    if (!perPersona[r.persona]) perPersona[r.persona] = { total: 0, correct: 0, accuracy: 0 };
    perPersona[r.persona]!.total++;
    if (r.correct) perPersona[r.persona]!.correct++;
  }
  for (const v of Object.values(perType)) v.accuracy = v.total ? v.correct / v.total : 0;
  for (const v of Object.values(perPersona)) v.accuracy = v.total ? v.correct / v.total : 0;

  const unrelated = results.filter((r) => r.type === 'unrelated-control');
  const relevant = results.filter((r) => r.type !== 'unrelated-control');
  const personaLeakRate = unrelated.length ? unrelated.filter((r) => r.persona_leak).length / unrelated.length : 0;
  const exclusionRate = relevant.length ? relevant.filter((r) => r.exclusion_violation).length / relevant.length : 0;
  const injectionRate = relevant.length ? relevant.filter((r) => r.persona_injected).length / relevant.length : 0;
  const meanRet = results.length ? results.reduce((a, b) => a + b.retrieval_time_ms, 0) / results.length : 0;

  const correct = results.filter((r) => r.correct).length;
  return {
    totalQuestions: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    perType,
    perPersona,
    personaLeakRate,
    exclusionViolationRate: exclusionRate,
    personaInjectionRate: injectionRate,
    meanRetrievalMs: meanRet,
  };
}

async function runOneTrace(
  trace: SkinPersonaTrace,
  config: Record<string, unknown>,
  /** Constraint claims (subset of trace.facts) used for "persona_injected" check. */
  constraintFactCount: number,
): Promise<SkinPersonaQuestionResult[]> {
  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = { ...config, dbPath: ':memory:' } as any;
  const repo = new SqliteMemoryRepository(cfg);
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, cfg);

  // Track which inserted records are constraint claims (first N facts).
  // Packet C3 / Bug 3: constraint facts are written with persona=true so the
  // retrieval-time persona boost (PERSONA_BOOST_ENABLED) surfaces them on
  // adjacent and orthogonal queries. Bench owns the flag explicitly rather
  // than relying on auto-detect, so it isolates the boost test from the
  // detector's correctness.
  const constraintRecordIds = new Set<string>();
  for (let i = 0; i < trace.facts.length; i++) {
    const claim = trace.facts[i]!;
    const isConstraint = i < constraintFactCount;
    try {
      const result = await dispatch.addMemory({
        claim,
        subject: 'user',
        source: 'user',
        confidence: 0.95,
        persona: isConstraint,
      });
      if (isConstraint && result.action !== 'rejected') {
        constraintRecordIds.add(result.id);
      }
    } catch (err) {
      console.error('SEED_ERROR:', err instanceof Error ? err.message : String(err));
    }
  }

  const out: SkinPersonaQuestionResult[] = [];
  for (const q of trace.questions) {
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 100, 0, {
        cacheKey: 'demiurge:skin-persona:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
    const totalMs = performance.now() - totalStart;
    const judgement = judge(q, predicted);

    const retrievedIds = searchResult.raw.candidates.map((c) => c.id);
    const retrievedClaims = searchResult.raw.candidates.map((c) => c.candidate.record.claim);
    const personaInjected = q.type !== 'unrelated-control' && retrievedIds.some((id) => constraintRecordIds.has(id));

    out.push({
      qid: q.qid,
      trace_id: trace.trace_id,
      persona: trace.persona,
      type: q.type,
      question: q.question,
      expected_keywords: q.expected_keywords,
      expected_excludes: q.expected_excludes,
      persona_keywords: q.persona_keywords,
      predicted_answer: predicted,
      correct: judgement.correct,
      persona_leak: judgement.personaLeak,
      exclusion_violation: judgement.exclusionViolation,
      persona_injected: personaInjected,
      retrieved_ids: retrievedIds,
      retrieved_claims: retrievedClaims,
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
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;

  // S68: bench-env profile sets TEST_MODE/STONE/ROUTING/TEMPORAL/BI_TEMPORAL/DEDUP/CIRCUIT_BREAKER.
  // PERSONA_BOOST_ENABLED is a feature flag (not in profile) and stays inline below.
  const { ensureBenchEnv } = await import('../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../lib/bench-telemetry.js');
  ensureBenchEnv('skin-persona');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  // Packet C3 / Bug 3: enable the persona boost so persona facts surface on
  // adjacent / orthogonal queries. Bench 4 measures retrieval consistency, so
  // the boost is part of what's being measured here.
  process.env.PERSONA_BOOST_ENABLED = process.env.PERSONA_BOOST_ENABLED || 'true';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  // S47 fix: embedding model init for the same reason as cross-session-temporal -
  // dispatch.search() vector path needs it, otherwise retrieval is lexical-only.
  // Skin-persona happens to work without it because its questions hit literal
  // entity overlap, but any topic-anchored question would have failed silently.
  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const fixture = generate(seed, mode);
  console.log(
    `Bench 4: skin-persona [${mode}] seed=${seed} → ${fixture.traces.length} traces, ${fixture.traces.reduce(
      (a, b) => a + b.questions.length,
      0,
    )} questions`,
  );

  // Constraint facts are the first N of trace.facts; the count is fixed by the
  // generator. For all current personas it's 3.
  const CONSTRAINT_FACT_COUNT = 3;

  const allResults: SkinPersonaQuestionResult[] = [];
  for (let i = 0; i < fixture.traces.length; i++) {
    const t = fixture.traces[i]!;
    const r = await runOneTrace(t, config as unknown as Record<string, unknown>, CONSTRAINT_FACT_COUNT);
    allResults.push(...r);
    if ((i + 1) % 2 === 0 || i === fixture.traces.length - 1) {
      const pct = ((allResults.filter((x) => x.correct).length / allResults.length) * 100).toFixed(1);
      console.log(`  [${i + 1}/${fixture.traces.length}] ${allResults.length} Qs, ${pct}% correct so far`);
    }
  }

  const summary = summarize(allResults);
  const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const report: SkinPersonaReport = {
    benchmark: 'skin-persona',
    timestamp: new Date().toISOString(),
    config: { mode, answerModel: ANSWER_MODEL, seed },
    methodology: {
      note:
        'Persona consistency. Fresh :memory: repo per trace. Persona constraint + ' +
        'neutral facts inserted via dispatch.addMemory(source=user). Three Q types: ' +
        'direct-relevant, adjacent-relevant, unrelated-control. Deterministic judge.',
      metric: 'keyword inclusion + exclusion (relevant); persona keyword absence (control)',
      ceiling: 1.0,
    },
    summary,
    results: allResults,
  };

  const path = resolve(outputDir, `skin-persona-${isoSafe}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);

  console.log('\n=== Final scores ===');
  console.log(
    `  Overall:               ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.totalQuestions})`,
  );
  for (const t of ['direct-relevant', 'adjacent-relevant', 'unrelated-control']) {
    const v = summary.perType[t];
    if (!v) continue;
    console.log(`  ${t.padEnd(20)}: ${(v.accuracy * 100).toFixed(1).padStart(5)}% (${v.correct}/${v.total})`);
  }
  console.log(`  Persona-leak rate:     ${(summary.personaLeakRate * 100).toFixed(1)}%`);
  console.log(`  Exclusion violation:   ${(summary.exclusionViolationRate * 100).toFixed(1)}%`);
  console.log(
    `  Persona-injection:     ${(summary.personaInjectionRate * 100).toFixed(1)}% (relevant Qs w/ ≥1 constraint fact retrieved)`,
  );
  console.log(`  Mean retrieval ms:     ${summary.meanRetrievalMs.toFixed(1)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runOneTrace, summarize };
