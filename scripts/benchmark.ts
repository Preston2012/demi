#!/usr/bin/env npx tsx
/**
 * Demiurge Benchmark CLI
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts locomo-v1           # Run LOCOMO benchmark
 *   npx tsx scripts/benchmark.ts self-play            # Run self-play evaluation
 *   npx tsx scripts/benchmark.ts smoke-test           # Run smoke test
 *   npx tsx scripts/benchmark.ts longmemeval-extract  # Extract facts from LongMemEval sessions (one-time)
 *   npx tsx scripts/benchmark.ts longmemeval-s        # Run LongMemEval S benchmark
 *   npx tsx scripts/benchmark.ts longmemeval-s --limit 10  # Run first 10 questions only
 *
 * Environment:
 *   AUTH_TOKEN (required)
 *   DB_PATH (optional, defaults to :memory: for benchmarks)
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY (required for LLM answer generation)
 *
 * Output: JSON + text report in ./benchmark-results/
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const command = process.argv[2];
  if (!command) {
    console.error(
      'Usage: npx tsx scripts/benchmark.ts <corpus-name|self-play|longmemeval-extract|longmemeval-s|locomo-official>',
    );
    process.exit(1);
  }

  // locomo-official delegates to its own script
  if (command === 'locomo-official') {
    const { execSync } = await import('node:child_process');
    const args = process.argv.slice(3).join(' ');
    execSync(`npx tsx scripts/benchmark-locomo-official.ts ${args}`, {
      stdio: 'inherit',
      cwd: resolve(__dirname, '..'),
      env: process.env,
    });
    return;
  }

  // Set defaults for benchmark mode
  process.env.AUTH_TOKEN = process.env.AUTH_TOKEN || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const repo = new SqliteMemoryRepository(config);
  await repo.initialize();

  // Initialize embedding model for vector search
  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable:', e instanceof Error ? e.message : String(e));
  }

  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const dispatch = createCoreDispatch(repo, config);

  if (command === 'self-play') {
    console.log('Running self-play evaluation...');
    const { runSelfPlay } = await import('../src/learn/self-play.js');
    const result = await runSelfPlay(repo, config);
    console.log('\nSelf-Play Results:');
    console.log(`  Queries: ${result.queriesGenerated}`);
    console.log(`  Passed:  ${result.retrievalsPassed}`);
    console.log(`  Failed:  ${result.retrievalsFailed}`);
    console.log(`  Rate:    ${result.notes}`);
    await repo.close();
    return;
  }

  // --- LongMemEval ---

  if (command === 'longmemeval-extract') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error('ANTHROPIC_API_KEY required for fact extraction');
      process.exit(1);
    }

    const datasetPath = resolve(__dirname, '../fixtures/benchmark/longmemeval/longmemeval_s_cleaned.json');
    const cachePath = resolve(__dirname, '../fixtures/benchmark/longmemeval/extracted-facts-s.json');

    const { loadLongMemEvalDataset } = await import('../src/benchmark/longmemeval-adapter.js');
    const { extractAllFacts } = await import('../src/benchmark/longmemeval-extractor.js');

    console.log('Loading LongMemEval S dataset...');
    const entries = loadLongMemEvalDataset(datasetPath);
    console.log(`  ${entries.length} questions loaded`);

    const startFrom = parseInt(process.argv[3] ?? '0', 10);
    console.log(`Extracting facts (starting from question ${startFrom})...`);
    console.log('This will take a while and costs ~$5-15 with Haiku.');

    const cache = await extractAllFacts(entries, cachePath, anthropicKey, {
      batchDelay: 200,
      startFrom,
    });

    console.log(`\nExtraction complete: ${cache.entries.length} questions processed`);
    console.log(`Cache saved to: ${cachePath}`);
    await repo.close();
    return;
  }

  if (command === 'longmemeval-s') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error('ANTHROPIC_API_KEY required for LongMemEval');
      process.exit(1);
    }

    const datasetPath = resolve(__dirname, '../fixtures/benchmark/longmemeval/longmemeval_s_cleaned.json');
    const cachePath = resolve(__dirname, '../fixtures/benchmark/longmemeval/extracted-facts-s.json');
    const outputDir = resolve(__dirname, '../benchmark-results');
    mkdirSync(outputDir, { recursive: true });

    const { loadLongMemEvalDataset, loadExtractedFacts, runLongMemEval } =
      await import('../src/benchmark/longmemeval-adapter.js');

    console.log('Loading LongMemEval S dataset...');
    const entries = loadLongMemEvalDataset(datasetPath);
    console.log(`  ${entries.length} questions`);

    const factsCache = loadExtractedFacts(cachePath);
    if (!factsCache) {
      console.error(`No extracted facts found at ${cachePath}`);
      console.error('Run: npx tsx scripts/benchmark.ts longmemeval-extract');
      process.exit(1);
    }
    console.log(`  ${factsCache.entries.length} questions with extracted facts`);

    const limitArg = process.argv.indexOf('--limit');
    const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1] ?? '500', 10) : undefined;

    console.log('Running LongMemEval benchmark...');
    const report = await runLongMemEval(entries, factsCache, config, {
      maxRules: 20,
      answerFn: createAnswerFn(),
      judgeApiKey: anthropicKey,
      limit,
    });

    // Write report
    const reportPath = resolve(outputDir, `longmemeval-s-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('\n========== LONGMEMEVAL RESULTS ==========');
    console.log(`Dataset:   ${report.dataset}`);
    console.log(`Accuracy:  ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.totalQuestions})`);
    console.log(`Retrieval: mean ${report.meanRetrievalMs.toFixed(1)}ms`);
    console.log(`Total:     mean ${report.meanTotalMs.toFixed(1)}ms`);

    console.log('\nBy category:');
    for (const [cat, stats] of Object.entries(report.byCategory)) {
      console.log(`  ${cat}: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
    }

    const failures = report.results.filter((r) => !r.correct);
    if (failures.length > 0 && failures.length <= 20) {
      console.log(`\nFailed questions (${failures.length}):`);
      for (const f of failures) {
        console.log(`  [${f.question_id}] ${f.question}`);
        console.log(`    Expected: ${f.reference_answer}`);
        console.log(`    Got:      ${f.hypothesis.slice(0, 100)}...`);
      }
    }

    console.log(`\nReport written to: ${reportPath}`);
    await repo.close();
    return;
  }

  // --- LOCOMO corpus benchmark ---
  const { loadCorpus } = await import('../src/benchmark/corpus-loader.js');
  const { seedCorpus, runBenchmark } = await import('../src/benchmark/runner.js');
  const { writeReport } = await import('../src/benchmark/report-writer.js');

  const fixturesDir = resolve(__dirname, '../fixtures/benchmark');
  const outputDir = resolve(__dirname, '../benchmark-results');

  console.log(`Loading corpus: ${command}`);
  const corpus = loadCorpus(fixturesDir, command);
  console.log(`  ${corpus.conversations.length} conversations, ${corpus.questions.length} questions`);

  console.log('Seeding memories...');
  const seeded = await seedCorpus(dispatch, corpus);
  console.log(`  ${seeded} memories seeded`);

  console.log('Running benchmark...');
  const report = await runBenchmark(dispatch, corpus, {
    maxRules: 15,
    killThreshold: 0.73,
    answerFn: createAnswerFn(),
  });

  writeReport(report, outputDir);

  console.log('\n========== BENCHMARK RESULTS ==========');
  console.log(`Corpus:    ${report.corpus}`);
  console.log(`Accuracy:  ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.totalQuestions})`);
  console.log(`Kill line: ${(report.killThreshold * 100).toFixed(1)}%`);
  console.log(`Status:    ${report.killConditionMet ? 'PASSED' : 'FAILED'}`);
  console.log(`Retrieval: mean ${report.meanRetrievalMs.toFixed(1)}ms, p95 ${report.p95RetrievalMs.toFixed(1)}ms`);
  console.log(`Total:     mean ${report.meanTotalMs.toFixed(1)}ms, p95 ${report.p95TotalMs.toFixed(1)}ms`);

  if (!report.killConditionMet) {
    console.log('\nBelow 73% kill threshold.');
    const failures = report.results.filter((r) => !r.correct);
    console.log(`\nFailed questions (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.questionId}] ${f.question}`);
      console.log(`    Missing: ${f.factsMissed.join(', ')}`);
    }
  }

  console.log(`\nReport written to: ${outputDir}`);
  await repo.close();
}

/**
 * Create the LLM answer function.
 * Uses Anthropic if ANTHROPIC_API_KEY is set, else OpenAI, else echoes injection.
 */
function createAnswerFn(): (injectionText: string, question: string) => Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    return async (injectionText: string, question: string) => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: `You are answering questions about a user based on memory context. Answer concisely.\n\n${injectionText}`,
          messages: [{ role: 'user', content: question }],
        }),
      });
      const data = (await response.json()) as { content: { text: string }[] };
      return data.content?.[0]?.text ?? '';
    };
  }

  if (openaiKey) {
    return async (injectionText: string, question: string) => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: `Answer questions about a user based on memory context. Answer concisely.\n\n${injectionText}`,
            },
            { role: 'user', content: question },
          ],
        }),
      });
      const data = (await response.json()) as { choices: { message: { content: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    };
  }

  // Fallback: echo the injection text (useful for testing retrieval without LLM)
  console.warn('No API key set. Using injection echo mode (tests retrieval only).');
  return async (injectionText: string) => injectionText;
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
