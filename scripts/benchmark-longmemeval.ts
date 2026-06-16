#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark Runner
 *
 * S67 Phase 1B: verbatim sessions are fed to dispatch.ingest() per session.
 * The engine's own extraction pipeline (gpt-4.1-nano default, persistent
 * cache) splits each session into atomic claims; trust pipeline writes them
 * through the same path production users hit.
 *
 * Per-question user partition: `lme-q-${entry.question_id}`. Seed and
 * answer must use the same userId or partition mismatch silently kills
 * retrieval. Sanity probe at end of seed catches mismatches.
 *
 * Mode `extracted` is hard-deprecated as of Phase 1B (uses pre-extracted
 * facts that bypass extraction; see CHEAT_LOG.md).
 *
 * Usage:
 *   npx tsx scripts/benchmark-longmemeval.ts                      # Full 500
 *   npx tsx scripts/benchmark-longmemeval.ts --limit 20           # First 20
 *   npx tsx scripts/benchmark-longmemeval.ts --mini               # Mini (100Q stratified)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { callJudgeCached } from '../src/benchmark/judge-cache.js';
import { computeManifest, manifestedFilename, AdapterMode } from '../src/benchmark/lib/manifest.js';
import { maybeStoneForMaterializer } from '../src/benchmark/lib/stone-wiring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse LME's `haystack_dates[i]` format ("2023/05/20 (Sat) 02:21") into
 * an ISO 8601 string suitable for `dispatch.ingest`'s `asserted_at` opt.
 * Returns undefined for unparseable input, engine falls back to wall-clock.
 */
function parseLmeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Format: "YYYY/MM/DD (DDD) HH:MM"
  const m = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+\([A-Za-z]+\)\s+(\d{1,2}):(\d{1,2})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const isoCandidate = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}T${h!.padStart(2, '0')}:${mi!.padStart(2, '0')}:00Z`;
  const t = new Date(isoCandidate).getTime();
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

async function main() {
  // S59A: bench-env preamble. Per #464 LME default routed (+18pp vs unrouted).
  const { ensureBenchEnv } = await import('../src/benchmark/lib/bench-env.js');
  const { initBenchTelemetry } = await import('../src/benchmark/lib/bench-telemetry.js');
  ensureBenchEnv('lme');
  initBenchTelemetry();
  // S68 cache-warm probe (brain #2184)
  const { probe, printBanner } = await import('./cache-warm-probe.js');
  const _probeResult = probe('lme');
  printBanner(_probeResult);
  if (_probeResult.status === 'COLD' && process.env.BENCH_COLD_OK !== '1') {
    console.error('ABORT: cache COLD and BENCH_COLD_OK not set. Bypass with BENCH_COLD_OK=1.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? '500', 10) : 500;
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1]! : 'verbatim';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;
  const answerModelIdx = args.indexOf('--answer-model');
  const judgeModelIdx = args.indexOf('--judge-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4.1-mini';

  // S67 Phase 1B: --mode extracted is HARD-DEPRECATED. The pre-extracted
  // facts bypass engine extraction. There is now exactly one bench path:
  // end-to-end via dispatch.ingest() in verbatim mode.
  if (mode === 'extracted') {
    console.error('FATAL: --mode extracted no longer supported. Pre-extracted facts bypass engine extraction.');
    console.error('There is now one bench path: --mode verbatim (default), which routes through dispatch.ingest().');
    console.error('See CHEAT_LOG.md for the Phase 1B doctrine.');
    process.exit(1);
  }

  // S58 Step 5: default to seeding assistant turns (was opt-in via --seed-assistant).
  // Engine answering questions about content NEVER STORED produces 53.6% on single-session-assistant
  // (vs 94.3% on single-session-user). Methodology fix, not engine fix.
  // Override with --no-seed-assistant for legacy comparison runs.
  const seedAssistant = !args.includes('--no-seed-assistant');
  // S64 PHASE 1: adaptiveGate removed (was --adaptive-gate). Bench-only knob
  // that suppressed assistant seeding above a message-count threshold to
  // chase scores. Production has no equivalent. See CHEAT_LOG.md.
  const routedMode = args.includes('--routed');
  if (routedMode) process.env.ANSWER_ROUTING = 'false';
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-longmemeval-demiurge-2026';
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey && !anthropicKey) {
    console.error('Need OPENAI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // Load embeddings
  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embedding model loaded');

  // Load dataset
  const datasetPath = resolve(__dirname, '../fixtures/benchmark/longmemeval/longmemeval_s_cleaned.json');
  if (!existsSync(datasetPath)) {
    console.error('Dataset not found:', datasetPath);
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8')) as any[];

  // S67 Phase 1B: bench is now PRODUCT_PATH always. The legacy `--ingest-mode`
  // flag is kept for back-compat but is now a no-op since there's only one
  // path. We still stamp adapterMode=PRODUCT_PATH unconditionally so the
  // manifest reflects the honest path.
  const allowDirtyRunner = args.includes('--allow-dirty-runner');
  if (args.includes('--ingest-mode')) {
    console.warn('[bench-flag] --ingest-mode is now a no-op: dispatch.ingest() is the only seed path in S67 Phase 1B.');
  }
  const manifest = computeManifest({
    runnerPath: 'scripts/benchmark-longmemeval.ts',
    modelPins: {
      answer: routedMode ? 'routing-on' : answerModel,
      judge: judgeModel,
      embed: 'BAAI/bge-small-en-v1.5',
    },
    fixtureVersion: 'longmemeval_s_cleaned-v1',
    scorerVersion: 'lme-llm-judge-v1',
    adapterMode: AdapterMode.PRODUCT_PATH,
    sampleSize: 0,
    scopeLabel: args.includes('--mini') ? 'mini' : 'full',
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
  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { withTrace } = await import('../src/telemetry/index.js');

  // Mini mode: use stratified indices
  let questionsToRun: typeof dataset;
  const miniMode = args.includes('--mini');
  if (miniMode) {
    const miniFileIdx = args.indexOf('--mini-file');
    const miniIndicesPath =
      miniFileIdx !== -1
        ? resolve(args[miniFileIdx + 1]!)
        : resolve(__dirname, '../fixtures/benchmark/longmemeval/longmemeval-mini-indices.json');
    if (existsSync(miniIndicesPath)) {
      const indices = JSON.parse(readFileSync(miniIndicesPath, 'utf-8')) as number[];
      questionsToRun = indices.map((i) => dataset[i]!).filter(Boolean);
      console.log('Mini mode: ' + questionsToRun.length + ' stratified questions');
    } else {
      console.error('Mini indices not found. Run create-longmemeval-mini.py first.');
      process.exit(1);
    }
  } else {
    questionsToRun = dataset.slice(0, limit);
  }
  console.log(`LongMemEval: ${questionsToRun.length} questions, mode=${mode}, maxRules=${maxRules}`);
  console.log(`Answer: ${answerModel}, Judge: ${judgeModel}, seedAssistant: ${seedAssistant}`);
  console.log('Seed mode: dispatch.ingest(), engine extraction (S67 Phase 1B end-to-end)');

  interface Result {
    question_id: string;
    question_type: string;
    question: string;
    expected: string;
    predicted: string;
    /** Classifier-collapse (S77): model that produced the answer + classifier output. */
    answer_model: string;
    query_type: string;
    correct: boolean;
    facts_seeded: number;
    retrieval_ms: number;
    total_ms: number;
  }

  const results: Result[] = [];

  for (let i = 0; i < questionsToRun.length; i++) {
    const entry = questionsToRun[i]!;
    const totalStart = performance.now();
    const normalizedAnswer = Array.isArray(entry.answer) ? entry.answer.join('; ') : String(entry.answer ?? '');

    // Fresh isolated repo per question
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const stone = maybeStoneForMaterializer(repo);
    const dispatch = createCoreDispatch(repo, config, stone);

    // S67 Phase 1B: per-question partition. Seed and answer use the same userId.
    const userId = `lme-q-${entry.question_id}`;

    // Seed memories
    let seeded = 0;
    let totalIngestExtracted = 0;
    let totalIngestRejected = 0;
    const sessions = entry.haystack_sessions || entry.sessions || [];
    const sessionDates: string[] = entry.haystack_dates || [];

    // S67 Phase 1B SEEDING: each session is fed to dispatch.ingest() as one
    // chat-formatted block ("user: ...\nassistant: ..."). Engine extraction
    // pulls atomic claims and writes through trust pipeline. multiSpeaker:
    // true so the extractor knows to attribute claims correctly across roles.
    // The cache-coupling between multiSpeaker and prompt namespace
    // (src/cache/cache-store.ts: key includes the prompt header text) means
    // flipping this flag invalidates ~5000 cached extractions. Stay on the
    // warm namespace and address attribution failures via Plan 2.5b first.
    const effectiveSeedAssistant = seedAssistant;
    for (let si = 0; si < sessions.length; si++) {
      const session = sessions[si]!;
      const msgs = Array.isArray(session) ? session : session.messages || session.conversation || [];
      // Format messages into chat-style text. Filter very short messages
      // (length < 10) which are usually noise.
      const formatted = msgs
        .filter(
          (m: any) =>
            (m.role === 'user' || (effectiveSeedAssistant && m.role === 'assistant')) &&
            m.content &&
            m.content.length >= 10,
        )
        .map((m: any) => `${m.role}: ${m.content}`)
        .join('\n');
      if (formatted.length < 50) continue;

      const sessionAsserted = parseLmeDate(sessionDates[si]);
      try {
        // S75: wrap dispatch.ingest in withTrace so internal spans emit.
        const result = await withTrace(
          {
            entry: 'bench',
            user_id: userId,
            tags: { bench: 'lme', op: 'ingest', question_id: entry.question_id, session_index: si },
          },
          () =>
            dispatch.ingest(formatted, {
              user_id: userId,
              conversation_id: `${userId}-session-${si}`,
              asserted_at: sessionAsserted,
              source: 'imported',
              multiSpeaker: true,
              metadata: { bench: 'lme', question_id: entry.question_id, session_index: si },
            }),
        );
        seeded += result.written.filter((w) => w.action !== 'rejected').length;
        totalIngestExtracted += result.extracted_count;
        totalIngestRejected += result.rejected_count;
        if (result.errors.length > 0 && i < 3) {
          for (const e of result.errors) {
            console.log(`INGEST_ERR [Q ${i + 1} session ${si} stage ${e.stage}]:`, e.error.substring(0, 120));
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i < 3) console.log(`INGEST_THROW [Q ${i + 1} session ${si}]:`, msg.substring(0, 120));
      }
    }

    // R11: Post-seed hooks
    if (seeded > 0) {
      try {
        const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
        if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
          if (i < 5)
            console.log(
              `    R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`,
            );
        }
      } catch (hookErr: any) {
        if (i < 3) console.log('    R11 hooks failed:', hookErr?.message?.substring(0, 80));
      }
    }

    if (seeded === 0) {
      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        expected: normalizedAnswer,
        predicted: '',
        answer_model: '',
        query_type: '',
        correct: false,
        facts_seeded: 0,
        retrieval_ms: 0,
        total_ms: performance.now() - totalStart,
      });
      console.log(
        `  [${i + 1}/${questionsToRun.length}] ${entry.question_id}: SKIP (0 seeded, extraction may have produced no claims)`,
      );
      await repo.close();
      continue;
    }

    // S67 LOCKDOWN sanity probe: confirm seed produced retrievable memories
    // in the per-question partition. Phase 1B writes to userId=lme-q-{id}
    // and the answer call below also passes the same userId.
    //
    // S74 PR#82 fix: query with a REAL subject from the seeded data so
    // the rerank confidence floor (when RERANKER_ENABLED=true) doesn't
    // produce a false "partition mismatch" abort. See
    // docs/internal/SANITY_PROBE_FIX_TICKET.md.
    {
      const probeRow = await repo.getOneByUser(userId);
      if (!probeRow) {
        console.error(
          `FATAL: Question ${entry.question_id} seeded ${seeded} memories but repo.getOneByUser('${userId}') returned null. Partition mismatch confirmed at the SQL layer. Aborting bench.`,
        );
        process.exit(1);
      }
      // S74 probe fix: raw claim text, see benchmark-locomo-official.ts
      // for rationale.
      const probeQuery = probeRow.claim;
      const probe = await withTrace(
        { entry: 'bench', user_id: userId, tags: { bench: 'lme', op: 'sanity_probe' } },
        () => dispatch.search(probeQuery, 5, undefined, userId, undefined),
      );
      const probeCount = probe.payload.memories.length;
      if (probeCount === 0) {
        console.error(
          `FATAL: Question ${entry.question_id} seeded ${seeded} memories but probe retrieval (query='${probeQuery}') found 0 in user partition '${userId}'. Partition mismatch detected. Aborting bench. (S67 sanity probe, see CHEAT_LOG.md.)`,
        );
        process.exit(1);
      }
    }

    // Per-question "now" anchor. Prefer the dataset's question_date (the moment
    // the question is actually posed); fall back to the latest session date only
    // when it is absent. Anchoring to the latest session date alone gives the
    // wrong reference for elapsed-time questions ("how many weeks ago"): the model
    // computes against the last session instead of when the user asked, which is
    // the H3 now-anchoring failure from the audit.
    let convNowIso: string | undefined = entry.question_date ? parseLmeDate(entry.question_date) : undefined;
    if (!convNowIso && sessionDates.length > 0) {
      const parsed = sessionDates.map((d) => parseLmeDate(d)).filter((s): s is string => Boolean(s));
      if (parsed.length > 0) {
        const ms = parsed.map((s) => new Date(s).getTime()).filter((n) => !Number.isNaN(n));
        if (ms.length > 0) convNowIso = new Date(Math.max(...ms)).toISOString();
      }
    }

    try {
      // S65 prompt-honesty: bench goes through the public dispatch.answer()
      // path. Engine classifies, picks per-category prompt, applies routed
      // model. No bench-side prompt construction.
      // S67 Phase 1B: pass userId so the partition matches the seed.
      const retStart = performance.now();
      const result = await withTrace(
        {
          entry: 'bench',
          user_id: userId,
          tags: {
            bench: 'lme',
            question_id: entry.question_id,
            question_type: entry.question_type,
          },
        },
        () =>
          dispatch.answer(entry.question, {
            model: answerModel,
            maxRules,
            nowIso: convNowIso,
            userId,
          }),
      );
      const retrievalMs = performance.now() - retStart;
      const searchResult = result.search;
      const predicted = result.answer;

      // Judge (GPT-4o standard LongMemEval prompt)
      const judgePrompt = `You are evaluating a memory system's answer.

Question: ${entry.question}
Reference answer: ${normalizedAnswer}
System answer: ${predicted}

Is the system answer correct? Accept paraphrases and equivalent information. Respond ONLY with "yes" or "no".`;

      // S65 Sprint 1 (M9): persistent judge cache.
      const judgeRes = await callJudgeCached({
        model: judgeModel,
        system: '',
        user: judgePrompt,
        predicted,
        cacheTag: 'lme-launcher',
        llmCacheKey: 'demiurge:lme-launcher:judge:v1',
      });
      const judgeText = judgeRes.verdict;

      const correct = judgeText.startsWith('yes');
      const totalMs = performance.now() - totalStart;

      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        expected: normalizedAnswer,
        predicted,
        answer_model: result.model,
        query_type: searchResult.raw.metadata.queryType,
        correct,
        facts_seeded: seeded,
        retrieval_ms: retrievalMs,
        total_ms: totalMs,
      });

      const status = correct ? 'PASS' : 'FAIL';
      if (i < 10) {
        console.log(
          `  [${i + 1}/${questionsToRun.length}] ${entry.question_type}: ${status} (${seeded} written / ${totalIngestExtracted} extracted, ${Math.round(totalMs)}ms)`,
        );
        console.log(`    Q: ${entry.question.substring(0, 80)}`);
        console.log(`    Expected: ${normalizedAnswer.substring(0, 80)}`);
        console.log(`    Got: ${predicted.substring(0, 80)}`);
      }

      if ((i + 1) % 50 === 0) {
        const scored = results.filter((r) => r.facts_seeded > 0);
        const c = scored.filter((r) => r.correct).length;
        console.log(
          `  [${i + 1}/${questionsToRun.length}] Running accuracy: ${scored.length > 0 ? ((c / scored.length) * 100).toFixed(1) : '0'}%`,
        );
      }
    } catch (err) {
      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        expected: normalizedAnswer,
        predicted: '',
        correct: false,
        facts_seeded: seeded,
        retrieval_ms: 0,
        total_ms: performance.now() - totalStart,
      });
      console.error(`  [${i + 1}/${questionsToRun.length}] ERROR:`, err instanceof Error ? err.message : err);
    }

    await repo.close();
  }

  // Report
  const scored = results.filter((r) => r.facts_seeded > 0);
  const skipped = results.filter((r) => r.facts_seeded === 0);
  const correct = scored.filter((r) => r.correct).length;

  const byType: Record<string, { total: number; correct: number }> = {};
  for (const r of scored) {
    if (!byType[r.question_type]) byType[r.question_type] = { total: 0, correct: 0 };
    byType[r.question_type]!.total++;
    if (r.correct) byType[r.question_type]!.correct++;
  }

  console.log('\n========== LONGMEMEVAL RESULTS ==========');
  console.log(`Mode:       ${mode}`);
  console.log(`Questions:  ${scored.length} scored, ${skipped.length} skipped`);
  console.log(`Accuracy:   ${((correct / scored.length) * 100).toFixed(1)}% (${correct}/${scored.length})`);
  console.log(`Retrieval:  mean ${(scored.reduce((s, r) => s + r.retrieval_ms, 0) / scored.length).toFixed(0)}ms`);

  console.log('\nBy category:');
  for (const [type, counts] of Object.entries(byType).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${type}: ${((counts.correct / counts.total) * 100).toFixed(1)}% (${counts.correct}/${counts.total})`,
    );
  }

  // S66: backfill manifest with sample size before stamping into report.
  manifest.sample_size = scored.length;

  const report = {
    benchmark: 'longmemeval-s',
    mode,
    timestamp: new Date().toISOString(),
    config: { maxRules, answerModel, judgeModel, mode },
    summary: { total: scored.length, correct, accuracy: correct / scored.length, skipped: skipped.length },
    byType,
    results,
    manifest,
  };

  const reportPath = resolve(
    outputDir,
    manifestedFilename({ bench: 'longmemeval', scope: manifest.scope_label, manifest }),
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
