#!/usr/bin/env npx tsx
// ADAPTER_MODE: ENGINE_PATH (direct-seeds extracted facts from
// extracted-facts.json, bypasses production extraction path). Numbers
// are valid for engine retrieval/answer measurement; cannot be cited
// as full-pipeline performance.
/**
 * Official LOCOMO benchmark runner.
 *
 * S67 LOCKDOWN: dispatch.ingest() is the only seed path. Bench feeds raw
 * session text from locomo10.json through the engine's own extraction
 * pipeline. No --ingest-mode flag (it's the only mode). No --facts-file
 * (legacy pre-extracted seeder removed). One path. The legacy seeder
 * silently caused a -34pp regression on 2026-05-09 by writing to the
 * system user partition while the runner queries with userId=locomo-conv-{ci}.
 *
 * Inputs:
 *   - fixtures/benchmark/locomo10.json (raw conversations + Q/A)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// S59A: bench-env preamble, sets deterministic defaults regardless of .env
import { ensureBenchEnv, auditBenchEnv } from '../src/benchmark/lib/bench-env.js';
import { initBenchTelemetry } from '../src/benchmark/lib/bench-telemetry.js';
import { maybeStoneForMaterializer } from '../src/benchmark/lib/stone-wiring.js';
// Wedge 1.5 Phase 2 fix-up: arm telemetry when TELEMETRY_ENABLED=true.
// Bench paths bypass src/boot.ts where initStorage is normally called.
// Read env directly to avoid circular import with config.ts (TDZ error).
import { withTrace } from '../src/telemetry/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callJudgeCached } from '../src/benchmark/judge-cache.js';
import { computeManifest, manifestedFilename, AdapterMode } from '../src/benchmark/lib/manifest.js';

interface LocomoQA {
  question: string;
  answer?: string;
  adversarial_answer?: string;
  evidence?: string[];
  category: number; // 1-5, where 5 = adversarial
}

interface LocomoConversation {
  conversation: Array<{ role: string; content: string }>;
  qa: LocomoQA[];
}

interface QuestionResult {
  conversation_index: number;
  question_index: number;
  category: number;
  question: string;
  expected_answer: string;
  predicted_answer: string;
  /** Classifier-collapse (S77): model that produced the answer + classifier output. */
  answer_model: string;
  query_type: string;
  llm_judge_correct: boolean;
  f1_score: number;
  retrieval_time_ms: number;
  total_time_ms: number;
  memories_injected: number;
}

/**
 * S63 (B19-D): LOCOMO timestamps look like "1:56 pm on 8 May, 2023", not
 * directly parseable by `new Date()`. Strip everything up to and including
 * " on " and feed the remainder to Date, "8 May, 2023" parses cleanly.
 * Returns ms since epoch or null on failure. Brain #2044.
 */
function parseLocomoTimestamp(ts: string): number | null {
  const onIdx = ts.toLowerCase().indexOf(' on ');
  const datePart = onIdx >= 0 ? ts.slice(onIdx + 4) : ts;
  const ms = new Date(datePart).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function main() {
  // S59A: lock bench-mode env BEFORE anything else reads process.env.
  // Sets TEST_MODE=true, ANSWER_ROUTING=false (LOCOMO iter-mode #2015),
  // STONE_*=false, etc. Overrides whatever .env or shell set.
  ensureBenchEnv('locomo');
  initBenchTelemetry();

  // Parse args
  const args = process.argv.slice(2);

  // S66 KILL-ALL-CHEATS: hard warnings on flags that produce incomparable
  // or overstated scores. The launcher (scripts/bench-locomo.sh) already
  // hard-errors on --limit-qa, but direct invocations bypass the launcher,
  // so the runner emits a giant warning of its own.
  if (args.includes('--limit-qa')) {
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('!! ⚠️  WARNING: --limit-qa PRODUCES INCOMPARABLE SCORES         !!');
    console.error('!! Sampling first-N-per-conversation gives a different category !!');
    console.error('!! distribution than --mini (296Q stratified) or --full (1540Q).!!');
    console.error('!! Numbers from --limit-qa runs are NOT comparable to historical !!');
    console.error('!! baselines or to each other across N values. DIAGNOSTIC USE   !!');
    console.error('!! ONLY, never publish or compare these numbers.               !!');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  }
  // S67 LOCKDOWN: --facts-file is gone. Hard-error if anyone tries to use it.
  if (args.includes('--facts-file')) {
    console.error(
      'FATAL: --facts-file no longer supported. Legacy pre-extracted-facts path was removed in S67 lockdown after it caused a -34pp catastrophic regression by silently writing to the wrong user partition. There is now exactly one bench path: end-to-end via dispatch.ingest(). See CHEAT_LOG.md.',
    );
    process.exit(1);
  }
  // S67 LOCKDOWN: --ingest-mode is no longer a flag, ingest is the only path.
  // Tolerate the flag for back-compat with old launchers but warn it is a no-op.
  if (args.includes('--ingest-mode')) {
    console.warn('NOTE: --ingest-mode is now a no-op. Ingest is the only LOCOMO bench path (S67 lockdown).');
  }
  const limitConvosIdx = args.indexOf('--limit-convos');
  const limitQaIdx = args.indexOf('--limit-qa');
  const maxRulesIdx = args.indexOf('--max-rules');
  const startConvIdx = args.indexOf('--start-conv');
  const startConv = startConvIdx !== -1 ? parseInt(args[startConvIdx + 1] ?? '0', 10) : 0;
  const limitConvos = limitConvosIdx !== -1 ? parseInt(args[limitConvosIdx + 1] ?? '10', 10) : 10;
  const limitQa = limitQaIdx !== -1 ? parseInt(args[limitQaIdx + 1] ?? '9999', 10) : 9999;
  // S59A: defaults match the May 6 2026 baseline run (63.5pct).
  // Previous defaults (25 / haiku / haiku) silently produced incomparable
  // numbers when launchers forgot to override every flag.
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '65', 10) : 65;
  const answerModelIdx = args.indexOf('--answer-model');
  const judgeModelIdx = args.indexOf('--judge-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4.1-mini';
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';
  const miniFileIdx = args.indexOf('--mini-file');
  const miniFileArg = miniFileIdx !== -1 ? args[miniFileIdx + 1]! : null;
  // Routing default for LOCOMO comes from bench profile (off per #2015).
  // --routed opts in (publish-time runs); --no-route forces off explicitly.
  const routedMode = args.includes('--routed');
  const noRouteMode = args.includes('--no-route');
  // S67 LOCKDOWN: ingest is the only path. Const, not a flag.
  const ingestMode = true;
  // S65 council reconciliation: dedup runs on every bench. The flag-coupling
  // that let TEST_MODE silently disable dedup is gone. Dedup-skip now requires
  // explicit BENCH_SKIP_DEDUP='true' on the profile; LOCOMO never sets it.
  if (routedMode && noRouteMode) {
    console.error('ERROR: cannot pass both --routed and --no-route');
    process.exit(1);
  }
  if (routedMode) {
    process.env.ANSWER_ROUTING = 'false';
  }
  if (noRouteMode) {
    process.env.ANSWER_ROUTING = 'false';
  }
  console.error(`[bench-env] ANSWER_ROUTING=${process.env.ANSWER_ROUTING}`);

  // LOCOMO-mini: stratified 20% sample for fast A/B testing (~14 min vs 2-3 hrs)
  const miniMode = args.includes('--mini');

  // S63 Tier 0.4: result manifest. Computed AFTER ensureBenchEnv +
  // --routed/--no-route mutations so it captures the canonical run state.
  // Backfilled with sample_size and nowIso_passed at end-of-run.
  const allowDirtyRunner = args.includes('--allow-dirty-runner');
  let anyConvHadNowIso = false;
  const routingSentinel = process.env.ANSWER_ROUTING === 'true' ? 'routing-on' : answerModel;
  const manifest = computeManifest({
    runnerPath: 'scripts/benchmark-locomo-official.ts',
    modelPins: {
      answer: routingSentinel,
      judge: judgeModel,
      embed: 'BAAI/bge-small-en-v1.5',
    },
    fixtureVersion: 'locomo10-official-v1',
    scorerVersion: 'locomo-llm-judge-v1',
    adapterMode: AdapterMode.PRODUCT_PATH, // S67 lockdown: ingest is only path
    sampleSize: 0,
    scopeLabel: miniMode ? 'mini' : 'full',
    cliFlags: args,
    maxRules,
    nowIsoPassed: false,
    _skipDriftCheck: allowDirtyRunner,
  });
  console.log(
    `[manifest] commit=${manifest.commit_sha.slice(0, 7)} adapter=${manifest.adapter_mode} scope=${manifest.scope_label}`,
  );
  if (manifest.dirty_worktree) {
    console.warn(`[manifest] WARNING: dirty worktree (${manifest.dirty_paths.length} files). Run is NOT reproducible.`);
  }

  let miniIndices: Map<number, Set<number>> | null = null;
  if (miniMode) {
    const miniPath =
      miniFileArg || resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo-mini-indices.json');
    if (existsSync(miniPath)) {
      const miniData = JSON.parse(readFileSync(miniPath, 'utf-8'));
      miniIndices = new Map();
      for (const conv of miniData.conversations) {
        miniIndices.set(conv.conversation_index, new Set(conv.question_indices));
      }
      console.log(
        'LOCOMO-mini mode: ' + miniData.total_sampled + ' questions (' + miniData.sample_rate * 100 + '% sample)',
      );
    } else {
      console.error('Mini indices not found. Run: python3 scripts/create-locomo-mini.py');
      process.exit(1);
    }
  }

  // Category labels, JSON cat values (NOT paper narrative order):
  //   1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial(excluded)
  const CATEGORY_LABELS: Record<number, string> = {
    1: 'Multi-hop',
    2: 'Temporal',
    3: 'Open-domain',
    4: 'Single-hop',
    5: 'Adversarial (EXCLUDED)',
  };

  // Setup
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  // S65 Sprint 1: Anthropic dropped from default judge surface. Accept either
  // key so iteration runs on whatever provider is configured. Engine callLLM
  // routes via fallback chain when the primary is unavailable.
  if (!anthropicKey && !openaiKey) {
    console.error('Need OPENAI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // Initialize embeddings
  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable:', e instanceof Error ? e.message : String(e));
  }

  // Load dataset
  const datasetPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json');
  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error('Download the official LOCOMO dataset first.');
    process.exit(1);
  }

  const dataset: LocomoConversation[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  const convsToRun = Math.min(startConv + limitConvos, dataset.length);
  console.log(`Answer model: ${answerModel}`);
  if (routedMode) console.log('Answer routing: ENABLED');
  console.log(`Judge model: ${judgeModel}`);
  console.log('Seed mode: dispatch.ingest(), engine extraction (S67 lockdown: only path)');
  console.log(`Official LOCOMO: ${convsToRun} conversations, maxRules=${maxRules}, cat5=excluded`);

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { computeF1 } = await import('../src/benchmark/locomo-official-seeder.js');
  const { seedConversationViaIngest } = await import('../src/benchmark/locomo-official-seeder.js');

  const allResults: QuestionResult[] = [];

  for (let ci = startConv; ci < convsToRun; ci++) {
    const conv = dataset[ci]!;
    console.log(`\n[Conv ${ci}] ${conv.qa.length} questions (ingest-only)`);

    // Fresh isolated repo per conversation
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString()); // Unlock circuit breaker for fresh benchmark DBs
    const stone = maybeStoneForMaterializer(repo);
    const dispatch = createCoreDispatch(repo, config, stone);

    // S67 LOCKDOWN: ingest is the only path. No legacy fork.
    const rawConv = (dataset[ci] as unknown as { conversation: Parameters<typeof seedConversationViaIngest>[1] })
      .conversation;
    // S75: wrap seed in withTrace so dispatch.ingest's internal spans
    // (extraction, writes, dedup, etc.) emit instead of dropping.
    const summary = await withTrace(
      {
        entry: 'bench',
        user_id: `locomo-conv-${ci}`,
        tags: { bench: 'locomo', op: 'seed', conversation_index: ci },
      },
      () => seedConversationViaIngest(dispatch, rawConv, ci),
    );
    console.log(
      `  Ingested: ${summary.sessions_processed} sessions, ${summary.total_extracted} extracted, ${summary.total_written} written, ${summary.total_rejected} rejected, ${summary.total_errors} errors (${summary.duration_ms.total}ms)`,
    );

    // S67 LOCKDOWN sanity probe: confirm seed produced retrievable memories
    // for this conversation's userId. If retrieval comes back empty after a
    // successful ingest, partition mismatch is back, fail loud, don't silently
    // produce 20% scores like the 2026-05-09 22:08 UTC catastrophe.
    //
    // S74 PR#82 fix: query with a REAL subject from the seeded data instead
    // of a meaningless string. With RERANKER_ENABLED=true the reranker's
    // confidence floor (default 0.25) correctly returns empty for arbitrary
    // strings, that was being misread as "partition mismatch." Real subjects
    // produce semantic similarity above the floor on their own claims AND
    // still return 0 if writes landed in the wrong partition (the actual
    // invariant the probe verifies).
    if (summary.total_written > 0) {
      const userId = `locomo-conv-${ci}`;
      const probeRow = await repo.getOneByUser(userId);
      if (!probeRow) {
        console.error(
          `FATAL: Conv ${ci} ingested ${summary.total_written} memories but repo.getOneByUser('${userId}') returned null. Partition mismatch confirmed at the SQL layer. Aborting bench.`,
        );
        process.exit(1);
      }
      // S74 probe fix: use raw claim text instead of subject || claim-slice.
      // Bare subjects (e.g. `john`) are too thin for the rerank confidence
      // floor to accept on some conversations, the Conv 4 abort came from
      // exactly this. Raw claim text is the literal string FTS5 indexed,
      // so it self-matches with maximum lexical score regardless of
      // reranker behavior. Bug 2 fix also stops the floor from returning
      // [], but the probe-query change is belt-and-suspenders.
      const probeQuery = probeRow.claim;
      const probe = await withTrace(
        { entry: 'bench', user_id: userId, tags: { bench: 'locomo', op: 'sanity_probe' } },
        () => dispatch.search(probeQuery, 5, undefined, userId, undefined),
      );
      const probeCount = probe.payload.memories.length;
      if (probeCount === 0) {
        console.error(
          `FATAL: Conv ${ci} ingested ${summary.total_written} memories but probe retrieval (query='${probeQuery}') found 0 in user partition '${userId}'. Partition mismatch detected. Aborting bench. (S67 sanity probe, see CHEAT_LOG.md.)`,
        );
        process.exit(1);
      }
      console.log(`  [sanity probe] retrieved ${probeCount} memories from user partition locomo-conv-${ci}`);
    }

    // R11: Post-seed hooks (episodes, summaries, bridges)
    try {
      const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
      if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
        console.log(`  R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`);
      }
    } catch (hookErr: any) {
      console.log('  R11 hooks failed (non-critical):', hookErr?.message?.substring(0, 80));
    }

    // S63 (B19-D) + S67 LOCKDOWN: compute the conversation's "now" anchor
    // from the latest session_<N>_date_time field in the LOCOMO dataset.
    // Pre-S67 this read from the cached extracted-facts.json file; that file
    // is gone now (legacy seeder removed). The conversation object itself
    // carries session_1_date_time, session_2_date_time, ..., those are the
    // canonical source of truth. Without this anchor the answer model uses
    // server wall-clock (2026) and hallucinates dates. Brain #2044.
    const convDict = (dataset[ci] as unknown as { conversation: Record<string, unknown> }).conversation;
    const sessionTimes: number[] = [];
    for (const key of Object.keys(convDict)) {
      if (!key.endsWith('_date_time')) continue;
      const raw = convDict[key];
      if (typeof raw !== 'string') continue;
      const ms = parseLocomoTimestamp(raw);
      if (ms !== null) sessionTimes.push(ms);
    }
    let convNowIso: string | undefined = undefined;
    if (sessionTimes.length > 0) {
      convNowIso = new Date(Math.max(...sessionTimes)).toISOString();
    }
    if (convNowIso) anyConvHadNowIso = true;
    console.log(`  [Conv ${ci}] nowIso anchor: ${convNowIso ?? '(unset, falls back to wall-clock)'}`);

    // Run questions
    const qasToRun = conv.qa.slice(0, limitQa);

    for (let qi = 0; qi < qasToRun.length; qi++) {
      const qa = qasToRun[qi]!;
      const totalStart = performance.now();

      try {
        // Skip questions not in mini sample (if --mini mode)
        if (miniIndices) {
          const convSet = miniIndices.get(ci);
          if (!convSet || !convSet.has(qi)) continue;
        }

        // Skip Cat 5 (adversarial), excluded from scoring, save API cost
        if (qa.category === 5) {
          allResults.push({
            conversation_index: ci,
            question_index: qi,
            category: qa.category,
            question: qa.question,
            expected_answer: '(adversarial - excluded)',
            predicted_answer: '(skipped)',
            llm_judge_correct: false,
            f1_score: 0,
            retrieval_time_ms: 0,
            total_time_ms: 0,
            memories_injected: 0,
          });
          continue;
        }

        // S65 prompt-honesty: bench goes through the public dispatch.answer()
        // path, engine classifies the query, picks the per-category prompt,
        // applies the routed model, and prepends the conversation now-anchor
        // from opts.nowIso. No bench-side prompt construction.
        //
        // Wedge 1.5 Phase 2 fix-up: wrap in withTrace so the full pipeline
        // produces spans, decisions, llm_calls, etc. Without this, the
        // trace-scoped helpers short-circuit on missing ALS context.
        const retrievalStart = performance.now();
        const result = await withTrace(
          {
            entry: 'bench',
            user_id: `locomo-conv-${ci}`,
            tags: {
              bench: 'locomo',
              conversation_index: ci,
              question_index: qi,
              category: qa.category,
            },
          },
          () =>
            dispatch.answer(qa.question, {
              model: answerModel,
              maxRules,
              nowIso: convNowIso,
              userId: `locomo-conv-${ci}`,
            }),
        );
        const retrievalTimeMs = performance.now() - retrievalStart;
        const searchResult = result.search;
        const predicted = result.answer;
        const activeModel = result.model;
        const queryType = searchResult.raw.metadata.queryType;

        // LLM judge, binary J-score (industry standard for LOCOMO)
        // Cat 5 is skipped above, so qa.answer is always defined for scored questions.
        const expectedAnswer = qa.answer ?? 'N/A';
        const judgePrompt = `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: ${qa.question}
Gold answer: ${expectedAnswer}
System response: ${predicted}

Does the system response correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.`;

        // S65 Sprint 1 (M9): persistent judge cache wraps the live call.
        const judgeRes = await callJudgeCached({
          model: judgeModel,
          system: '',
          user: judgePrompt,
          predicted,
          cacheTag: 'locomo',
          llmCacheKey: 'demiurge:locomo:judge:v1',
        });
        const judgeText = judgeRes.verdict;
        const llmCorrect = judgeText.startsWith('yes');

        const f1 = computeF1(predicted, expectedAnswer);
        const totalTimeMs = performance.now() - totalStart;

        const resultEntry: any = {
          conversation_index: ci,
          question_index: qi,
          category: qa.category,
          question: qa.question,
          expected_answer: expectedAnswer,
          predicted_answer: predicted,
          answer_model: activeModel,
          query_type: queryType,
          llm_judge_correct: llmCorrect,
          f1_score: f1,
          retrieval_time_ms: retrievalTimeMs,
          total_time_ms: totalTimeMs,
          memories_injected: searchResult.payload.memories.length,
        };

        // S25: Gold-evidence instrumentation (log all injected memory claims)
        if (process.env.GOLD_EVIDENCE_LOG === 'true') {
          resultEntry.injected_claims = searchResult.payload.memories.map((m: { claim: string; subject?: string }) => ({
            claim: m.claim,
            subject: m.subject,
          }));
        }

        allResults.push(resultEntry);

        // Retrieval recall: log top-3 facts for first 10 scored questions per conv
        if (qi < 10 && qa.category !== 5) {
          const catLabel = CATEGORY_LABELS[qa.category] || `Cat ${qa.category}`;
          console.log(`  Q${qi} [${catLabel}]: "${qa.question}"`);
          console.log(`    Expected: ${qa.answer ?? '(none)'}`);
          console.log(`    Predicted: ${predicted.substring(0, 120)}`);
          console.log(`    Judge: ${llmCorrect ? 'CORRECT' : 'WRONG'} | F1: ${f1.toFixed(2)}`);
          searchResult.payload.memories
            .slice(0, 3)
            .forEach((m: { claim: string }, i: number) => console.log(`    Mem ${i}: ${m.claim.substring(0, 100)}`));
        }

        if ((qi + 1) % 50 === 0) {
          const scoredSoFar = allResults.filter((r) => r.category !== 5);
          const correctSoFar = scoredSoFar.filter((r) => r.llm_judge_correct).length;
          console.log(
            `  [${qi + 1}/${qasToRun.length}] Running J-score: ${scoredSoFar.length > 0 ? ((correctSoFar / scoredSoFar.length) * 100).toFixed(1) : '0.0'}%`,
          );
        }
      } catch (err) {
        console.error(`  Q${qi}: ERROR`, err instanceof Error ? err.message : err);
        allResults.push({
          conversation_index: ci,
          question_index: qi,
          category: qa.category,
          question: qa.question,
          expected_answer: qa.answer ?? 'N/A',
          predicted_answer: '',
          llm_judge_correct: false,
          f1_score: 0,
          retrieval_time_ms: 0,
          total_time_ms: performance.now() - totalStart,
          memories_injected: 0,
        });
      }
    }

    await repo.close();
  }

  // Report, EXCLUDE Cat 5 from headline score (industry standard).
  // Cat 5 has no usable answer field; all published results (Mem0, Hindsight, Memori) exclude it.
  const scoredResults = allResults.filter((r) => r.category !== 5);
  const cat5Results = allResults.filter((r) => r.category === 5);
  const totalQ = allResults.length;
  const scoredQ = scoredResults.length;
  const llmCorrect = scoredResults.filter((r) => r.llm_judge_correct).length;
  const meanF1 = scoredQ > 0 ? scoredResults.reduce((s, r) => s + r.f1_score, 0) / scoredQ : 0;
  const meanRetrieval = totalQ > 0 ? allResults.reduce((s, r) => s + r.retrieval_time_ms, 0) / totalQ : 0;
  const meanTotal = totalQ > 0 ? allResults.reduce((s, r) => s + r.total_time_ms, 0) / totalQ : 0;

  console.log('\n========== OFFICIAL LOCOMO RESULTS ==========');
  console.log(`Questions:    ${scoredQ} scored (${cat5Results.length} adversarial excluded, ${totalQ} total)`);
  console.log(`J-Score:      ${((llmCorrect / scoredQ) * 100).toFixed(1)}% (${llmCorrect}/${scoredQ})`);
  console.log(`Mean F1:      ${(meanF1 * 100).toFixed(1)}%`);
  console.log(`Retrieval:    mean ${meanRetrieval.toFixed(1)}ms`);
  console.log(`Total:        mean ${meanTotal.toFixed(1)}ms`);

  // Per-category breakdown (weighted contribution to overall)
  console.log('\nBy category (JSON IDs):');
  for (let cat = 1; cat <= 5; cat++) {
    const catResults = allResults.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;
    const catCorrect = catResults.filter((r) => r.llm_judge_correct).length;
    const catF1 = catResults.reduce((s, r) => s + r.f1_score, 0) / catResults.length;
    const catLabel = CATEGORY_LABELS[cat] || `Cat ${cat}`;
    const excluded = cat === 5 ? ' [NOT IN SCORE]' : '';
    const weight = cat !== 5 && scoredQ > 0 ? ` (weight: ${((catResults.length / scoredQ) * 100).toFixed(1)}%)` : '';
    console.log(
      `  ${catLabel}: J ${((catCorrect / catResults.length) * 100).toFixed(1)}% (${catCorrect}/${catResults.length}), F1 ${(catF1 * 100).toFixed(1)}%${weight}${excluded}`,
    );
  }

  // Save results
  manifest.sample_size = scoredQ;
  manifest.nowIso_passed = anyConvHadNowIso;
  const reportPath = resolve(
    outputDir,
    manifestedFilename({ bench: 'locomo-official', scope: manifest.scope_label, manifest }),
  );
  const report = {
    benchmark: 'locomo-official',
    timestamp: new Date().toISOString(),
    manifest,
    config: {
      maxRules,
      lexicalWeight: config.lexicalWeight,
      vectorWeight: config.vectorWeight,
      freshnessHalfLifeDays: config.freshnessHalfLifeDays,
      candidateOverfetchMultiplier: config.candidateOverfetchMultiplier,
      hybridFusionMode: process.env.HYBRID_FUSION_MODE ?? 'linear',
      weightProfileSource: 'per-query-type',
      answerModel,
      judgeModel,
      temperature: 0,
    },
    methodology: {
      note: 'J-score (LLM-as-judge binary accuracy) on categories 1-4. Cat 5 (adversarial) excluded per industry standard.',
      categoryMapping: 'JSON cat 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial(excluded)',
      metric: 'J-score (primary), F1 (secondary)',
      ceiling: '~93-94% due to ~99 ground-truth errors in dataset (locomo-audit)',
    },
    summary: {
      totalQuestions: totalQ,
      scoredQuestions: scoredQ,
      excludedCat5: cat5Results.length,
      jScore: scoredQ > 0 ? llmCorrect / scoredQ : 0,
      jScoreCorrect: llmCorrect,
      meanF1,
      meanRetrievalMs: meanRetrieval,
      meanTotalMs: meanTotal,
    },
    results: allResults,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);

  // S25: Gold-evidence instrumentation, separate file with injected claims
  if (process.env.GOLD_EVIDENCE_LOG === 'true') {
    const evidencePath = reportPath.replace('.json', '-evidence.json');
    const evidenceData = allResults
      .filter((r: any) => r.injected_claims)
      .map((r: any) => ({
        conv: r.conversation_index,
        q: r.question_index,
        category: r.category,
        query_type: r.query_type,
        question: r.question,
        expected: r.expected_answer,
        predicted: r.predicted_answer,
        correct: r.llm_judge_correct,
        model: r.answer_model,
        num_injected: r.memories_injected,
        claims: r.injected_claims,
      }));
    writeFileSync(evidencePath, JSON.stringify(evidenceData, null, 2));
    console.log(`Evidence: ${evidencePath}`);
  }

  // S59 / TEMPR: degraded-rate gate. Throws if rerank degraded ≥ 1% over the run.
  const { assertRerankDegradedBelow } = await import('../src/benchmark/shared/rerank-telemetry.js');
  assertRerankDegradedBelow(0.01, 'LOCOMO');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
