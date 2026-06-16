/**
 * S49 diagnostic: verify bi-temporal supersession fires correctly on write side.
 * Stores Acme job, then Globex job (newer validFrom), inspects:
 *   - response.supersedes, should contain Acme's ID
 *   - DB invalid_at column on Acme, should be 2024-06-01T00:00:00Z
 */
import { performance } from 'node:perf_hooks';

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

  console.log('--- Writing Acme job ---');
  const acme = await dispatch.addMemory({
    claim: 'I work as a software engineer at Acme Corp.',
    subject: 'user',
    source: 'user',
    confidence: 0.95,
    validFrom: '2024-01-02T00:00:00Z',
  });
  console.log('  acme write:', JSON.stringify(acme));

  console.log('\n--- Writing Globex job (newer validFrom) ---');
  const globex = await dispatch.addMemory({
    claim: 'I work at Globex Industries as a senior engineer.',
    subject: 'user',
    source: 'user',
    confidence: 0.95,
    validFrom: '2024-06-01T00:00:00Z',
  });
  console.log('  globex write:', JSON.stringify(globex));

  console.log('\n--- DB inspect: invalid_at on Acme + Globex ---');
  const dbAccessor = (repo as { getDatabase?: () => unknown }).getDatabase;
  if (dbAccessor) {
    const db = dbAccessor.call(repo) as {
      prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
    };
    const rows = db
      .prepare('SELECT id, claim, valid_from, invalid_at FROM memories ORDER BY valid_from')
      .all() as any[];
    for (const r of rows) {
      console.log(
        `  ${r.id.slice(0, 8)}  valid_from=${r.valid_from}  invalid_at=${r.invalid_at}  claim="${r.claim.slice(0, 50)}..."`,
      );
    }
  }

  console.log('\n--- Retrieval test: "Where does the user work?" ---');
  const search = await dispatch.search('Where does the user work?', 10);
  console.log(`  retrieved ${(search as any).raw?.candidates?.length ?? 0} candidates`);
  console.log(`  query type: ${(search as any).raw?.queryType ?? 'unknown'}`);
  console.log('  context preview:');
  console.log('    ' + ((search as any).contextText ?? '').split('\n').slice(0, 3).join('\n    '));

  console.log('\n--- Retrieval test: "Where does the user currently work?" ---');
  const search2 = await dispatch.search('Where does the user currently work?', 10);
  console.log(`  retrieved ${(search2 as any).raw?.candidates?.length ?? 0} candidates`);
  console.log(`  query type: ${(search2 as any).raw?.queryType ?? 'unknown'}`);
  console.log('  context preview:');
  console.log('    ' + ((search2 as any).contextText ?? '').split('\n').slice(0, 3).join('\n    '));

  if (typeof (repo as any).close === 'function') (repo as any).close();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
