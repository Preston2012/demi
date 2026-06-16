#!/usr/bin/env npx tsx
/**
 * LOCOMO Full Benchmark with custom extraction.
 * Uses pre-saved extraction-v2.json, seeds through pipeline, runs full QA.
 * Processes in batches of 40 to avoid process death.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Multi-hop',
  2: 'Temporal',
  3: 'Open-domain',
  4: 'Single-hop',
  5: 'Adversarial (EXCLUDED)',
};

interface QuestionResult {
  category: number;
  question: string;
  expected: string;
  predicted: string;
  correct: boolean;
  f1: number;
}

async function main() {
  const args = process.argv.slice(2);
  const extractionFile = args.includes('--extraction')
    ? args[args.indexOf('--extraction') + 1]
    : 'benchmark-results/extraction-v2.json';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY required');
    process.exit(1);
  }

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);

  const datasetPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const conv = dataset[0];
  const facts = JSON.parse(readFileSync(resolve(__dirname, '..', extractionFile), 'utf8'));

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { computeF1 } = await import('../src/benchmark/locomo-official-seeder.js');

  // Seed
  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, config);

  let seeded = 0,
    rejected = 0;
  for (const fact of facts) {
    try {
      const r = await dispatch.addMemory({ claim: fact.claim, subject: fact.subject, source: 'user', confidence: 0.9 });
      if (r.action !== 'rejected') seeded++;
      else rejected++;
    } catch {
      rejected++;
    }
  }
  console.log(`Seeded: ${seeded}, rejected: ${rejected}, maxRules: ${maxRules}`);

  // Filter scored questions
  const scoredQa = conv.qa.filter((q: any) => q.category !== 5 && q.answer);
  console.log(`Scored questions: ${scoredQa.length}\n`);

  const results: QuestionResult[] = [];
  const resultFile = resolve(__dirname, `../benchmark-results/bench-v2-mr${maxRules}-${Date.now()}.json`);

  for (let i = 0; i < scoredQa.length; i++) {
    const qa = scoredQa[i];
    try {
      const searchResult = await dispatch.search(qa.question, maxRules);
      const contextText = searchResult.contextText;

      // Answer
      const ansResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          temperature: 0,
          system: `You are answering questions about a user based on memory context. Answer concisely.\n\nContext:\n${contextText}`,
          messages: [{ role: 'user', content: qa.question }],
        }),
      });
      const ansData = (await ansResp.json()) as any;
      const predicted = ansData.content?.[0]?.text ?? '';

      // Judge
      const judgeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".\n\nQuestion: ${qa.question}\nGold answer: ${qa.answer}\nSystem response: ${predicted}\n\nDoes the system response correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.`,
            },
          ],
        }),
      });
      const judgeData = (await judgeResp.json()) as any;
      const correct = (judgeData.content?.[0]?.text ?? '').toLowerCase().trim().startsWith('yes');

      const f1 = computeF1(predicted, String(qa.answer));
      results.push({
        category: qa.category,
        question: qa.question,
        expected: String(qa.answer),
        predicted,
        correct,
        f1,
      });

      if (i < 10 || (i + 1) % 25 === 0) {
        const soFar = results.filter((r) => r.correct).length;
        console.log(
          `  [${i + 1}/${scoredQa.length}] ${correct ? 'OK' : 'XX'} | Running: ${((soFar / results.length) * 100).toFixed(1)}% | Q: ${qa.question.substring(0, 50)}`,
        );
      }

      // Save progress every 25 questions
      if ((i + 1) % 25 === 0) {
        writeFileSync(resultFile, JSON.stringify({ results, partial: true }, null, 2));
      }
    } catch (err) {
      console.error(`  Q${i}: ERROR`, err instanceof Error ? err.message : err);
      results.push({
        category: qa.category,
        question: qa.question,
        expected: String(qa.answer),
        predicted: '',
        correct: false,
        f1: 0,
      });
    }
  }

  // Final report
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  console.log(`\n========== V2 EXTRACTION BENCHMARK ==========`);
  console.log(`J-Score: ${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`Mean F1: ${((results.reduce((s, r) => s + r.f1, 0) / total) * 100).toFixed(1)}%`);

  for (let cat = 1; cat <= 4; cat++) {
    const cr = results.filter((r) => r.category === cat);
    if (!cr.length) continue;
    const cc = cr.filter((r) => r.correct).length;
    console.log(`  ${CATEGORY_LABELS[cat]}: ${((cc / cr.length) * 100).toFixed(1)}% (${cc}/${cr.length})`);
  }

  writeFileSync(
    resultFile,
    JSON.stringify(
      {
        config: { maxRules, extraction: extractionFile },
        results,
        summary: { jScore: correct / total, total, correct },
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved: ${resultFile}`);

  await repo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
