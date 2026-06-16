#!/usr/bin/env npx tsx
/**
 * Cat 4 (single-hop) only benchmark with v2 extraction.
 * Saves after EVERY question so process death doesn't lose data.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = resolve(__dirname, '../benchmark-results/bench-v2-cat4.json');

async function main() {
  const maxRules = 25;
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

  const dataset = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json'), 'utf8'),
  );
  const facts = JSON.parse(readFileSync(resolve(__dirname, '../benchmark-results/extraction-v2.json'), 'utf8'));
  const conv = dataset[0];

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { computeF1 } = await import('../src/benchmark/locomo-official-seeder.js');

  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, config);

  let seeded = 0;
  for (const fact of facts) {
    try {
      const r = await dispatch.addMemory({ claim: fact.claim, subject: fact.subject, source: 'user', confidence: 0.9 });
      if (r.action !== 'rejected') seeded++;
    } catch {
      /* skip */
    }
  }

  // Filter Cat 4 only
  const cat4Qs = conv.qa.filter((q: any) => q.category === 4 && q.answer);
  console.log(`Seeded: ${seeded}, Cat 4 questions: ${cat4Qs.length}`);

  // Resume from partial results if they exist
  let results: any[] = [];
  let startIdx = 0;
  if (existsSync(RESULT_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
      if (existing.results && existing.results.length > 0) {
        results = existing.results;
        startIdx = results.length;
        console.log(`Resuming from question ${startIdx}`);
      }
    } catch {
      /* start fresh */
    }
  }

  for (let i = startIdx; i < cat4Qs.length; i++) {
    const qa = cat4Qs[i];
    try {
      const searchResult = await dispatch.search(qa.question, maxRules);

      const ansResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          temperature: 0,
          system: `You are answering questions about a user based on memory context. Answer concisely.\n\nContext:\n${searchResult.contextText}`,
          messages: [{ role: 'user', content: qa.question }],
        }),
      });
      const predicted = ((await ansResp.json()) as any).content?.[0]?.text ?? '';

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
      const correct =
        ((await judgeResp.json()) as any).content?.[0]?.text?.toLowerCase().trim().startsWith('yes') ?? false;

      results.push({
        question: qa.question,
        expected: String(qa.answer),
        predicted,
        correct,
        f1: computeF1(predicted, String(qa.answer)),
      });

      const soFar = results.filter((r: any) => r.correct).length;
      console.log(
        `[${i + 1}/${cat4Qs.length}] ${correct ? 'OK' : 'XX'} | ${((soFar / results.length) * 100).toFixed(1)}% | ${qa.question.substring(0, 60)}`,
      );

      // Save after every question
      writeFileSync(RESULT_FILE, JSON.stringify({ category: 4, results, partial: i < cat4Qs.length - 1 }, null, 2));
    } catch (err) {
      console.error(`Q${i}: ERROR`, err instanceof Error ? err.message : err);
      results.push({ question: qa.question, expected: String(qa.answer), predicted: '', correct: false, f1: 0 });
      writeFileSync(RESULT_FILE, JSON.stringify({ category: 4, results, partial: true }, null, 2));
    }
  }

  const correct = results.filter((r: any) => r.correct).length;
  console.log(`\n=== CAT 4 SINGLE-HOP FINAL ===`);
  console.log(`J-Score: ${((correct / results.length) * 100).toFixed(1)}% (${correct}/${results.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
