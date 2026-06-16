/**
 * Deterministic supersession eval.
 *
 * Single-valued subjects must supersede (recency wins). Multi-valued subjects
 * must accumulate (additive). No LLM (SPOT_CHECK_RATE=0), in-memory DB.
 *
 * Run: node_modules/.bin/tsx scripts/eval-supersession.ts
 *
 * NOTE: TEST 2 (multi-valued guardrail) FAILS before the cardinality gate is
 * applied and PASSES after. TEST 1 passes both before and after. That contrast
 * is the proof the gate works.
 */
process.env.SPOT_CHECK_RATE = '0';

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  dotenv.config({ path: '/root/demiurge-dogfood/.env' });
  dotenv.config({ path: '/root/demiurge/.env' });
  process.env.SPOT_CHECK_RATE = '0';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const emb = await import('../src/embeddings/index.js');
  await emb.initialize(config.modelPath);
  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');

  const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch: any = createCoreDispatch(repo, config);
  const userId = 'eval-supersession';

  const add = (subject: string, claim: string, validFrom: string) =>
    dispatch.addMemory({ subject, claim, source: 'user', confidence: 0.9, validFrom, user_id: userId });

  const stateOf = async (subject: string): Promise<Array<{ claim: string; invalidAt: string | null }>> => {
    const rows: any[] = await repo.getBySubject(subject, 50);
    return rows.map((r) => ({
      claim: String(r.claim),
      invalidAt: (r.invalidAt ?? r.invalid_at ?? null) as string | null,
    }));
  };

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    if (ok) {
      pass++;
      console.log('PASS ' + name);
    } else {
      fail++;
      console.log('FAIL ' + name + ' :: ' + detail);
    }
  };

  // TEST 1: single-valued (location) supersedes. Denver replaces Austin.
  await add('location', 'User lives in Austin, Texas', '2024-01-01T00:00:00Z');
  await add('location', 'User lives in Denver, Colorado', '2024-06-01T00:00:00Z');
  const loc = await stateOf('location');
  const austin = loc.find((r) => /austin/i.test(r.claim));
  const denver = loc.find((r) => /denver/i.test(r.claim));
  check('single-valued supersede: Austin demoted', !!(austin && austin.invalidAt), JSON.stringify(loc));
  check('single-valued current: Denver kept', !!(denver && !denver.invalidAt), JSON.stringify(loc));

  // TEST 2: multi-valued (languages) accumulates. Both kept, neither demoted.
  await add('languages', 'User speaks English', '2024-01-01T00:00:00Z');
  await add('languages', 'User speaks Spanish', '2024-06-01T00:00:00Z');
  const langs = await stateOf('languages');
  const eng = langs.find((r) => /english/i.test(r.claim));
  const spa = langs.find((r) => /spanish/i.test(r.claim));
  check('multi-valued guardrail: English kept', !!(eng && !eng.invalidAt), JSON.stringify(langs));
  check('multi-valued guardrail: Spanish kept', !!(spa && !spa.invalidAt), JSON.stringify(langs));

  // TEST 3: retrieval filter drops the superseded fact (nowIso passed).
  const now = new Date().toISOString();
  const sr: any = await dispatch.search('where does the user live', 25, undefined, userId, now);
  const injected: string[] = ((sr && sr.payload && sr.payload.memories) || sr?.memories || []).map((m: any) =>
    String(m.claim || ''),
  );
  check('retrieval drops superseded: no Austin', !injected.some((c) => /austin/i.test(c)), JSON.stringify(injected));
  check(
    'retrieval serves current: Denver present',
    injected.some((c) => /denver/i.test(c)),
    JSON.stringify(injected),
  );

  console.log('\n=== SUPERSESSION EVAL: ' + pass + ' pass / ' + fail + ' fail ===');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
