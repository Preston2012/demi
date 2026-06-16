/**
 * S49 retrieval comparison: query "What allergies does the user have" before vs after.
 * Shows what the bi-temporal filter and current-state classification do
 * to the retrieved candidate list.
 */
async function main() {
  process.env.TEST_MODE = 'true';
  process.env.DEMIURGE_API_KEY = 'demo-' + 'a'.repeat(28);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'error';
  process.env.BI_TEMPORAL_ENABLED = 'true';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, config);

  const facts = [
    { claim: 'I am allergic to penicillin.', validFrom: '2024-01-01T00:00:00Z' },
    { claim: 'I work as a software engineer at Acme Corp.', validFrom: '2024-01-02T00:00:00Z' },
    { claim: 'I live in Reno, Nevada.', validFrom: '2024-01-03T00:00:00Z' },
    { claim: 'My favorite movie is The Princess Bride.', validFrom: '2024-01-04T00:00:00Z' },
    { claim: 'I play guitar; my main guitar is a 2018 Telecaster.', validFrom: '2024-01-05T00:00:00Z' },
  ];
  for (const f of facts) {
    await dispatch.addMemory({ ...f, subject: 'user', source: 'user', confidence: 0.95 });
  }

  console.log('--- DB rows ---');
  const dbAccessor = (repo as { getDatabase?: () => unknown }).getDatabase;
  if (dbAccessor) {
    const db = dbAccessor.call(repo) as {
      prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
    };
    const rows = db.prepare('SELECT id, claim, valid_from, valid_at, invalid_at FROM memories').all() as any[];
    for (const r of rows) {
      console.log(
        `  ${r.id.slice(0, 8)} valid_from=${r.valid_from} valid_at=${r.valid_at} invalid_at=${r.invalid_at} | ${r.claim.slice(0, 50)}`,
      );
    }
  }

  console.log('\n--- Query: "What allergies does the user have?" ---');
  const r1 = await dispatch.search('What allergies does the user have?', 10);
  const cands = (r1 as any).raw?.candidates ?? [];
  console.log(`  candidates: ${cands.length}`);
  for (const c of cands) {
    console.log(`    score=${c.score?.toFixed(3) ?? '?'} | ${c.record?.claim?.slice(0, 60) ?? '?'}`);
  }
  console.log(`  context preview: ${(r1 as any).contextText?.slice(0, 200) ?? ''}`);

  if (typeof (repo as any).close === 'function') (repo as any).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
