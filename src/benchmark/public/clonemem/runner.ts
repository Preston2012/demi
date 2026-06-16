/**
 * CloneMem adapter for Demiurge.
 *
 * Upstream: https://github.com/AvatarMemory/CloneMemBench
 *
 * Per-persona JSON contains:
 *   - person_name, person_id
 *   - context: list of digital traces (medium, event_date, content), these become memories
 *   - qa_items: list of MCQ questions (question, choices, correct_choice_id, dimension)
 *
 * Mini mode = first 2 personas. Full mode = all personas in 100k tier.
 * MCQ scoring: model picks A-E from context, judged by string match against correct_choice_id.
 *
 * Critical: TEST_MODE=true is mandatory, see src/write/index.ts:108.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { routeAnswerModel } from '../../../answer/router.js';
import { classifyQuery } from '../../../retrieval/query-classifier.js';
import { callLLM } from '../../llm-caller.js';
import { maybeStoneForMaterializer } from '../../lib/stone-wiring.js';

interface CloneMemContext {
  id: string;
  medium: string;
  event_date: string;
  content: string;
}

interface CloneMemChoice {
  id: string; // 'A' | 'B' | 'C' | 'D' | 'E'
  text: string;
}

interface CloneMemQA {
  id: string;
  question: string;
  question_type: string;
  question_time: string;
  answer: string;
  dimension: string; // 'experience' | 'opinion' | 'emotion'
  digital_trace_ids: string[];
  evidence: Array<{ statement: string; digital_trace_ids: string[] }>;
  choices: CloneMemChoice[];
  correct_choice_id: string;
}

interface CloneMemPersona {
  person_name: string;
  person_id: string;
  context: CloneMemContext[];
  qa_items: CloneMemQA[];
}

interface CloneMemResult {
  qid: string;
  person_id: string;
  question_type: string;
  dimension: string;
  question: string;
  expected_choice: string;
  predicted_choice: string;
  predicted_full: string;
  correct: boolean;
  retrieved_count: number;
  retrieved_ids: string[];
  context_text_len: number;
  retrieval_ms: number;
  total_ms: number;
  model_used: string;
  query_type: string;
  error?: string;
}

interface CloneMemReport {
  benchmark: string;
  upstream: string;
  timestamp: string;
  commit: string;
  config: {
    mode: 'mini' | 'full';
    tier: '100k' | '500k';
    answerModel: string;
    judgeModel: string;
    maxRules: number;
    seed: number;
    personasUsed: number;
  };
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    perDimension: Record<string, { total: number; correct: number; accuracy: number }>;
    perQuestionType: Record<string, { total: number; correct: number; accuracy: number }>;
    perPersona: Record<string, { total: number; correct: number; accuracy: number }>;
    meanRetrievalMs: number;
  };
  results: CloneMemResult[];
}

const ANSWER_PROMPT = `You will be given memory context about a person and a question with 5 multiple-choice answers (A, B, C, D, E).

Rules:
1. Trust the memory context over your prior knowledge. If the context says X, the answer is X even if training data says otherwise.
2. For specific factual questions (number, name, date, drug, salary, score): only answer if the exact fact is in context. Otherwise pick the cannot-determined choice.
3. For inference questions (counterfactual, causal, trajectory, opinion): the answer may not be a single sentence in context. Read the supporting evidence, identify which choice the evidence makes most consistent. Cannot-determined is correct ONLY when context is silent on the topic, not when context supports a choice through evidence.
4. Plausible answers that contradict context are wrong. Plausible answers that go beyond context with NO supporting evidence are also wrong. Pick the cannot-determined choice in both cases.

Answer with EXACTLY one letter: A, B, C, D, or E. No explanation, no other text.`;

function parseChoiceLetter(text: string): string {
  const trimmed = text.trim().toUpperCase();
  // Match standalone letter or letter at start
  const m = trimmed.match(/^[\s(]*([ABCDE])[\s).:?]/) ?? trimmed.match(/^([ABCDE])$/) ?? trimmed.match(/\b([ABCDE])\b/);
  return m && m[1] ? m[1] : '';
}

async function main(): Promise<void> {
  // S59A: bench-env preamble, sets routing-off + TEST_MODE/STONE defaults
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('clonemem');
  initBenchTelemetry();
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const mode: 'mini' | 'full' = mini ? 'mini' : 'full';
  const tier: '100k' | '500k' = args.includes('--500k') ? '500k' : '100k';
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;
  const answerModelIdx = args.indexOf('--answer-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4.1-mini';
  const judgeModelIdx = args.indexOf('--judge-model');
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '65', 10) : 65;
  const fixtureDirIdx = args.indexOf('--fixture-dir');
  const fixtureDirOverride = fixtureDirIdx !== -1 ? args[fixtureDirIdx + 1]! : null;
  // S59A: --routed opts INTO routing (publish-time); --no-route forces OFF.
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
  const maxQuestionsIdx = args.indexOf('--max-questions');
  const maxQuestions = maxQuestionsIdx !== -1 ? parseInt(args[maxQuestionsIdx + 1] ?? '999999', 10) : 999999;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_MODE = process.env.BENCH_MODE || 'true';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true'; // A2 back-compat alias

  const fixturesDir = fixtureDirOverride ?? '/root/public-benches/CloneMemBench/data/releases/' + tier;
  const allFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('_benchmark_en.json'));
  const personasToRun = mode === 'mini' ? allFiles.slice(0, 2) : allFiles;
  console.log(
    `CloneMem [${mode}] tier=${tier} seed=${seed} → ${personasToRun.length} personas, model=${answerModel} judge=${judgeModel}`,
  );

  const { loadConfig } = await import('../../../config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const { SqliteMemoryRepository } = await import('../../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../../core/dispatch.js');

  const allResults: CloneMemResult[] = [];

  for (const fname of personasToRun) {
    const fullPath = join(fixturesDir, fname);
    const persona: CloneMemPersona = JSON.parse(readFileSync(fullPath, 'utf-8'));
    console.log(`\n[${persona.person_name}] ${persona.context.length} traces, ${persona.qa_items.length} QAs`);

    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const stone = maybeStoneForMaterializer(repo);
    const dispatch = createCoreDispatch(repo, config, stone);

    let seeded = 0;
    for (const ctx of persona.context) {
      try {
        // CloneMem fixture mediums (calendar_event, work_log, memo, etc.) become claim prefix tags.
        // Schema requires source ∈ {user, llm, import}. Use 'user' for bench: 'import' source ALWAYS quarantines per trust-branch.ts line 245, which makes traces unretrievable.
        // Schema requires claim ≤ 2000 chars and validFrom as ISO datetime with offset.
        const rawClaim = `[${ctx.medium}] ${ctx.content}`;
        const claim = rawClaim.length > 2000 ? rawClaim.slice(0, 1997) + '...' : rawClaim;
        const validFrom =
          ctx.event_date.includes('Z') || /[+-]\d\d:\d\d$/.test(ctx.event_date) ? ctx.event_date : ctx.event_date + 'Z';
        const result = await dispatch.addMemory({
          claim,
          subject: 'user',
          source: 'user', // benchmark seed - auto-confirm path under TEST_MODE (not import which always quarantines)
          confidence: 0.95,
          validFrom,
        });
        if (result.action !== 'rejected') seeded++;
      } catch (err) {
        // Soft-fail: log and continue
        if (err instanceof Error && err.message.length < 200) {
          console.error('SEED_ERROR', ctx.id, err.message.slice(0, 100));
        }
      }
    }
    console.log(`  seeded ${seeded}/${persona.context.length} traces`);

    let qaIdx = 0;
    let _qaCount = 0;
    for (const qa of persona.qa_items) {
      if (_qaCount >= maxQuestions) break;
      _qaCount++;
      qaIdx++;
      const totalStart = performance.now();
      let predicted = '';
      let predicted_choice = '';
      let retrieved_count = 0;
      let retrieved_ids: string[] = [];
      let context_text_len = 0;
      let retrieval_ms = 0;
      let error: string | undefined;
      let _routedThisQ: { model: string; queryType: string } = { model: answerModel, queryType: 'unknown' };
      try {
        const tStart = performance.now();
        const search = await dispatch.search(qa.question, maxRules);
        retrieval_ms = performance.now() - tStart;
        retrieved_count = (search as any).raw?.candidates?.length ?? 0;
        retrieved_ids = ((search as any).raw?.candidates ?? []).map((c: any) => c.id);
        context_text_len = search.contextText?.length ?? 0;

        const choicesStr = qa.choices.map((c) => `${c.id}. ${c.text}`).join('\n\n');
        const userPrompt = `Memory Context:\n${search.contextText}\n\nQuestion: ${qa.question}\n\nChoices:\n${choicesStr}\n\nAnswer with ONE letter (A, B, C, D, or E):`;
        const queryType = classifyQuery(qa.question);
        const routed = routeAnswerModel(queryType);
        const activeModel = routed ? routed.model : answerModel;
        const activeSystem = routed?.promptSuffix ? `${ANSWER_PROMPT} ${routed.promptSuffix}` : ANSWER_PROMPT;
        _routedThisQ = { model: activeModel, queryType };
        predicted = await callLLM(activeModel, activeSystem, userPrompt, 10, 0, {
          cacheKey: 'demiurge:clonemem:answer:v1',
        });
        predicted_choice = parseChoiceLetter(predicted);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const correct = predicted_choice === qa.correct_choice_id.toUpperCase();
      const total_ms = performance.now() - totalStart;
      allResults.push({
        qid: qa.id,
        person_id: persona.person_id,
        question_type: qa.question_type,
        dimension: qa.dimension,
        model_used: _routedThisQ.model,
        query_type: _routedThisQ.queryType,
        question: qa.question,
        expected_choice: qa.correct_choice_id,
        predicted_choice,
        predicted_full: predicted,
        correct,
        retrieved_count,
        retrieved_ids,
        context_text_len,
        retrieval_ms,
        total_ms,
        error,
      });
      if (qaIdx % 5 === 0) {
        const sofar = allResults.filter((r) => r.person_id === persona.person_id);
        const accSofar = sofar.filter((r) => r.correct).length / sofar.length;
        console.log(`  [${qaIdx}/${persona.qa_items.length}] running acc ${(accSofar * 100).toFixed(1)}%`);
      }
    }

    if (typeof (repo as any).close === 'function') (repo as any).close();
  }

  // Aggregate
  const total = allResults.length;
  const correct = allResults.filter((r) => r.correct).length;
  const perDimension: Record<string, { total: number; correct: number; accuracy: number }> = {};
  const perQuestionType: Record<string, { total: number; correct: number; accuracy: number }> = {};
  const perPersona: Record<string, { total: number; correct: number; accuracy: number }> = {};
  let totalRetMs = 0;
  for (const r of allResults) {
    totalRetMs += r.retrieval_ms;
    for (const [bucket, key] of [
      [perDimension, r.dimension],
      [perQuestionType, r.question_type],
      [perPersona, r.person_id],
    ] as Array<[typeof perDimension, string]>) {
      bucket[key] = bucket[key] ?? { total: 0, correct: 0, accuracy: 0 };
      bucket[key]!.total += 1;
      if (r.correct) bucket[key]!.correct += 1;
    }
  }
  for (const bucket of [perDimension, perQuestionType, perPersona]) {
    for (const k of Object.keys(bucket)) {
      bucket[k]!.accuracy = bucket[k]!.total > 0 ? bucket[k]!.correct / bucket[k]!.total : 0;
    }
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: CloneMemReport = {
    benchmark: 'clonemem',
    upstream: 'https://github.com/AvatarMemory/CloneMemBench',
    timestamp: new Date().toISOString(),
    commit,
    config: { mode, tier, answerModel, judgeModel, maxRules, seed, personasUsed: personasToRun.length },
    summary: {
      totalQuestions: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      perDimension,
      perQuestionType,
      perPersona,
      meanRetrievalMs: total > 0 ? totalRetMs / total : 0,
    },
    results: allResults,
  };

  const out = resolve(
    process.cwd(),
    'benchmark-results',
    `clonemem-${tier}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n  → wrote ${out}`);

  console.log('\n=== Final scores ===');
  console.log(`  Overall:        ${(report.summary.accuracy * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`  Mean ret ms:    ${report.summary.meanRetrievalMs.toFixed(1)}`);
  for (const [k, v] of Object.entries(perDimension)) {
    console.log(`  dim ${k.padEnd(12)}: ${(v.accuracy * 100).toFixed(1)}% (${v.correct}/${v.total})`);
  }
  for (const [k, v] of Object.entries(perQuestionType)) {
    console.log(`  qtype ${k.padEnd(15)}: ${(v.accuracy * 100).toFixed(1)}% (${v.correct}/${v.total})`);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
