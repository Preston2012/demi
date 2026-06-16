#!/usr/bin/env npx tsx
/**
 * Retrieval Recall Diagnostic
 *
 * For each LOCOMO question, checks if the gold answer text appears
 * in ANY of the top-N retrieved facts. This measures retrieval ceiling:
 * if the answer isn't retrieved, no prompt can fix it.
 *
 * Usage: npx tsx scripts/retrieval-recall.ts --max-rules 25
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;
  const limitConvosIdx = args.indexOf('--limit-convos');
  const limitConvos = limitConvosIdx !== -1 ? parseInt(args[limitConvosIdx + 1] ?? '1', 10) : 1;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embeddings loaded');

  const datasetPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json');
  const factsPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/extracted-facts.json');

  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const factsCache = JSON.parse(readFileSync(factsPath, 'utf-8'));

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { seedConversationFacts } = await import('../src/benchmark/locomo-official-seeder.js');

  const CATEGORY_LABELS: Record<number, string> = {
    1: 'Multi-hop',
    2: 'Temporal',
    3: 'Open-domain',
    4: 'Single-hop',
    5: 'Adversarial',
  };

  const catStats: Record<number, { total: number; recalled: number }> = {};

  for (let ci = 0; ci < Math.min(limitConvos, dataset.length); ci++) {
    const conv = dataset[ci];
    const cachedFacts = factsCache.find((f: any) => f.conversation_index === ci);
    if (!cachedFacts) continue;

    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    const seeded = await seedConversationFacts(dispatch, cachedFacts.facts, ci);
    console.log(`\n[Conv ${ci}] ${seeded} memories seeded, maxRules=${maxRules}`);

    for (const qa of conv.qa) {
      if (qa.category === 5) continue; // skip adversarial
      const answer = String(qa.answer || '').toLowerCase();
      if (!answer || answer === 'n/a') continue;

      const searchResult = await dispatch.search(qa.question, maxRules);
      const retrievedText = searchResult.payload.memories.map((m: any) => m.claim.toLowerCase()).join(' ');

      // Check if key answer tokens appear in retrieved facts
      const answerTokens = answer.split(/\s+/).filter((t: string) => t.length > 2);
      const matchedTokens = answerTokens.filter((t: string) => retrievedText.includes(t));
      const recall = answerTokens.length > 0 ? matchedTokens.length / answerTokens.length : 0;
      const recalled = recall >= 0.5; // at least half the answer tokens found

      if (!catStats[qa.category]) catStats[qa.category] = { total: 0, recalled: 0 };
      catStats[qa.category].total++;
      if (recalled) catStats[qa.category].recalled++;

      // Log misses for first 5 per category
      if (!recalled && catStats[qa.category].total - catStats[qa.category].recalled <= 3) {
        console.log(`  MISS [${CATEGORY_LABELS[qa.category]}]: "${qa.question}"`);
        console.log(`    Answer: "${answer}"`);
        console.log(`    Matched: ${matchedTokens.join(', ') || '(none)'} / ${answerTokens.join(', ')}`);
      }
    }

    await repo.close();
  }

  // Summary
  console.log('\n========== RETRIEVAL RECALL ==========');
  console.log(`maxRules: ${maxRules}\n`);
  let totalAll = 0,
    recalledAll = 0;
  for (const [cat, stats] of Object.entries(catStats).sort(([a], [b]) => Number(a) - Number(b))) {
    const pct = ((stats.recalled / stats.total) * 100).toFixed(1);
    console.log(`  ${CATEGORY_LABELS[Number(cat)]}: ${stats.recalled}/${stats.total} = ${pct}%`);
    totalAll += stats.total;
    recalledAll += stats.recalled;
  }
  console.log(`\n  Overall: ${recalledAll}/${totalAll} = ${((recalledAll / totalAll) * 100).toFixed(1)}%`);
  console.log(`\n  This is the CEILING. No prompt can score higher than retrieval recall.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
