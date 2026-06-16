/**
 * Steering injection real-engine scenario harness (S80).
 *
 * Boots the real engine with REAL embeddings (not mocked), seeds controlled
 * messy data, queries via dispatch.search (the exact call the MCP memory_search
 * tool makes), and reports the assembled framing/steering/answerStyle per
 * scenario. Prints the blocks for review AND asserts the clear invariants.
 *
 * Run from /root/demiurge: node_modules/.bin/tsx scripts/steering_harness.ts
 *
 * TEST_MODE bypasses write-validation only (provider gate); the injection and
 * framing logic under test is unaffected by it.
 */
process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'harness-' + 'a'.repeat(24);
process.env.LOG_LEVEL = 'error';
process.env.TEST_MODE = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.BENCH_SKIP_CIRCUIT_BREAKER = 'true';
process.env.BI_TEMPORAL_ENABLED = 'true';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`   PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`   FAIL  ${name}  ${detail}`);
  }
}
function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86400000).toISOString();
}

async function main(): Promise<void> {
  const { loadConfig } = await import('../src/config.js');
  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { buildAnswerStyleBlock, DEFAULT_INJECTION_CONFIG } = await import('../src/inject/steering.js');
  const embeddings = await import('../src/embeddings/index.js');

  const config = loadConfig();
  console.log(`embeddings: initializing ${config.modelPath} ...`);
  await embeddings.initialize(config.modelPath);
  console.log('embeddings: ready\n');

  async function fresh() {
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);
    return { repo, dispatch };
  }
  async function addFact(
    dispatch: { addMemory: (i: unknown) => Promise<{ action: string }> },
    claim: string,
    subject: string,
    validFrom?: string,
  ) {
    return dispatch.addMemory({
      user_id: 'system',
      claim,
      subject,
      source: 'user',
      validFrom: validFrom ?? new Date().toISOString(),
    });
  }

  // ============ L2 framing ============
  console.log('[L2-S1] one current confident fact -> grounding ok');
  {
    const { dispatch } = await fresh();
    await addFact(dispatch, 'I live in Bandon, Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const f = r.payload.framing;
    console.log('   framing:', JSON.stringify(f));
    check('framing present', !!f);
    check('abstain false', !!f && f.abstain === false);
    check('grounding ok', !!f && f.grounding === 'ok', `got ${f?.grounding}`);
    check('no unresolved conflicts', !!f && f.unresolvedConflicts.length === 0);
  }

  console.log('\n[L2-S2] two ambiguous conflicting values -> conflict surfaced + thin');
  {
    const { dispatch } = await fresh();
    const t = isoDaysAgo(5);
    await addFact(dispatch, 'I live in Bandon Oregon', 'location', t);
    await addFact(dispatch, 'I live in Portland Oregon', 'location', t);
    const r = await dispatch.search('Where do I live?');
    const f = r.payload.framing;
    console.log('   framing:', JSON.stringify(f));
    console.log('   conflicts:', JSON.stringify(r.payload.conflicts));
    check('conflict surfaced', !!f && f.unresolvedConflicts.length > 0, `got ${f?.unresolvedConflicts.length}`);
    check('grounding thin', !!f && f.grounding === 'thin', `got ${f?.grounding}`);
    check('instruction mentions conflict', !!f && /conflict/i.test(f.instruction));
  }

  console.log('\n[L2-S3] clean supersession (old then new) -> current value, no false conflict');
  {
    const { dispatch } = await fresh();
    await addFact(dispatch, 'I live in Bandon Oregon', 'location', isoDaysAgo(30));
    await addFact(dispatch, 'I live in Eugene Oregon', 'location', new Date().toISOString());
    const r = await dispatch.search('Where do I live?');
    const f = r.payload.framing;
    const claims = r.payload.memories.map((m: { claim: string }) => m.claim);
    console.log('   framing:', JSON.stringify(f));
    console.log('   claims in pool:', JSON.stringify(claims));
    check('no unresolved conflict (resolved by supersession)', !!f && f.unresolvedConflicts.length === 0, `got ${f?.unresolvedConflicts.length}`);
    check('current value Eugene present', claims.some((c: string) => /Eugene/.test(c)));
    check('grounding ok', !!f && f.grounding === 'ok', `got ${f?.grounding}`);
  }

  console.log('\n[L2-S4] no matching facts -> abstain, grounding none');
  {
    const { dispatch } = await fresh();
    // Empty memory: abstain fires only when retrieval returns zero candidates.
    // (A populated DB returns the top-k even for an off-topic query, because
    // grounding is presence-based, not relevance-based. See report note.)
    const r = await dispatch.search('What is my dog name?');
    const f = r.payload.framing;
    console.log('   framing:', JSON.stringify(f));
    console.log('   memories:', r.payload.memories.length);
    check('abstain true', !!f && f.abstain === true, `memories=${r.payload.memories.length}`);
    check('grounding none', !!f && f.grounding === 'none', `got ${f?.grounding}`);
  }

  // ============ L3 interaction prefs ============
  console.log('\n[L3-S5] set one preference -> appears in steering');
  {
    const { dispatch } = await fresh();
    await dispatch.setPreference('verbosity', 'concise');
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const s = r.payload.steering;
    console.log('   steering:', JSON.stringify(s));
    const byDim = Object.fromEntries((s?.interactionPrefs ?? []).map((p: { dimension: string; value: string }) => [p.dimension, p.value]));
    check('verbosity concise present', byDim.verbosity === 'concise', `got ${JSON.stringify(byDim)}`);
  }

  console.log('\n[L3-S6] set a preference twice -> only the current value');
  {
    const { dispatch } = await fresh();
    await dispatch.setPreference('verbosity', 'concise');
    await new Promise((r) => setTimeout(r, 8));
    await dispatch.setPreference('verbosity', 'verbose');
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const s = r.payload.steering;
    console.log('   steering:', JSON.stringify(s));
    const prefs = (s?.interactionPrefs ?? []).filter((p: { dimension: string }) => p.dimension === 'verbosity');
    check('one verbosity entry', prefs.length === 1, `got ${prefs.length}`);
    check('value is verbose', prefs[0]?.value === 'verbose', `got ${prefs[0]?.value}`);
  }

  console.log('\n[L3-S7] two dimensions -> both present');
  {
    const { dispatch } = await fresh();
    await dispatch.setPreference('verbosity', 'concise');
    await dispatch.setPreference('units', 'metric');
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const s = r.payload.steering;
    console.log('   steering:', JSON.stringify(s));
    const byDim = Object.fromEntries((s?.interactionPrefs ?? []).map((p: { dimension: string; value: string }) => [p.dimension, p.value]));
    check('verbosity present', byDim.verbosity === 'concise');
    check('units present', byDim.units === 'metric');
  }

  // ============ L3 continuity ============
  console.log('\n[L3-S8] episode -> current focus');
  {
    const { repo, dispatch } = await fresh();
    await repo.insertEpisode({
      id: 'ep-h1',
      subject: 'pottery',
      title: 'Planning a pottery studio',
      summary: 'The user is setting up a home pottery studio.',
      timeframe_start: null,
      timeframe_end: null,
      session_source: null,
      fact_count: 0,
    });
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const s = r.payload.steering;
    console.log('   steering.continuity:', JSON.stringify(s?.continuity));
    check('current focus is episode title', s?.continuity?.currentFocus === 'Planning a pottery studio', `got ${s?.continuity?.currentFocus}`);
  }

  console.log('\n[L3-S9] correction -> recent corrections');
  {
    const { dispatch } = await fresh();
    await dispatch.setPreference('verbosity', 'concise');
    await new Promise((r) => setTimeout(r, 8));
    await dispatch.setPreference('verbosity', 'verbose');
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const s = r.payload.steering;
    console.log('   steering.continuity:', JSON.stringify(s?.continuity));
    const rc = s?.continuity?.recentCorrections ?? [];
    check('recent corrections non-empty', rc.length > 0, `got ${rc.length}`);
    check('correction mentions verbosity', rc.some((c: string) => /verbosity/i.test(c)));
  }

  // ============ L4 answer-style ============
  console.log('\n[L4-S10] answer-style off by default -> absent');
  {
    const { dispatch } = await fresh();
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    console.log('   answerStyle:', JSON.stringify(r.payload.answerStyle));
    check('answerStyle undefined by default', r.payload.answerStyle === undefined);
  }

  console.log('\n[L4-S11] answer-style on (opt-in) -> present with guidance');
  {
    const { dispatch } = await fresh();
    await addFact(dispatch, 'I live in Bandon Oregon', 'location');
    const r = await dispatch.search('Where do I live?');
    const onConfig = { ...DEFAULT_INJECTION_CONFIG, answerStyle: true };
    const block = buildAnswerStyleBlock(r.payload, onConfig);
    console.log('   queryType:', r.payload.metadata?.queryType, ' answerStyle:', JSON.stringify(block));
    check('answerStyle present when opted in', !!block, `queryType=${r.payload.metadata?.queryType}`);
    check('guidance non-empty', !!block && block.guidance.length > 0);
  }

  // ============ composition ============
  console.log('\n[C-S12] conflict + prefs + correction compose in one response');
  {
    const { dispatch } = await fresh();
    const t = isoDaysAgo(5);
    await addFact(dispatch, 'I work at Acme Corp', 'employer', t);
    await addFact(dispatch, 'I work at Globex Corp', 'employer', t);
    await dispatch.setPreference('tone', 'concise');
    await new Promise((r) => setTimeout(r, 8));
    await dispatch.setPreference('tone', 'formal');
    const r = await dispatch.search('Where do I work?');
    const f = r.payload.framing;
    const s = r.payload.steering;
    console.log('   framing:', JSON.stringify(f));
    console.log('   steering:', JSON.stringify(s));
    check('conflict surfaced', !!f && f.unresolvedConflicts.length > 0);
    check('tone pref present (formal)', (s?.interactionPrefs ?? []).some((p: { dimension: string; value: string }) => p.dimension === 'tone' && p.value === 'formal'));
    check('correction present', (s?.continuity?.recentCorrections ?? []).length > 0);
  }

  console.log(`\n=== HARNESS ${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail} (${pass} pass, ${fail} fail) ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
