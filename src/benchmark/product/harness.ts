/**
 * Generic runner for the product-correctness bench suite.
 *
 * Per scenario:
 *   - fresh `:memory:` repo
 *   - seed all facts via dispatch.addMemory (validFrom honored)
 *   - run all queries: dispatch.search → callLLM → optional bench-specific
 *     scorer (defaults to LLM judge with paraphrase tolerance)
 *   - aggregate per-category + bench-specific extras
 *   - write JSON report to benchmark-results/<bench-id>-<mode>-<ts>.json
 *
 * Stale-memory, attribution, and paraphrase runners feed normalized
 * ProductFixtures into runProductBench. Difficulty injection composes
 * augmentations and re-runs the BASE bench's runFixture (not this harness).
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

import type { ProductFixture, ProductQuestionResult, ProductReport, ProductScenario } from './types.js';
import { aggregatePerCategory, buildSemanticJudgePrompt, parseYesNo } from './scorer.js';

export interface RunProductBenchOpts {
  fixture: ProductFixture;
  answerModel: string;
  judgeModel: string;
  maxRules: number;
  seed?: number;
  callLLM: (
    model: string,
    system: string,
    user: string,
    maxTokens: number,
    temp: number,
    opts?: { cacheKey?: string },
  ) => Promise<string>;
  outputPath?: string;
  /**
   * Optional bench-specific scorer. Receives the question, predicted answer,
   * search result, and bench-specific extras. Default: LLM semantic judge.
   * Returns `{correct, outcome?, extra?}` so per-bench logic (e.g. stale-memory
   * outcome categories, attribution memory_id match) can override the default.
   */
  customScorer?: ScorerFn;
  /** Override the default answer prompt. */
  answerPromptTemplate?: string;
  /** Override the default judge prompt. */
  judgePromptTemplate?: string;
  /** Optional progress logger. Called once per scenario. */
  onProgress?: (idx: number, total: number, scenario: ProductScenario) => void;
}

export interface ScorerInput {
  scenario: ProductScenario;
  query: ProductScenario['queries'][number];
  predicted: string;
  retrievedIds: string[];
  retrievedClaims: string[];
  /** The bench's callLLM (judge model), useful for LLM-based custom scorers. */
  callLLM: (
    model: string,
    system: string,
    user: string,
    maxTokens: number,
    temp: number,
    opts?: { cacheKey?: string },
  ) => Promise<string>;
  judgeModel: string;
  judgePromptTemplate?: string;
}

export interface ScorerOutput {
  correct: boolean;
  outcome?: string;
  extra?: Record<string, unknown>;
}

export type ScorerFn = (input: ScorerInput) => Promise<ScorerOutput>;

const DEFAULT_ANSWER_PROMPT =
  'Answer the question using only the provided memory context. Be concise. ' +
  'If the context does not contain the answer, say so explicitly. ' +
  // S55: handle age-aware annotations from inject/index.ts.
  "Memories may be annotated with [as-of YYYY-MM-DD] when the fact is potentially stale for current-state questions. If multiple memories about the same subject are present, prefer the one with the most recent date (annotated or not) and answer with that fact. If ALL retrieved memories about the subject are annotated [as-of YYYY-MM-DD] with dates years before the question time, AND no fresher fact is present, do not restate the old value as current. Instead respond exactly: 'I do not have current information about this.'";

async function defaultScorer(input: ScorerInput): Promise<ScorerOutput> {
  const prompt = buildSemanticJudgePrompt(
    input.query.question,
    input.query.expected,
    input.predicted,
    input.judgePromptTemplate ? { promptTemplate: input.judgePromptTemplate } : {},
  );
  // S65 prompt-audit pass 2: tightened judge system.
  const judge = await input.callLLM(
    input.judgeModel,
    'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
    prompt,
    5,
    0,
  );
  return { correct: parseYesNo(judge), outcome: parseYesNo(judge) ? 'correct' : 'wrong' };
}

export async function runProductBench(opts: RunProductBenchOpts): Promise<ProductReport> {
  const {
    fixture,
    answerModel,
    judgeModel,
    maxRules,
    seed,
    callLLM,
    outputPath,
    customScorer,
    answerPromptTemplate = DEFAULT_ANSWER_PROMPT,
    judgePromptTemplate,
    onProgress,
  } = opts;
  const scorer = customScorer ?? defaultScorer;

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
  } catch {
    // Embeddings unavailable → lexical-only retrieval. Tolerated for benches.
  }

  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');

  const allResults: ProductQuestionResult[] = [];

  for (let i = 0; i < fixture.scenarios.length; i++) {
    const scenario = fixture.scenarios[i]!;
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    let seeded = 0;
    for (const f of scenario.facts) {
      try {
        const r = await dispatch.addMemory({
          claim: f.claim,
          subject: f.subject ?? 'user',
          source: f.source ?? 'user',
          confidence: 0.95,
          validFrom: f.validFrom,
        });
        if (r.action !== 'rejected') seeded++;
      } catch {
        // Continue seeding remaining facts. Final accuracy reflects partial seed.
      }
    }
    void seeded;

    for (const q of scenario.queries) {
      const totalStart = performance.now();
      let predicted = '';
      let retrieved_count = 0;
      let retrieved_ids: string[] = [];
      let retrieved_claims: string[] = [];
      let retrieval_ms = 0;
      let error: string | undefined;
      let scoreOut: ScorerOutput = { correct: false };

      try {
        const tStart = performance.now();
        const search = await dispatch.search(q.question, maxRules);
        retrieval_ms = performance.now() - tStart;
        retrieved_count = search.raw.candidates.length;
        retrieved_ids = search.raw.candidates.map((c) => c.id);
        retrieved_claims = search.raw.candidates.map((c) => c.candidate.record.claim);

        const userPrompt = `Context:\n${search.contextText}\n\nQuestion: ${q.question}`;
        // S65 prompt-audit pass 2: cacheKey added.
        predicted = await callLLM(answerModel, answerPromptTemplate, userPrompt, 200, 0, {
          cacheKey: 'demiurge:product-harness:answer:v1',
        });

        const scorerInput: ScorerInput = {
          scenario,
          query: q,
          predicted,
          retrievedIds: retrieved_ids,
          retrievedClaims: retrieved_claims,
          callLLM,
          judgeModel,
        };
        if (judgePromptTemplate !== undefined) scorerInput.judgePromptTemplate = judgePromptTemplate;
        scoreOut = await scorer(scorerInput);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const total_ms = performance.now() - totalStart;
      const result: ProductQuestionResult = {
        qid: q.qid,
        scenario_id: scenario.scenario_id,
        question: q.question,
        expected: q.expected,
        predicted,
        correct: scoreOut.correct,
        retrieved_count,
        retrieved_ids,
        retrieved_claims,
        retrieval_ms,
        total_ms,
      };
      if (q.category !== undefined) result.category = q.category;
      if (scoreOut.outcome !== undefined) result.outcome = scoreOut.outcome;
      if (scoreOut.extra !== undefined) result.extra = scoreOut.extra;
      if (error !== undefined) result.error = error;
      allResults.push(result);
    }

    if (typeof (repo as { close?: () => void }).close === 'function') {
      (repo as { close: () => void }).close();
    }
    if (onProgress) onProgress(i + 1, fixture.scenarios.length, scenario);
  }

  const total = allResults.length;
  const correct = allResults.filter((r) => r.correct).length;
  const perCategory = aggregatePerCategory(allResults);

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: ProductReport = {
    benchmark: fixture.bench_id,
    upstream_version: fixture.upstream_version,
    timestamp: new Date().toISOString(),
    commit,
    config: { mode: fixture.mode, answerModel, judgeModel, maxRules, ...(seed !== undefined ? { seed } : {}) },
    summary: { totalQuestions: total, correct, accuracy: total > 0 ? correct / total : 0, perCategory },
    results: allResults,
  };

  const out =
    outputPath ??
    resolve(
      process.cwd(),
      'benchmark-results',
      `${fixture.bench_id}-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  return report;
}
