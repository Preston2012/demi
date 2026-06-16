/**
 * DialSim adapter for Demiurge.
 *
 * Upstream: https://github.com/jiho283/Simulator (DialSim)
 *           https://huggingface.co/datasets/THUIR/MemoryBench (repackaging used here)
 *
 * Long-term multi-party dialogue benchmark across three TV shows
 * (Friends, Big Bang Theory, The Office). Tests:
 *   - Multi-party turn tracking
 *   - Temporal reasoning (questions reference past dates, asked at "asked_at")
 *   - Refusal-first (must say "don't know" when info isn't in dialog history)
 *   - Speed (6-second time-bound per query)
 *
 * Per-Q DB seeding pattern:
 *   For each query, build a fresh in-memory DB containing only utterances
 *   dated <= asked_at, then run the query under a 6-second wall-clock budget.
 *
 * Critical: TEST_MODE=true mandatory. source='user' (NOT 'import' which
 * always quarantines per S48 brain #1887). validFrom = session date.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { callLLM } from '../../llm-caller.js';
import { callJudgeCached } from '../../judge-cache.js';
import { maybeStoneForMaterializer } from '../../lib/stone-wiring.js';

interface DialSimSession {
  date_iso: string;
  date_raw: string;
  session_num: number;
  utterances: string[];
}

interface DialSimQuery {
  qid: string;
  question: string;
  expected: string;
  asker: string;
  asked_at: string;
  meta: {
    episode?: string;
    session_num?: number;
    conversation_num?: number;
    split?: string;
  };
}

interface DialSimShow {
  show: string;
  sessions: DialSimSession[];
  queries: DialSimQuery[];
}

interface DialSimFixture {
  bench_id: 'dialsim';
  upstream_version: string;
  description: string;
  mode: 'mini' | 'full';
  shows: Record<string, DialSimShow>;
}

interface DialSimResult {
  qid: string;
  show: string;
  asker: string;
  asked_at: string;
  question: string;
  expected: string;
  predicted: string;
  judge_correct: boolean;
  timed_out: boolean;
  retrieved_count: number;
  context_text_len: number;
  retrieval_ms: number;
  total_ms: number;
  utterances_seeded: number;
  error?: string;
}

interface DialSimReport {
  benchmark: 'dialsim';
  upstream: string;
  timestamp: string;
  commit: string;
  config: {
    mode: 'mini' | 'full';
    answerModel: string;
    judgeModel: string;
    maxRules: number;
    timeBudgetMs: number;
    shows: string[];
  };
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    timedOut: number;
    timeoutRate: number;
    meanRetrievalMs: number;
    meanTotalMs: number;
    perShow: Record<string, { total: number; correct: number; accuracy: number; timedOut: number }>;
  };
  results: DialSimResult[];
}

// ============================================================================
// LLM call (mirrors MAB/CloneMem)
// ============================================================================

// ============================================================================
// Judge: official DialSim prompt (Yes/No correctness)
// ============================================================================

const JUDGE_SYSTEM = `You have to judge the correctness of a <prediction> to a corresponding <question>, based on <true answer>.

If the <prediction> basically says the same thing as the <true answer>, you should say that the <prediction> is correct.
Otherwise, you should say that the <prediction> is wrong.

Respond ONLY with "yes" if correct, "no" if wrong. No explanation.`;

function makeJudgeUser(question: string, gold: string, predicted: string): string {
  return `<question>\n${question}\n\n<true answer>\n${gold}\n\n<prediction>\n${predicted}`;
}

// ============================================================================
// B2 v3 (S71): date-aware FOCUS WINDOW for the answer prompt
// ============================================================================

/**
 * Extract the most-likely referenced date from a question. Prompt-only;
 * does NOT modify retrieval. Returns ISO 8601 date string (YYYY-MM-DD) or
 * empty if no date can be extracted.
 *
 * Priority:
 *   1. Explicit ISO date in question (2024-01-15, 2024/01/15)
 *   2. Month + day + year (January 15, 2024)
 *   3. Month + year (March 2024) → first of month
 *   4. Falls back to askedAt (the question's asked-at timestamp)
 */
function extractReferencedDate(question: string, askedAt: string): string {
  // ISO 8601 (preferred): 2024-01-15 or 2024/01/15
  const iso = question.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso && iso[1] && iso[2] && iso[3]) {
    const y = iso[1];
    const m = iso[2].padStart(2, '0');
    const d = iso[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Month-name + day + year: "January 15, 2024" / "Jan 15 2024"
  const months: Record<string, string> = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    sept: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const monthDayYear = question.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (monthDayYear && monthDayYear[1] && monthDayYear[2]) {
    const monKey = monthDayYear[1].toLowerCase();
    const m = months[monKey];
    if (m) {
      const d = monthDayYear[2].padStart(2, '0');
      const y = monthDayYear[3] ?? (askedAt ? askedAt.slice(0, 4) : '');
      if (y) return `${y}-${m}-${d}`;
    }
  }

  // Month + year: "March 2024"
  const monthYear = question.match(/\b([A-Za-z]{3,9})\s+(\d{4})\b/);
  if (monthYear && monthYear[1] && monthYear[2]) {
    const monKey = monthYear[1].toLowerCase();
    const m = months[monKey];
    if (m) return `${monthYear[2]}-${m}-01`;
  }

  // Fallback: asked_at first 10 chars (YYYY-MM-DD prefix)
  if (askedAt && /^\d{4}-\d{2}-\d{2}/.test(askedAt)) {
    return askedAt.slice(0, 10);
  }

  return '';
}

/**
 * Build the FOCUS WINDOW prepend block. Returns empty string if no
 * useful date could be extracted, caller appends nothing in that case.
 */
function buildFocusWindow(question: string, askedAt: string): string {
  const date = extractReferencedDate(question, askedAt);
  if (!date) return '';
  return `[Focus Window]
The question is asked in reference to ${date}. When the retrieved dialog history contains utterances from multiple dates, prioritize utterances at or near this date when answering.

`;
}

// ============================================================================
// Answer prompt (mirrors official DialSim RAG_qa_prompt_open_ended)
// ============================================================================

const ANSWER_SYSTEM = `You are a long-term conversation agent capable of interacting with multiple users. Based on the [Retrieved Dialog History] provided, answer the given [Question].

Rules:
1. Your responses should solely rely on the retrieved dialog history. If the information in the dialog history is insufficient to answer the question, you must admit that you don't know the answer.
2. Be concise. Answer in 1-3 words or one short sentence.`;

function makeAnswerUser(asker: string, askedAt: string, contextText: string, question: string): string {
  // B2 v3 (S71): prepend FOCUS WINDOW block when a date can be extracted.
  // Does NOT modify contextText itself, pure prompt-side nudge.
  const focus = buildFocusWindow(question, askedAt);
  return `${focus}[Retrieved Dialog History]\n${contextText}\n\n[Question, asked in the context of ${askedAt}, by ${asker}]\n${question}\n\n[Answer]`;
}

// ============================================================================
// Time-bounded race
// ============================================================================

function withTimeout<T>(promise: Promise<T>, ms: number, _label: string): Promise<{ value?: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ timedOut: true });
      }
    }, ms);
    promise.then(
      (value) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({ value, timedOut: false });
        }
      },
      () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({ timedOut: false });
        }
      },
    );
  });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // S59A: bench-env preamble
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('dialsim');
  initBenchTelemetry();
  const args = process.argv.slice(2);
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
  const mini = args.includes('--mini') || !args.includes('--full');
  const fixturePathIdx = args.indexOf('--fixture-path');
  const fixturePath =
    fixturePathIdx !== -1
      ? args[fixturePathIdx + 1]!
      : `fixtures/benchmark/public/dialsim/dialsim-${mini ? 'mini' : 'full'}.json`;
  const showsIdx = args.indexOf('--shows');
  const showsArg = showsIdx !== -1 ? args[showsIdx + 1]! : 'friends,bigbang,theoffice';
  const showsFilter = showsArg.split(',').map((s) => s.trim());
  const answerModelIdx = args.indexOf('--answer-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4.1-mini';
  const judgeModelIdx = args.indexOf('--judge-model');
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '65', 10) : 65;
  const timeBudgetIdx = args.indexOf('--time-budget-ms');
  const timeBudgetMs = timeBudgetIdx !== -1 ? parseInt(args[timeBudgetIdx + 1] ?? '6000', 10) : 6000;
  const maxQuestionsIdx = args.indexOf('--max-questions');
  const maxQuestions = maxQuestionsIdx !== -1 ? parseInt(args[maxQuestionsIdx + 1] ?? '0', 10) : 0;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_MODE = process.env.BENCH_MODE || 'true';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true'; // A2 back-compat alias

  console.log(
    `DialSim [mini=${mini}] shows=${showsFilter.join(',')} time=${timeBudgetMs}ms answer=${answerModel} maxRules=${maxRules}`,
  );

  const fixture: DialSimFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  console.log(`Fixture: ${fixturePath}`);

  const { loadConfig } = await import('../../../config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../../../embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embedding model loaded');

  const { SqliteMemoryRepository } = await import('../../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../../core/dispatch.js');

  const allResults: DialSimResult[] = [];

  for (const showName of showsFilter) {
    const show = fixture.shows[showName];
    if (!show) {
      console.log(`SKIP: show '${showName}' not in fixture`);
      continue;
    }

    // Sort sessions by date, queries by asked_at, monotonic build per show
    const sessions = [...show.sessions].sort((a, b) => a.date_iso.localeCompare(b.date_iso));
    const queries = [...show.queries].sort((a, b) => a.asked_at.localeCompare(b.asked_at));
    const cap = maxQuestions > 0 ? Math.min(maxQuestions, queries.length) : queries.length;
    const cappedQueries = queries.slice(0, cap);

    console.log(
      `\n=== ${showName}: ${sessions.length} sessions, ${cappedQueries.length} queries (sorted by asked_at) ===`,
    );

    // Per-show monotonic DB: sessions added as we cross each Q's asked_at threshold
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    const stone = maybeStoneForMaterializer(repo);
    const dispatch = createCoreDispatch(repo, config, stone);

    let sessionPtr = 0;
    let totalUttsSeeded = 0;
    let utteranceCounter = 0;

    for (const q of cappedQueries) {
      // Advance session pointer to consume any sessions dated <= q.asked_at
      const seedStart = performance.now();
      let newlySeeded = 0;
      let newlyFailed = 0;
      while (sessionPtr < sessions.length && sessions[sessionPtr]!.date_iso <= q.asked_at) {
        const sess = sessions[sessionPtr]!;
        for (const utt of sess.utterances) {
          // validFrom = session date + utterance offset (seconds within session for ordering)
          const baseEpoch = new Date(`${sess.date_iso}T12:00:00Z`).getTime();
          const validFrom = new Date(baseEpoch + utteranceCounter * 1000).toISOString();
          utteranceCounter += 1;
          const claim = utt.length > 1997 ? utt.slice(0, 1997) + '...' : utt;
          // Subject heuristic: speaker name before first ':'
          const speakerMatch = claim.match(/^([A-Za-z()\s]+?):/);
          const subject = speakerMatch ? speakerMatch[1]!.trim().toLowerCase() : 'dialog';
          try {
            const result = await dispatch.addMemory({
              claim,
              subject,
              source: 'user',
              confidence: 0.95,
              validFrom,
              // S59 / TEMPR: stamp session and episode anchors so the
              // pre-rerank episode filter can match queries that resolve
              // to a specific session date (DialSim queries often do).
              sessionId: `${showName}-s${sess.session_num}`,
              episodeId: sess.date_iso,
            });
            if (result.action !== 'rejected' && (result as any).trustClass !== 'quarantined') {
              newlySeeded += 1;
              totalUttsSeeded += 1;
            } else {
              newlyFailed += 1;
            }
          } catch {
            newlyFailed += 1;
          }
        }
        sessionPtr += 1;
      }
      const seedMs = performance.now() - seedStart;
      if (newlySeeded > 0) {
        console.log(
          `  [seed up to ${q.asked_at}] +${newlySeeded} utts (${(seedMs / 1000).toFixed(1)}s, total=${totalUttsSeeded})`,
        );
      }

      await repo.setMetadata('last_activity', new Date(`${q.asked_at}T23:59:59Z`).toISOString());

      // Run query under time budget
      const totalStart = performance.now();
      let predicted = '';
      let retrieved_count = 0;
      let context_text_len = 0;
      let retrieval_ms = 0;
      let timed_out = false;
      let error: string | undefined;

      const queryPromise = (async () => {
        const tStart = performance.now();
        const search = await dispatch.search(q.question, maxRules);
        retrieval_ms = performance.now() - tStart;
        retrieved_count = (search as any).raw?.candidates?.length ?? 0;
        context_text_len = search.contextText?.length ?? 0;

        const userPrompt = makeAnswerUser(q.asker, q.asked_at, search.contextText ?? '', q.question);
        return await callLLM(answerModel, ANSWER_SYSTEM, userPrompt, 100, 0, {
          cacheKey: 'demiurge:dialsim:answer:v1',
        });
      })();

      try {
        const raced = await withTimeout(queryPromise, timeBudgetMs, q.qid);
        if (raced.timedOut) {
          timed_out = true;
          predicted = '[TIMEOUT]';
        } else {
          predicted = raced.value ?? '';
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      // Judge (separate from time budget, we always evaluate even if timed out)
      let judge_correct = false;
      if (!timed_out && predicted) {
        try {
          // S68: persistent judge cache (M9). cacheTag scopes entries per-bench.
          const judgeRes = await callJudgeCached({
            model: judgeModel,
            system: JUDGE_SYSTEM,
            user: makeJudgeUser(q.question, q.expected, predicted),
            predicted,
            cacheTag: 'dialsim',
            maxTokens: 5,
            llmCacheKey: 'demiurge:dialsim:judge:v1',
          });
          judge_correct = /^\s*yes/i.test(judgeRes.verdict);
        } catch (err) {
          error = error ?? (err instanceof Error ? err.message : String(err));
        }
      }

      const total_ms = performance.now() - totalStart;
      allResults.push({
        qid: q.qid,
        show: showName,
        asker: q.asker,
        asked_at: q.asked_at,
        question: q.question,
        expected: q.expected,
        predicted,
        judge_correct,
        timed_out,
        retrieved_count,
        context_text_len,
        retrieval_ms,
        total_ms,
        utterances_seeded: totalUttsSeeded,
        error,
      });

      const correctSofar = allResults.filter((r) => r.judge_correct).length;
      const tag = judge_correct ? '✓' : timed_out ? '⏱' : '✗';
      console.log(
        `  [${allResults.length}] ${tag} ${q.qid} ret=${retrieval_ms.toFixed(0)}ms total=${total_ms.toFixed(0)}ms acc=${((correctSofar / allResults.length) * 100).toFixed(1)}%`,
      );
    }

    if (typeof (repo as any).close === 'function') (repo as any).close();
  }

  // ----- Report -----
  const total = allResults.length;
  const correct = allResults.filter((r) => r.judge_correct).length;
  const timedOut = allResults.filter((r) => r.timed_out).length;
  const meanRet = total > 0 ? allResults.reduce((s, r) => s + r.retrieval_ms, 0) / total : 0;
  const meanTot = total > 0 ? allResults.reduce((s, r) => s + r.total_ms, 0) / total : 0;

  const perShow: Record<string, { total: number; correct: number; accuracy: number; timedOut: number }> = {};
  for (const r of allResults) {
    perShow[r.show] = perShow[r.show] ?? { total: 0, correct: 0, accuracy: 0, timedOut: 0 };
    perShow[r.show]!.total += 1;
    if (r.judge_correct) perShow[r.show]!.correct += 1;
    if (r.timed_out) perShow[r.show]!.timedOut += 1;
  }
  for (const k of Object.keys(perShow)) {
    perShow[k]!.accuracy = perShow[k]!.total > 0 ? perShow[k]!.correct / perShow[k]!.total : 0;
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD').toString().trim();
  } catch {
    /* no git */
  }

  const report: DialSimReport = {
    benchmark: 'dialsim',
    upstream: 'https://github.com/jiho283/Simulator (via THUIR/MemoryBench)',
    timestamp: new Date().toISOString(),
    commit,
    config: { mode: fixture.mode, answerModel, judgeModel, maxRules, timeBudgetMs, shows: showsFilter },
    summary: {
      totalQuestions: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      timedOut,
      timeoutRate: total > 0 ? timedOut / total : 0,
      meanRetrievalMs: meanRet,
      meanTotalMs: meanTot,
      perShow,
    },
    results: allResults,
  };

  const outDir = 'benchmark-results';
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `dialsim-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\n  → wrote ${out}\n`);
  console.log(`=== Final scores ===`);
  console.log(`  Overall:        ${(report.summary.accuracy * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`  Timed out:      ${(report.summary.timeoutRate * 100).toFixed(1)}% (${timedOut}/${total})`);
  console.log(`  Mean ret ms:    ${meanRet.toFixed(1)}`);
  console.log(`  Mean total ms:  ${meanTot.toFixed(1)}`);
  for (const [show, s] of Object.entries(perShow)) {
    console.log(`  ${show}: ${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.total}, timeout=${s.timedOut})`);
  }

  // S59 / TEMPR: degraded-rate gate. Throws if rerank degraded ≥ 1% over the run.
  const { assertRerankDegradedBelow } = await import('../../shared/rerank-telemetry.js');
  assertRerankDegradedBelow(0.01, 'DialSim');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
