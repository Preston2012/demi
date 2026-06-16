#!/usr/bin/env npx tsx
/**
 * Bench 1 (Correction Propagation), runner.
 *
 * Per trace: fresh `:memory:` SqliteMemoryRepository. Hand-builds two
 * MemoryRecord objects via repo.insert (the public addMemory API can't set
 * `supersedes` directly), then runs `dispatch.search` + `gpt-4.1-mini` for
 * each question and scores deterministically.
 *
 * Runs in BOTH `biTemporalEnabled=true` and `=false` modes; writes one JSON
 * report per mode. The dual-mode comparison is the bench's primary finding -
 * it surfaces whether the bi-temporal read filter satisfies the
 * "correction propagation" claim.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { v4 as uuid } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { generate, type Trace, type TraceQuestion } from './generator.js';
import { judge, type JudgeResult } from './judge.js';
import { callLLM } from '../llm-caller.js';
import {
  type MemoryRecord,
  Provenance,
  TrustClass,
  ReviewStatus,
  Scope,
  PermanenceStatus,
  ResolutionLevel,
  MemoryType,
  StorageTier,
  InterferenceStatus,
} from '../../schema/memory.js';

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  'Answer the question using only the context. Be concise (1-2 sentences). ' +
  'If the answer requires the most recent fact, use the most recent. If it asks about ' +
  'history or a previous state, mention the prior value.';

function computeSourceHashSync(claim: string): string {
  // Cheap deterministic hash (not crypto-strict; benches don't need it).
  let h = 0;
  for (let i = 0; i < claim.length; i++) h = (h * 31 + claim.charCodeAt(i)) | 0;
  return `bench-${(h >>> 0).toString(16)}-${claim.length}`;
}

interface BuildOpts {
  claim: string;
  subject: string;
  validFrom: string;
  supersedes?: string;
  embedding?: number[] | null;
}

function buildSyntheticRecord(opts: BuildOpts): MemoryRecord {
  return {
    id: uuid(),
    userId: 'system',
    externalRef: null,
    claim: opts.claim,
    subject: opts.subject,
    scope: Scope.GLOBAL,
    validFrom: opts.validFrom,
    validTo: null,
    provenance: Provenance.USER_CONFIRMED,
    trustClass: TrustClass.CONFIRMED,
    confidence: 0.95,
    sourceHash: computeSourceHashSync(opts.claim),
    supersedes: opts.supersedes ?? null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: opts.validFrom,
    createdAt: opts.validFrom,
    updatedAt: opts.validFrom,
    embedding: opts.embedding ?? null,
    permanenceStatus: PermanenceStatus.PROVISIONAL,
    hubId: null,
    hubScore: 0,
    resolution: ResolutionLevel.SPECIFIC,
    memoryType: MemoryType.DECLARATIVE,
    versionNumber: 1,
    parentVersionId: null,
    frozenAt: null,
    decayScore: 1,
    storageTier: StorageTier.ACTIVE,
    isInhibitory: false,
    inhibitionTarget: null,
    interferenceStatus: InterferenceStatus.ACTIVE,
    correctionCount: 0,
    isFrozen: false,
    causedBy: null,
    leadsTo: null,
    canonicalFactId: null,
    isCanonical: true,
    validAt: opts.validFrom,
    invalidAt: null,
    persona: false,
  };
}

interface QuestionResult {
  qid: string;
  trace_id: string;
  template: string;
  type: string;
  question: string;
  expected_keywords: string[];
  expected_excludes: string[];
  predicted_answer: string;
  correct: boolean;
  phantom: boolean;
  retrieved_ids: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface RunSummary {
  totalQuestions: number;
  correct: number;
  accuracy: number;
  perType: Record<string, { total: number; correct: number; accuracy: number }>;
  perTemplate: Record<string, { total: number; correct: number; accuracy: number }>;
  phantomRate: number;
  meanRetrievalMs: number;
  p95RetrievalMs: number;
  meanTotalMs: number;
}

interface ModeReport {
  benchmark: 'correction-propagation';
  timestamp: string;
  config: {
    mode: 'mini' | 'full';
    biTemporalEnabled: boolean;
    answerModel: string;
    seed: number;
  };
  methodology: {
    note: string;
    metric: string;
    ceiling: number;
  };
  summary: RunSummary;
  results: QuestionResult[];
}

function summarize(results: QuestionResult[]): RunSummary {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const perType: Record<string, { total: number; correct: number; accuracy: number }> = {};
  const perTemplate: Record<string, { total: number; correct: number; accuracy: number }> = {};

  for (const r of results) {
    if (!perType[r.type]) perType[r.type] = { total: 0, correct: 0, accuracy: 0 };
    perType[r.type]!.total++;
    if (r.correct) perType[r.type]!.correct++;

    if (!perTemplate[r.template]) perTemplate[r.template] = { total: 0, correct: 0, accuracy: 0 };
    perTemplate[r.template]!.total++;
    if (r.correct) perTemplate[r.template]!.correct++;
  }

  for (const k of Object.keys(perType)) {
    const v = perType[k]!;
    v.accuracy = v.total ? v.correct / v.total : 0;
  }
  for (const k of Object.keys(perTemplate)) {
    const v = perTemplate[k]!;
    v.accuracy = v.total ? v.correct / v.total : 0;
  }

  const currentResults = results.filter((r) => r.type === 'current');
  const phantomRate = currentResults.length
    ? currentResults.filter((r) => r.phantom).length / currentResults.length
    : 0;

  const retrievalLatencies = results.map((r) => r.retrieval_time_ms).sort((a, b) => a - b);
  const meanRet = retrievalLatencies.length
    ? retrievalLatencies.reduce((a, b) => a + b, 0) / retrievalLatencies.length
    : 0;
  const p95Idx = Math.floor(retrievalLatencies.length * 0.95);
  const p95Ret = retrievalLatencies[Math.min(p95Idx, retrievalLatencies.length - 1)] ?? 0;
  const meanTot = results.length ? results.reduce((a, b) => a + b.total_time_ms, 0) / results.length : 0;

  return {
    totalQuestions: total,
    correct,
    accuracy: total ? correct / total : 0,
    perType,
    perTemplate,
    phantomRate,
    meanRetrievalMs: meanRet,
    p95RetrievalMs: p95Ret,
    meanTotalMs: meanTot,
  };
}

async function runOneTrace(
  trace: Trace,
  configBase: Record<string, unknown>,
  biTemporalEnabled: boolean,
): Promise<QuestionResult[]> {
  // Per-trace fresh in-memory repo.
  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');
  const { encode, isInitialized: embedReady } = await import('../../embeddings/index.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = { ...configBase, dbPath: ':memory:', biTemporalEnabled } as any;
  const repo = new SqliteMemoryRepository(cfg);
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());

  const dispatch = createCoreDispatch(repo, cfg);

  // Insert fact 1, then fact 2 with supersedes pointing to fact 1.
  const recordsByFactId = new Map<string, string>();
  for (const fact of trace.facts) {
    const supersedesUuid = fact.supersedes_id ? (recordsByFactId.get(fact.supersedes_id) ?? null) : null;
    const embedding = embedReady() ? await encode(fact.claim) : null;
    const rec = buildSyntheticRecord({
      claim: fact.claim,
      subject: trace.subject,
      validFrom: fact.valid_from,
      supersedes: supersedesUuid ?? undefined,
      embedding,
    });
    await repo.insert(rec);
    recordsByFactId.set(fact.fact_id, rec.id);

    // When fact 2 supersedes fact 1, mark fact 1 invalid_at = fact 2's valid_from.
    // This mirrors the bi-temporal supersession block in src/write/index.ts:286-302.
    if (supersedesUuid && biTemporalEnabled) {
      await repo.update(supersedesUuid, { invalidAt: fact.valid_from });
    }
  }

  const results: QuestionResult[] = [];
  for (const q of trace.questions) {
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 100, 0, {
        cacheKey: 'demiurge:correction-prop:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }

    const totalMs = performance.now() - totalStart;
    const judgement: JudgeResult = judge(q as TraceQuestion, predicted);

    results.push({
      qid: q.qid,
      trace_id: trace.trace_id,
      template: trace.template,
      type: q.type,
      question: q.question,
      expected_keywords: q.expected_keywords,
      expected_excludes: q.expected_excludes,
      predicted_answer: predicted,
      correct: judgement.correct,
      phantom: judgement.phantom,
      retrieved_ids: searchResult.raw.candidates.map((c) => c.id),
      memories_injected: searchResult.raw.candidates.length,
      retrieval_time_ms: retrievalMs,
      total_time_ms: totalMs,
    });
  }

  await repo.close();
  return results;
}

async function runMode(
  traces: Trace[],
  configBase: Record<string, unknown>,
  biTemporalEnabled: boolean,
  mode: 'mini' | 'full',
  seed: number,
  outputDir: string,
): Promise<ModeReport> {
  console.log(`\n=== Mode: BI_TEMPORAL_ENABLED=${biTemporalEnabled} ===`);
  const allResults: QuestionResult[] = [];

  for (let i = 0; i < traces.length; i++) {
    const t = traces[i]!;
    const r = await runOneTrace(t, configBase, biTemporalEnabled);
    allResults.push(...r);
    if ((i + 1) % 5 === 0 || i === traces.length - 1) {
      const pct = ((allResults.filter((x) => x.correct).length / allResults.length) * 100).toFixed(1);
      console.log(`  [${i + 1}/${traces.length}] ${allResults.length} Qs, ${pct}% correct so far`);
    }
  }

  const summary = summarize(allResults);
  const report: ModeReport = {
    benchmark: 'correction-propagation',
    timestamp: new Date().toISOString(),
    config: { mode, biTemporalEnabled, answerModel: ANSWER_MODEL, seed },
    methodology: {
      note:
        'Synthetic correction-propagation bench. Fresh :memory: repo per trace. ' +
        'Two facts inserted via repo.insert (one supersedes the other). ' +
        'Deterministic keyword judge.',
      metric: 'keyword inclusion + exclusion (case-insensitive substring)',
      ceiling: 1.0,
    },
    summary,
    results: allResults,
  };

  const isoSafe = report.timestamp.replace(/[:.]/g, '-');
  const filename = `correction-propagation-bt${biTemporalEnabled ? 'on' : 'off'}-${isoSafe}.json`;
  const path = resolve(outputDir, filename);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const mode: 'mini' | 'full' = mini ? 'mini' : 'full';
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;

  // S68: bench-env profile sets TEST_MODE/STONE/ROUTING/TEMPORAL/BI_TEMPORAL/DEDUP/CIRCUIT_BREAKER.
  // Legacy single-bench knobs (DEMIURGE_API_KEY, DB_PATH, LOG_LEVEL) stay inline, not in profile.
  const { ensureBenchEnv } = await import('../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../lib/bench-telemetry.js');
  ensureBenchEnv('correction-propagation');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const fixture = generate(seed, mode);
  console.log(
    `Bench 1: correction-propagation [${mode}] seed=${seed} → ${fixture.traces.length} traces, ${
      fixture.traces.length * 4
    } questions per mode`,
  );

  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const configBase = { ...config };
  const reportOff = await runMode(fixture.traces, configBase, false, mode, seed, outputDir);
  const reportOn = await runMode(fixture.traces, configBase, true, mode, seed, outputDir);

  console.log('\n=== Final scores (BI_TEMPORAL: OFF | ON) ===');
  console.log(
    `  Overall:  ${(reportOff.summary.accuracy * 100).toFixed(1)}% | ${(reportOn.summary.accuracy * 100).toFixed(1)}%`,
  );
  for (const t of ['current', 'historical', 'change', 'list']) {
    const o = reportOff.summary.perType[t];
    const n = reportOn.summary.perType[t];
    const op = o ? (o.accuracy * 100).toFixed(1) + '%' : 'n/a';
    const np = n ? (n.accuracy * 100).toFixed(1) + '%' : 'n/a';
    console.log(`  ${t.padEnd(11)}: ${op.padStart(6)} | ${np.padStart(6)}`);
  }
  console.log(
    `  Phantom rate: ${(reportOff.summary.phantomRate * 100).toFixed(1)}% | ${(reportOn.summary.phantomRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Mean ret ms:  ${reportOff.summary.meanRetrievalMs.toFixed(1)} | ${reportOn.summary.meanRetrievalMs.toFixed(1)}`,
  );
}

// Run when invoked directly via tsx (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runOneTrace, summarize, buildSyntheticRecord };
