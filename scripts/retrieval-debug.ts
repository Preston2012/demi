#!/usr/bin/env npx tsx
/**
 * Direct retrieval debug: seed v2 facts, then query specific failing questions
 * and show ALL returned facts with scores.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);

  const facts = JSON.parse(readFileSync(resolve(__dirname, '../benchmark-results/extraction-v2.json'), 'utf8'));

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');

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
  console.log(`Seeded: ${seeded}/${facts.length}\n`);

  // Debug specific failing queries
  const queries = [
    { q: "What is Caroline's identity?", expected: 'transgender woman' },
    { q: 'Where did Caroline move from 4 years ago?', expected: 'Sweden' },
    { q: "What is Caroline's relationship status?", expected: 'single' },
    { q: 'What did Caroline research?', expected: 'adoption agencies' },
    { q: 'What activities does Melanie partake in?', expected: 'pottery, camping, painting, swimming' },
    { q: 'What pets does Melanie have?', expected: 'dog, cat' },
  ];

  for (const { q, expected } of queries) {
    console.log(`Q: "${q}"`);
    console.log(`Expected: ${expected}`);
    const result = await dispatch.search(q, 25);
    console.log(`Retrieved ${result.payload.memories.length} facts:`);
    result.payload.memories.slice(0, 10).forEach((m: any, i: number) => {
      console.log(`  ${i + 1}. [${m.score.toFixed(3)}] ${m.claim.substring(0, 100)}`);
    });

    // Check if expected answer is in ANY fact in the store
    const answerTokens = expected
      .toLowerCase()
      .split(/[, ]+/)
      .filter((t) => t.length > 2);
    const allMemories = result.raw?.candidates || [];
    console.log(`  --- All candidates: ${allMemories.length}`);

    // Search all stored facts for the answer
    const matchingFacts = facts.filter((f: any) => {
      const claim = f.claim.toLowerCase();
      return answerTokens.some((t: string) => claim.includes(t));
    });
    console.log(`  --- Facts in store containing answer tokens: ${matchingFacts.length}`);
    matchingFacts.slice(0, 3).forEach((f: any) => console.log(`    "${f.claim.substring(0, 100)}"`));
    console.log();
  }

  await repo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
