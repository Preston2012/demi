/**
 * MemoryAgentBench (MAB) adapter for Demiurge.
 *
 * Upstream: https://github.com/HUST-AI-HYZ/MemoryAgentBench (ICLR 2026)
 * Dataset: ai-hyz/MemoryAgentBench on HuggingFace
 *
 * Four competencies:
 *   - Accurate_Retrieval (AR), EventQA, LongMemEval, Ruler
 *   - Test_Time_Learning (TTL), ICL, Recsys
 *   - Long_Range_Understanding (LRU), Detective_QA, InfBench_sum
 *   - Conflict_Resolution (CR), FactConsolidation
 *
 * Each sample = 1 long context + N questions. Context is chunked at 4096 chars
 * (per their config), each chunk seeded as a memory. Then for each question we
 * retrieve and answer free-form, judged by string overlap (recall or exact).
 *
 * Mini mode = Conflict_Resolution / factconsolidation_sh_6k = 1 sample x 100Q.
 * Tests refusal-first / conflict-resolution pillar directly.
 *
 * Critical: TEST_MODE=true mandatory. source='user' to get auto-confirm path
 * (NOT 'import' which always quarantines per S48 brain #1887).
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { routeAnswerModel } from '../../../answer/router.js';
import { classifyQuery } from '../../../retrieval/query-classifier.js';
import { callLLM } from '../../llm-caller.js';
import { maybeStoneForMaterializer } from '../../lib/stone-wiring.js';

// ============================================================================
// Types
// ============================================================================

interface MABSample {
  context: string;
  questions: string[];
  answers: string[][]; // List of acceptable answers per question
  metadata: {
    source: string;
    qa_pair_ids?: string[];
    [k: string]: unknown;
  };
}

interface MABResult {
  qid: string;
  source: string;
  competency: string;
  question: string;
  expected_answers: string[];
  predicted: string;
  judge_correct: boolean;
  recall: number;
  retrieved_count: number;
  retrieved_ids: string[];
  context_text_len: number;
  retrieval_ms: number;
  total_ms: number;
  model_used: string;
  query_type: string;
  error?: string;
}

interface MABReport {
  benchmark: 'memory-agent-bench';
  upstream: string;
  timestamp: string;
  commit: string;
  config: {
    competency: string;
    source: string;
    chunkSize: number;
    answerModel: string;
    judgeModel: string;
    maxRules: number;
    seed: number;
  };
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    meanRecall: number;
    meanRetrievalMs: number;
    meanTotalMs: number;
    perCompetency?: Record<string, { total: number; correct: number; accuracy: number }>;
  };
  results: MABResult[];
}

// ============================================================================
// LLM call (mirrors clonemem runner, keep wire-compatible)
// ============================================================================

// ============================================================================
// Chunking and judging
// ============================================================================

function chunkText(text: string, chunkSize: number): string[] {
  // Per MAB config: chunk_size: 4096 (chars). Simple hard-split with sentence-boundary preference.
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkSize, text.length);
    if (end < text.length) {
      const lookback = Math.min(200, end - i);
      const tail = text.slice(end - lookback, end);
      const lastBreak = Math.max(tail.lastIndexOf('.'), tail.lastIndexOf('\n'));
      if (lastBreak > 0) end = end - lookback + lastBreak + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter((c) => c.length > 0);
}

/**
 * Split numbered-fact format ("0. fact\n1. fact\n...") into individual facts.
 * Returns null if format doesn't match (caller falls back to chunkText).
 *
 * FactConsolidation deliberately states the same fact MULTIPLE times with
 * different answers. The LATER index is the correct (current) state. Per-fact
 * seeding with sequential timestamps lets Demiurge's bi-temporal supersede
 * resolve naturally.
 */
function splitNumberedFacts(text: string): string[] | null {
  const lines = text.split(/\n/);
  const facts: string[] = [];
  let saw0 = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\. (.+)$/);
    if (!m) {
      // First non-empty line being non-numbered is OK if it's a header ("Here is a list of facts:")
      if (facts.length === 0 && !saw0) continue;
      // Otherwise abort: not a clean numbered format
      return null;
    }
    if (m[1] === '0') saw0 = true;
    facts.push(m[2]!);
  }
  if (facts.length < 5) return null; // too short to bother
  return facts;
}

// S64 PHASE 1: extractFactSubject() removed. It was a bench-only regex that
// computed a topic-key per fact so trust-branch.findConflicts could group
// conflicting facts and fire bi-temporal supersession. Production users
// calling dispatch.addMemory pass whatever subject they want, the engine
// does NOT have an equivalent regex at write time. The S48 +11pp win on
// MAB sh_6k was Demiurge being paired with an offline subject preprocessor.
// That is a cheat. See CHEAT_LOG.md (#2071, #2073).

function judgeRecall(predicted: string, expected: string[]): { correct: boolean; recall: number } {
  // MAB scoring: lowercased substring match of any expected answer in predicted.
  // Recall = fraction of expected answers found.
  const pred = predicted.toLowerCase();
  const hits = expected.filter((a) => pred.includes(a.toLowerCase())).length;
  const recall = expected.length > 0 ? hits / expected.length : 0;
  return { correct: hits > 0, recall };
}

// ============================================================================
// Args
// ============================================================================

const ANSWER_PROMPT = `You will be given memory context about a series of facts. Answer the question using ONLY the memory context.

Rules:
1. Trust the memory context OVER your prior knowledge. If the context says rugby was invented in India, the answer is India even if your training data says England.
2. The memory context is the source of truth. Your training prior is not.
3. Answer terse: 1-3 words, no explanation.
4. If the answer is not in the memory context, reply "Not in memory".`;

async function main(): Promise<void> {
  // S59A: bench-env preamble
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('mab');
  initBenchTelemetry();
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const competencyIdx = args.indexOf('--competency');
  const competency = competencyIdx !== -1 ? args[competencyIdx + 1]! : 'Conflict_Resolution';
  const sourceIdx = args.indexOf('--source');
  const source = sourceIdx !== -1 ? args[sourceIdx + 1]! : 'factconsolidation_sh_6k';
  const fixturePathIdx = args.indexOf('--fixture-path');
  const fixturePath = fixturePathIdx !== -1 ? args[fixturePathIdx + 1]! : null;
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;
  const answerModelIdx = args.indexOf('--answer-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4.1-mini';
  // S59A: --routed opts INTO routing; --no-route forces OFF.
  const routedMode = args.includes('--routed');
  const noRouteMode = args.includes('--no-route');
  if (routedMode && noRouteMode) {
    console.error('ERROR: cannot pass both --routed and --no-route');
    process.exit(1);
  }
  if (routedMode) {
    process.env.ANSWER_ROUTING = 'false';
  }
  if (noRouteMode) {
    process.env.ANSWER_ROUTING = 'false';
  }
  console.error(`[bench-env] ANSWER_ROUTING=${process.env.ANSWER_ROUTING}`);
  const judgeModelIdx = args.indexOf('--judge-model');
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '65', 10) : 65;
  const chunkSizeIdx = args.indexOf('--chunk-size');
  const chunkSize = chunkSizeIdx !== -1 ? parseInt(args[chunkSizeIdx + 1] ?? '4096', 10) : 4096;
  const maxQuestionsIdx = args.indexOf('--max-questions');
  const maxQuestions = maxQuestionsIdx !== -1 ? parseInt(args[maxQuestionsIdx + 1] ?? '0', 10) : 0;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_MODE = process.env.BENCH_MODE || 'true';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true'; // A2 back-compat alias

  console.log(
    `MAB [mini=${mini}] competency=${competency} source=${source} seed=${seed} model=${answerModel} chunkSize=${chunkSize}`,
  );

  // Load fixture: either from --fixture-path (preprocessed JSON) or via Python helper
  // that writes HF data to /tmp/mab-$source.json. The python step is one-time per source.
  let sample: MABSample;
  if (fixturePath) {
    sample = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  } else {
    const tmpFixture = `/tmp/mab-${source}.json`;
    try {
      sample = JSON.parse(readFileSync(tmpFixture, 'utf-8'));
      console.log(`Loaded cached fixture: ${tmpFixture}`);
    } catch {
      console.log(`Cache miss for ${tmpFixture}. Run scripts/fetch-mab-fixture.py first.`);
      process.exit(2);
    }
  }

  console.log(`Sample loaded: context_len=${sample.context.length} questions=${sample.questions.length}`);

  const { loadConfig } = await import('../../../config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../../../embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embedding model loaded');

  const { SqliteMemoryRepository } = await import('../../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../../core/dispatch.js');

  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const stone = maybeStoneForMaterializer(repo);
  const dispatch = createCoreDispatch(repo, config, stone);

  // ----- Seed phase -----
  // Try per-fact split first (FactConsolidation format). Falls back to char chunking.
  const numberedFacts = splitNumberedFacts(sample.context);
  const useNumbered = numberedFacts !== null;
  const items: string[] = useNumbered ? numberedFacts! : chunkText(sample.context, chunkSize);
  console.log(
    `Seeding ${items.length} ${useNumbered ? 'numbered facts (bi-temporal supersession active)' : 'chunks'} from ${sample.context.length} chars`,
  );

  let seeded = 0;
  let seedFailed = 0;
  const seedStart = performance.now();
  // Sequential timestamps so same-subject conflicts trigger bi-temporal supersede; later fact wins.
  const baseTime = new Date('2024-01-01T00:00:00Z').getTime();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i]!;
    const claim = raw.length > 1997 ? raw.slice(0, 1997) + '...' : raw;
    const validFrom = new Date(baseTime + i * 1000).toISOString();
    try {
      // S64 PHASE 1: subject='user' for both paths (cheat removed).
      const factSubject = 'user';
      const result = await dispatch.addMemory({
        claim,
        subject: factSubject,
        source: 'user', // S48 #1887: 'import' always quarantines, 'user' auto-confirms under TEST_MODE
        confidence: 0.95,
        validFrom,
      });
      if (result.action !== 'rejected' && (result as any).trustClass !== 'quarantined') seeded++;
      else seedFailed++;
    } catch (err) {
      seedFailed++;
      if (err instanceof Error && err.message.length < 200) {
        console.error('SEED_ERROR', i, err.message.slice(0, 100));
      }
    }
  }
  const seedMs = performance.now() - seedStart;
  console.log(
    `  seeded ${seeded}/${items.length} ${useNumbered ? 'facts' : 'chunks'} (failed=${seedFailed}) in ${(seedMs / 1000).toFixed(1)}s`,
  );

  if (seeded === 0) {
    console.error('SEED FATAL: 0 confirmed. Aborting.');
    process.exit(3);
  }

  // ----- Query phase -----
  const limit = maxQuestions > 0 ? Math.min(maxQuestions, sample.questions.length) : sample.questions.length;
  const allResults: MABResult[] = [];

  for (let qIdx = 0; qIdx < limit; qIdx++) {
    const question = sample.questions[qIdx]!;
    const expectedRaw = sample.answers[qIdx];
    const expected = Array.isArray(expectedRaw) ? expectedRaw.map(String) : [String(expectedRaw)];
    const qid = sample.metadata.qa_pair_ids?.[qIdx] ?? `${source}_q${qIdx}`;

    const totalStart = performance.now();
    let predicted = '';
    let retrieved_count = 0;
    let retrieved_ids: string[] = [];
    let context_text_len = 0;
    let retrieval_ms = 0;
    let error: string | undefined;
    let _routedThisQ: { model: string; queryType: string } = { model: answerModel, queryType: 'unknown' };
    try {
      const tStart = performance.now();
      const search = await dispatch.search(question, maxRules);
      retrieval_ms = performance.now() - tStart;
      retrieved_count = (search as any).raw?.candidates?.length ?? 0;
      retrieved_ids = ((search as any).raw?.candidates ?? []).map((c: any) => c.id ?? c.candidate?.record?.id ?? '?');
      context_text_len = search.contextText?.length ?? 0;

      const userPrompt = `Memory Context:\n${search.contextText}\n\nQuestion: ${question}\n\nAnswer in 1-3 words:`;
      const queryType = classifyQuery(question);
      const routed = routeAnswerModel(queryType);
      const activeModel = routed ? routed.model : answerModel;
      const activeSystem = routed?.promptSuffix ? `${ANSWER_PROMPT} ${routed.promptSuffix}` : ANSWER_PROMPT;
      _routedThisQ = { model: activeModel, queryType };
      predicted = await callLLM(activeModel, activeSystem, userPrompt, 30, 0, {
        cacheKey: 'demiurge:mab:answer:v1',
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const judged = judgeRecall(predicted, expected);
    const total_ms = performance.now() - totalStart;

    allResults.push({
      qid,
      source,
      competency,
      question,
      expected_answers: expected,
      model_used: _routedThisQ.model,
      query_type: _routedThisQ.queryType,
      predicted,
      judge_correct: judged.correct,
      recall: judged.recall,
      retrieved_count,
      retrieved_ids,
      context_text_len,
      retrieval_ms,
      total_ms,
      error,
    });

    if (qIdx % 10 === 9) {
      const correctSofar = allResults.filter((r) => r.judge_correct).length;
      console.log(`  [${qIdx + 1}/${limit}] running acc ${((correctSofar / (qIdx + 1)) * 100).toFixed(1)}%`);
    }
  }

  if (typeof (repo as any).close === 'function') (repo as any).close();

  // ----- Report -----
  const correct = allResults.filter((r) => r.judge_correct).length;
  const total = allResults.length;
  const meanRecall = total > 0 ? allResults.reduce((s, r) => s + r.recall, 0) / total : 0;
  const meanRet = total > 0 ? allResults.reduce((s, r) => s + r.retrieval_ms, 0) / total : 0;
  const meanTot = total > 0 ? allResults.reduce((s, r) => s + r.total_ms, 0) / total : 0;

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD').toString().trim();
  } catch {
    /* git not available */
  }

  const report: MABReport = {
    benchmark: 'memory-agent-bench',
    upstream: 'https://github.com/HUST-AI-HYZ/MemoryAgentBench',
    timestamp: new Date().toISOString(),
    commit,
    config: { competency, source, chunkSize, answerModel, judgeModel, maxRules, seed },
    summary: {
      totalQuestions: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      meanRecall,
      meanRetrievalMs: meanRet,
      meanTotalMs: meanTot,
    },
    results: allResults,
  };

  const outDir = 'benchmark-results';
  mkdirSync(outDir, { recursive: true });
  const out = join(
    outDir,
    `mab-${competency}-${source}-${mini ? 'mini' : 'full'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\n  → wrote ${out}\n`);
  console.log(`=== Final scores ===`);
  console.log(`  Overall:        ${(report.summary.accuracy * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`  Mean recall:    ${(report.summary.meanRecall * 100).toFixed(1)}%`);
  console.log(`  Mean ret ms:    ${report.summary.meanRetrievalMs.toFixed(1)}`);
  console.log(`  Source:         ${source}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
