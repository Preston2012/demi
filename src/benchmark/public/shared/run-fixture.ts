/**
 * Generic runner that takes a normalized PublicBenchFixture and produces a
 * PublicBenchReport. Per-bench adapters convert upstream JSON into the
 * normalized shape, then call runFixture.
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type { PublicBenchFixture, PublicBenchReport, PublicBenchQuestionResult } from './runner-base.js';

const MAB_LIKE_JUDGE = `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: {question}
Gold answer: {gold}
System answer: {predicted}

Does the system answer correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.`;

export async function runFixture(opts: {
  fixture: PublicBenchFixture;
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
  /** Override the default judge prompt template */
  judgePromptTemplate?: string;
  /** Per-question answer prompt; default 'Answer using the context. Be concise.' */
  answerPromptTemplate?: string;
}): Promise<PublicBenchReport> {
  const {
    fixture,
    answerModel,
    judgeModel,
    maxRules,
    seed,
    callLLM,
    outputPath,
    judgePromptTemplate = MAB_LIKE_JUDGE,
    answerPromptTemplate = 'Answer the question using only the provided memory context. Be concise. If the context does not contain the answer, say so.',
  } = opts;

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

  const allResults: PublicBenchQuestionResult[] = [];

  for (const scenario of fixture.scenarios) {
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    let seeded = 0;
    for (const f of scenario.facts) {
      try {
        const result = await dispatch.addMemory({
          claim: f.claim,
          subject: f.subject ?? 'user',
          source: f.source ?? 'user',
          confidence: 0.95,
          validFrom: f.validFrom,
        });
        if (result.action !== 'rejected') seeded++;
      } catch (err) {
        console.error('SEED_ERROR', scenario.scenario_id, err instanceof Error ? err.message : err);
      }
    }
    console.log(
      `[${scenario.scenario_id}] seeded ${seeded}/${scenario.facts.length} facts, ${scenario.queries.length} queries`,
    );

    for (const q of scenario.queries) {
      const totalStart = performance.now();
      let predicted = '';
      let retrieved_count = 0;
      let retrieved_ids: string[] = [];
      let context_text_len = 0;
      let retrieval_ms = 0;
      let error: string | undefined;
      try {
        const tStart = performance.now();
        const search = await dispatch.search(q.question, maxRules);
        retrieval_ms = performance.now() - tStart;
        retrieved_count = (search as any).raw?.candidates?.length ?? 0;
        retrieved_ids = ((search as any).raw?.candidates ?? []).map((c: any) => c.id);
        context_text_len = search.contextText?.length ?? 0;

        const userPrompt = `Context:\n${search.contextText}\n\nQuestion: ${q.question}`;
        // S65 prompt-audit pass 2: stable cacheKey for product-bench answer pass.
        predicted = await callLLM(answerModel, answerPromptTemplate, userPrompt, 200, 0, {
          cacheKey: 'demiurge:product-bench:answer:v1',
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const goldStr = Array.isArray(q.expected) ? q.expected.join(' | ') : q.expected;
      const judgePrompt = judgePromptTemplate
        .replace('{question}', q.question)
        .replace('{gold}', goldStr)
        .replace('{predicted}', predicted);
      let judgeOut = '';
      try {
        // S65 prompt-audit pass 2: tightened system prompt (was generic
        // 'strict benchmark evaluator' without yes/no contract) + cacheKey.
        judgeOut = await callLLM(
          judgeModel,
          'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
          judgePrompt,
          5,
          0,
          { cacheKey: 'demiurge:product-bench:judge:v1' },
        );
      } catch (err) {
        error = error ?? (err instanceof Error ? err.message : String(err));
      }
      const correct = /^\s*yes/i.test(judgeOut.trim());

      const total_ms = performance.now() - totalStart;
      allResults.push({
        qid: q.qid,
        category: q.category,
        question: q.question,
        expected: q.expected,
        predicted,
        correct,
        retrieved_count,
        retrieved_ids,
        context_text_len,
        retrieval_ms,
        total_ms,
        error,
      });
    }

    if (typeof (repo as any).close === 'function') (repo as any).close();
  }

  const total = allResults.length;
  const correct = allResults.filter((r) => r.correct).length;
  const perCategory: Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }> = {};
  for (const r of allResults) {
    const k = r.category ?? '_uncategorised';
    perCategory[k] = perCategory[k] ?? { total: 0, correct: 0, accuracy: 0, meanRetrievalMs: 0 };
    perCategory[k].total += 1;
    if (r.correct) perCategory[k].correct += 1;
    perCategory[k].meanRetrievalMs += r.retrieval_ms;
  }
  for (const k of Object.keys(perCategory)) {
    const c = perCategory[k]!;
    c.accuracy = c.total > 0 ? c.correct / c.total : 0;
    c.meanRetrievalMs = c.total > 0 ? c.meanRetrievalMs / c.total : 0;
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: PublicBenchReport = {
    benchmark: fixture.bench_id,
    upstream_version: fixture.upstream_version,
    timestamp: new Date().toISOString(),
    commit,
    config: { mode: fixture.mode, answerModel, judgeModel, maxRules, seed },
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
  console.log(`  → wrote ${out}`);
  return report;
}
