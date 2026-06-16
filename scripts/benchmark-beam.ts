#!/usr/bin/env npx tsx
// ADAPTER_MODE: PRODUCT_PATH (S67 Phase 1B end-to-end, feeds raw chunks
// through dispatch.ingest() so engine extraction runs in the bench loop,
// matching what real users get from the public API).
/**
 * BEAM Benchmark Runner
 * Runs BEAM 100K (20 conversations, 400 questions, nugget-based scoring).
 *
 * S67 Phase 1B: chunks are fed to dispatch.ingest() per-chunk. The engine's
 * own extraction pipeline (gpt-4.1-nano default, persistent cache) splits
 * each chunk into atomic claims; trust pipeline writes them through the
 * same path production users hit. No bench-only addMemory shortcut.
 *
 * Per-conv user partition: `beam-conv-${convId}`. Seed and answer must
 * use the same userId or partition mismatch silently kills retrieval.
 * Sanity probe at end of seed catches mismatches before answer phase.
 *
 * Usage:
 *   npx tsx scripts/benchmark-beam.ts                           # Full 100K
 *   npx tsx scripts/benchmark-beam.ts --limit-convs 3           # First 3 convs
 *   npx tsx scripts/benchmark-beam.ts --mini                    # Mini sample
 *   npx tsx scripts/benchmark-beam.ts --judge-model gpt-4.1-mini
 */
import { resolve, dirname } from 'node:path';
import { callJudgeCached } from '../src/benchmark/judge-cache.js';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { computeManifest, manifestedFilename, AdapterMode } from '../src/benchmark/lib/manifest.js';
import { maybeStoneForMaterializer } from '../src/benchmark/lib/stone-wiring.js';
import { withTrace } from '../src/telemetry/index.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ABILITIES = [
  'abstention',
  'contradiction_resolution',
  'event_ordering',
  'information_extraction',
  'instruction_following',
  'knowledge_update',
  'multi_session_reasoning',
  'preference_following',
  'summarization',
  'temporal_reasoning',
] as const;
type Ability = (typeof ABILITIES)[number];
interface BeamQuestion {
  question: string;
  answer?: string;
  ideal_response?: string;
  difficulty: string;
  rubric: string[];
  [key: string]: unknown;
}
interface BeamResult {
  conv_id: string;
  ability: Ability;
  question: string;
  expected: string;
  predicted: string;
  /** Classifier-collapse (S77): model that produced the answer + classifier output. */
  answer_model: string;
  query_type: string;
  nugget_scores: boolean[];
  nugget_score: number;
  difficulty: string;
  facts_seeded: number;
  retrieval_ms: number;
  total_ms: number;
}

/**
 * Parse BEAM's time_anchor format ("March-15-2024") into an ISO 8601 string
 * suitable for `dispatch.ingest`'s `asserted_at` opt. Returns undefined for
 * unparseable input, engine falls back to wall-clock.
 */
function parseBeamDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // JS Date can parse "Month DD YYYY" with spaces but rejects "Month-DD-YYYY".
  const normalized = raw.replace(/-/g, ' ');
  const ms = new Date(normalized).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

async function main() {
  // S59A: bench-env preamble
  const { ensureBenchEnv } = await import('../src/benchmark/lib/bench-env.js');
  const { initBenchTelemetry } = await import('../src/benchmark/lib/bench-telemetry.js');
  ensureBenchEnv('beam');
  initBenchTelemetry();
  // S68 cache-warm probe (brain #2184)
  const { probe, printBanner } = await import('./cache-warm-probe.js');
  const _probeResult = probe('beam');
  printBanner(_probeResult);
  if (_probeResult.status === 'COLD' && process.env.BENCH_COLD_OK !== '1') {
    console.error('ABORT: cache COLD and BENCH_COLD_OK not set. Bypass with BENCH_COLD_OK=1.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const getArg = (flag: string, fallback: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1]! : fallback;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);
  const limitConvs = parseInt(getArg('--limit-convs', '999'), 10);
  const size = getArg('--size', '100K');
  const maxRules = parseInt(getArg('--max-rules', '65'), 10);
  const answerModel = getArg('--answer-model', 'gpt-4.1-mini');
  const judgeModel = getArg('--judge-model', 'gpt-4o-mini');
  const mini = hasFlag('--mini');
  const seedAssistant = hasFlag('--seed-assistant');
  // S66 KILL-ALL-CHEATS: --adaptive-gate flag removed (was bench-only score-chase knob).

  // S63: --routed opts back into routing after the bench-env default turns it
  // off for mini iteration mode (per #1559). Mirrors the LOCOMO runner pattern.
  // Required for publish-time runs and apples-to-apples comparison against
  // routed historical baselines (e.g. Apr 20 BEAM 100K mini @ 60.20%).
  const routedMode = hasFlag('--routed');
  if (routedMode) {
    process.env.ANSWER_ROUTING = 'false';
    console.log('[bench-flag] --routed IGNORED: routing force-disabled in all benches (S78, Preston)');
  }

  // S63 Tier 0.4: result manifest. Computed AFTER ensureBenchEnv + --routed
  // mutations so it captures the canonical run state. Backfilled with
  // sample_size and nowIso_passed at end-of-run.
  const allowDirtyRunner = hasFlag('--allow-dirty-runner');
  let anyConvHadNowIso = false;
  const manifest = computeManifest({
    runnerPath: 'scripts/benchmark-beam.ts',
    modelPins: {
      answer: routedMode ? 'routing-on' : answerModel,
      judge: judgeModel,
      embed: 'BAAI/bge-small-en-v1.5',
    },
    fixtureVersion: `beam-${size.toLowerCase()}${mini ? '-mini-indices-v1' : '-v1'}`,
    scorerVersion: 'beam-nugget-judge-v1',
    adapterMode: AdapterMode.PRODUCT_PATH,
    sampleSize: 0,
    scopeLabel: mini ? 'mini' : 'full',
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

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-beam-demiurge-2026-eval';
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

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embedding model loaded');

  let miniIndices: Map<string, Set<string>> | null = null;
  if (mini) {
    const miniFileIdx = args.indexOf('--mini-file');
    const miniPath =
      miniFileIdx !== -1
        ? resolve(args[miniFileIdx + 1]!)
        : resolve(__dirname, '../fixtures/benchmark/beam/beam-mini-indices.json');
    if (existsSync(miniPath)) {
      const raw = JSON.parse(readFileSync(miniPath, 'utf-8')) as Record<string, string[]>;
      miniIndices = new Map();
      for (const [convId, abilities] of Object.entries(raw)) {
        miniIndices.set(convId, new Set(abilities));
      }
      console.log(`Loaded mini indices: ${miniIndices.size} conversations`);
    } else {
      console.error('Mini indices not found at', miniPath);
      process.exit(1);
    }
  }

  // S75: BEAM_DATA_ROOT overrides the dataset path so 500K/1M tiers can be
  // run from /root/beam-full/chats/<size>. Default keeps the legacy
  // /root/beam-benchmark/chats path for 100K.
  const beamDataRoot = process.env.BEAM_DATA_ROOT || '/root/beam-benchmark/chats';
  const datasetDir = resolve(`${beamDataRoot}/${size}`);
  if (!existsSync(datasetDir)) {
    console.error('Dataset not found:', datasetDir);
    process.exit(1);
  }
  const convDirs = readdirSync(datasetDir)
    .filter((d) => existsSync(resolve(datasetDir, d, 'chat.json')))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .slice(0, limitConvs);

  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');

  console.log(`BEAM ${size}: ${convDirs.length} conversations, maxRules=${maxRules}`);
  console.log(`Answer: ${answerModel}, Judge: ${judgeModel}`);
  console.log(`Seed mode: dispatch.ingest(), engine extraction (S67 Phase 1B end-to-end)`);

  const allResults: BeamResult[] = [];

  for (let ci = 0; ci < convDirs.length; ci++) {
    const convId = convDirs[ci]!;
    const convDir = resolve(datasetDir, convId);
    const convStart = performance.now();

    const questionsPath = resolve(convDir, 'probing_questions/probing_questions.json');
    if (!existsSync(questionsPath)) {
      console.log(`  [Conv ${convId}] No questions, skipping`);
      continue;
    }
    if (miniIndices && !miniIndices.has(convId)) {
      continue;
    }
    const questionsMap = JSON.parse(readFileSync(questionsPath, 'utf-8')) as Record<Ability, BeamQuestion[]>;

    const userMsgsPath = resolve(convDir, 'user_messages.json');
    const chatPath = resolve(convDir, 'chat.json');

    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const stone = maybeStoneForMaterializer(repo);
    const dispatch = createCoreDispatch(repo, config, stone);

    // S67 Phase 1B: per-conv partition. Seed and answer must use the same
    // userId or retrieval finds nothing.
    const userId = `beam-conv-${convId}`;

    let seeded = 0;
    const userMessages: Array<{ content: string; time_anchor?: string }> = [];

    // R11: seed-assistant (adaptive-gate removed S66 #cheat-cleanup)
    const includeAssistant = seedAssistant;
    const roleFilter = (role: string) => role === 'user' || (includeAssistant && role === 'assistant');

    const allMessages: Array<{ content: string; time_anchor?: string; role: string }> = [];
    if (!seedAssistant && existsSync(userMsgsPath)) {
      const batches = JSON.parse(readFileSync(userMsgsPath, 'utf-8')) as Array<{
        batch: number;
        time_anchor: string;
        messages: Array<{ role: string; content: string }>;
      }>;
      for (const batch of batches) {
        for (const msg of batch.messages) {
          if (roleFilter(msg.role) && msg.content && msg.content.length >= 10) {
            allMessages.push({ content: msg.content, time_anchor: batch.time_anchor, role: msg.role });
          }
        }
      }
    } else if (existsSync(chatPath)) {
      const chatBatches = JSON.parse(readFileSync(chatPath, 'utf-8')) as Array<{
        batch_number: number;
        turns: Array<Array<{ role: string; content: string; time_anchor?: string }>>;
      }>;
      for (const batch of chatBatches) {
        for (const turn of batch.turns) {
          for (const msg of turn) {
            if (roleFilter(msg.role) && msg.content && msg.content.length >= 10) {
              allMessages.push({ content: msg.content, time_anchor: msg.time_anchor, role: msg.role });
            }
          }
        }
      }
    }

    // S66 KILL-ALL-CHEATS: adaptive-gate logic removed. messagesToSeed = allMessages.
    const messagesToSeed = allMessages;

    for (const msg of messagesToSeed) {
      userMessages.push({ content: msg.content, time_anchor: msg.time_anchor });
    }

    // S67 Phase 1B SEEDING: chunk user messages into ~1500-char blocks (same
    // chunk boundaries as before, comparable corpus shape). Each chunk is
    // fed to dispatch.ingest(), which runs the engine's own extraction
    // (gpt-4.1-nano default, cached) and writes resulting atomic claims
    // through the trust pipeline. Per-claim atomicity: extraction failure
    // on one chunk doesn't abort others; trust-pipeline rejection of one
    // claim doesn't reject siblings.
    let chunkIdx = 0;
    let totalIngestExtracted = 0;
    let totalIngestRejected = 0;
    let chunk = '';
    let chunkAnchor = '';
    const ingestChunk = async (text: string, anchor: string, idx: number): Promise<void> => {
      if (text.trim().length < 10) return;
      try {
        // S75: wrap dispatch.ingest in withTrace so internal spans emit.
        const result = await withTrace(
          {
            entry: 'bench',
            user_id: userId,
            tags: { bench: 'beam', op: 'ingest', conv_id: convId, chunk_idx: idx },
          },
          () =>
            dispatch.ingest(text.trim(), {
              user_id: userId,
              conversation_id: `${userId}-chunk-${idx}`,
              asserted_at: parseBeamDate(anchor),
              source: 'imported',
              multiSpeaker: false,
              metadata: { bench: 'beam', conv_id: convId, chunk_idx: idx },
            }),
        );
        seeded += result.written.filter((w) => w.action !== 'rejected').length;
        totalIngestExtracted += result.extracted_count;
        totalIngestRejected += result.rejected_count;
        if (result.errors.length > 0) {
          for (const e of result.errors) {
            console.log(`INGEST_ERR [chunk ${idx}, stage ${e.stage}]:`, e.error.substring(0, 120));
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`INGEST_THROW [chunk ${idx}]:`, msg.substring(0, 120));
      }
    };

    for (const msg of userMessages) {
      const cleaned = msg.content.replace(/\s*->->\s*[\d,]+\s*$/, '').trim();
      if (cleaned.length < 10) continue;
      const capped = cleaned.substring(0, 1800);
      if (chunk.length + capped.length > 1500 && chunk.length > 0) {
        await ingestChunk(chunk, chunkAnchor, chunkIdx);
        chunkIdx++;
        chunk = '';
      }
      chunkAnchor = msg.time_anchor || chunkAnchor;
      chunk += capped + ' ';
    }
    // Flush final chunk
    if (chunk.trim().length > 10) {
      await ingestChunk(chunk, chunkAnchor, chunkIdx);
      chunkIdx++;
    }

    console.log(
      `  [Conv ${convId}] Ingested ${chunkIdx} chunks: ${totalIngestExtracted} claims extracted, ${seeded} written, ${totalIngestRejected} rejected (from ${userMessages.length} user messages)`,
    );

    // R11: Post-seed hooks
    try {
      const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
      if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
        console.log(
          `    R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`,
        );
      }
    } catch (hookErr: any) {
      console.log('    R11 hooks failed:', hookErr?.message?.substring(0, 80));
    }
    if (seeded === 0) {
      console.log(`  [Conv ${convId}] SKIP (0 seeded, extraction may have produced no claims)`);
      await repo.close();
      continue;
    }

    // S67 LOCKDOWN sanity probe: confirm seed produced retrievable memories
    // in the per-conv partition. Phase 1B writes to userId=beam-conv-{convId}
    // and the answer call below also passes the same userId. If anyone
    // diverges that, partition mismatch fires silently, probe catches it.
    //
    // S74 PR#82 fix: query with a REAL subject from the seeded data so the
    // rerank confidence floor (when RERANKER_ENABLED=true) doesn't produce
    // a false "partition mismatch" abort. See
    // docs/internal/SANITY_PROBE_FIX_TICKET.md.
    {
      const probeRow = await repo.getOneByUser(userId);
      if (!probeRow) {
        console.error(
          `FATAL: Conv ${convId} seeded ${seeded} memories but repo.getOneByUser('${userId}') returned null. Partition mismatch confirmed at the SQL layer. Aborting bench.`,
        );
        process.exit(1);
      }
      // S74 probe fix: raw claim text, see benchmark-locomo-official.ts
      // for rationale.
      const probeQuery = probeRow.claim;
      const probe = await withTrace(
        { entry: 'bench', user_id: userId, tags: { bench: 'beam', op: 'sanity_probe' } },
        () => dispatch.search(probeQuery, 5, undefined, userId, undefined),
      );
      const probeCount = probe.payload.memories.length;
      if (probeCount === 0) {
        console.error(
          `FATAL: Conv ${convId} seeded ${seeded} memories but probe retrieval (query='${probeQuery}') found 0 in user partition '${userId}'. Partition mismatch detected. Aborting bench. (S67 sanity probe, see CHEAT_LOG.md.)`,
        );
        process.exit(1);
      }
    }

    // S63 (B19-D): compute the conversation's "now" anchor from the latest
    // user-message time_anchor. The latest time_anchor = the most recent
    // moment in the user's timeline that the engine has memory of, so it's
    // the closest approximation to "when the user is asking the question."
    // Without this, the answer model uses the server wall-clock (May 2026)
    // for 2023-anchored conversations and hallucinates relative-date
    // answers regardless of memory content. Brain #2044.
    let convNowIso: string | undefined = undefined;
    const anchors = userMessages.map((m) => m.time_anchor).filter((a): a is string => Boolean(a));
    if (anchors.length > 0) {
      const parsedIso = anchors.map((a) => parseBeamDate(a)).filter((s): s is string => Boolean(s));
      if (parsedIso.length > 0) {
        const parsedMs = parsedIso.map((s) => new Date(s).getTime()).filter((ms) => !Number.isNaN(ms));
        if (parsedMs.length > 0) {
          convNowIso = new Date(Math.max(...parsedMs)).toISOString();
        }
      }
    }
    if (convNowIso) anyConvHadNowIso = true;
    console.log(`  [Conv ${convId}] nowIso anchor: ${convNowIso ?? '(unset, falls back to wall-clock)'}`);

    for (const ability of ABILITIES) {
      const questions = questionsMap[ability] || [];
      if (!questions.length) continue;
      if (miniIndices && (!miniIndices.has(convId) || !miniIndices.get(convId)!.has(ability))) continue;

      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi]!;
        const qStart = performance.now();
        const expectedAnswer = q.answer || q.ideal_response || '';
        const rubricNuggets = q.rubric || [];

        try {
          // S65 prompt-honesty: bench goes through the public dispatch.answer()
          // path. Engine classifies the query, picks the per-category prompt,
          // applies the routed model, and prepends the conversation now-anchor
          // from opts.nowIso. No bench-side prompt construction.
          // S67 Phase 1B: pass userId so the partition matches the seed.
          const retStart = performance.now();
          const result = await withTrace(
            {
              entry: 'bench',
              user_id: userId,
              tags: {
                bench: 'beam',
                size,
                question: q.question.slice(0, 60),
              },
            },
            () =>
              dispatch.answer(q.question, {
                model: answerModel,
                maxRules,
                nowIso: convNowIso,
                userId,
              }),
          );
          const retrievalMs = performance.now() - retStart;
          const searchResult = result.search;
          const predicted = result.answer;

          const nuggetScores: boolean[] = [];
          for (const nugget of rubricNuggets) {
            const judgePrompt = `You are evaluating whether a system's response contains a specific piece of information (nugget).\n\nQuestion: ${q.question}\nSystem response: ${predicted}\n\nNugget to check: ${nugget}\n\nDoes the system response contain or convey the information described in the nugget? Accept paraphrases and equivalent information. Respond ONLY with "yes" or "no".`;
            // S65 Sprint 1 (M9): persistent judge cache.
            const judgeRes = await callJudgeCached({
              model: judgeModel,
              system: '',
              user: judgePrompt,
              predicted,
              cacheTag: 'beam-launcher',
              llmCacheKey: 'demiurge:beam-launcher:judge:v1',
            });
            const judgeText = judgeRes.verdict;
            nuggetScores.push(judgeText.startsWith('yes'));
          }

          const nuggetScore = rubricNuggets.length > 0 ? nuggetScores.filter(Boolean).length / rubricNuggets.length : 0;
          const totalMs = performance.now() - qStart;

          allResults.push({
            conv_id: convId,
            ability,
            question: q.question,
            expected: expectedAnswer,
            predicted,
            answer_model: result.model,
            query_type: searchResult.raw.metadata.queryType,
            nugget_scores: nuggetScores,
            nugget_score: nuggetScore,
            difficulty: q.difficulty,
            facts_seeded: seeded,
            retrieval_ms: retrievalMs,
            total_ms: totalMs,
          });

          if (qi === 0) {
            console.log(
              `    ${ability}: ${(nuggetScore * 100).toFixed(0)}% (${nuggetScores.filter(Boolean).length}/${rubricNuggets.length} nuggets)`,
            );
            console.log(`      Q: ${q.question.substring(0, 80)}`);
            console.log(`      Got: ${predicted.substring(0, 80)}`);
          }
        } catch (err) {
          allResults.push({
            conv_id: convId,
            ability,
            question: q.question,
            expected: expectedAnswer,
            predicted: '',
            answer_model: '',
            query_type: '',
            nugget_scores: [],
            nugget_score: 0,
            difficulty: q.difficulty,
            facts_seeded: seeded,
            retrieval_ms: 0,
            total_ms: performance.now() - qStart,
          });
          console.error(`    ${ability} Q${qi}: ERROR:`, err instanceof Error ? err.message : err);
        }
      }
    }

    const convMs = performance.now() - convStart;
    const convResults = allResults.filter((r) => r.conv_id === convId);
    const convScore =
      convResults.length > 0 ? convResults.reduce((s, r) => s + r.nugget_score, 0) / convResults.length : 0;
    console.log(
      `  [Conv ${convId}] Done: ${(convScore * 100).toFixed(1)}% avg (${convResults.length} Qs, ${Math.round(convMs / 1000)}s)`,
    );
    await repo.close();
  }

  // Report
  console.log('\n========== BEAM RESULTS ==========');
  console.log(`Dataset:    ${size} (${convDirs.length} conversations)`);
  console.log(`Questions:  ${allResults.length}`);
  const overallScore =
    allResults.length > 0 ? allResults.reduce((s, r) => s + r.nugget_score, 0) / allResults.length : 0;
  console.log(`Overall:    ${(overallScore * 100).toFixed(1)}%`);

  const byAbility: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) {
    if (!byAbility[r.ability]) byAbility[r.ability] = { total: 0, scoreSum: 0 };
    byAbility[r.ability]!.total++;
    byAbility[r.ability]!.scoreSum += r.nugget_score;
  }
  console.log('\nBy ability:');
  for (const [ability, counts] of Object.entries(byAbility).sort(
    (a, b) => b[1].scoreSum / b[1].total - a[1].scoreSum / a[1].total,
  )) {
    console.log(`  ${ability}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`);
  }

  const byDiff: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) {
    if (!byDiff[r.difficulty]) byDiff[r.difficulty] = { total: 0, scoreSum: 0 };
    byDiff[r.difficulty]!.total++;
    byDiff[r.difficulty]!.scoreSum += r.nugget_score;
  }
  console.log('\nBy difficulty:');
  for (const [d, counts] of Object.entries(byDiff).sort(
    (a, b) => b[1].scoreSum / b[1].total - a[1].scoreSum / a[1].total,
  )) {
    console.log(`  ${d}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`);
  }

  const byConv: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) {
    if (!byConv[r.conv_id]) byConv[r.conv_id] = { total: 0, scoreSum: 0 };
    byConv[r.conv_id]!.total++;
    byConv[r.conv_id]!.scoreSum += r.nugget_score;
  }
  console.log('\nBy conversation:');
  for (const [cid, counts] of Object.entries(byConv).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`  Conv ${cid}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`);
  }

  const meanRetMs = allResults.reduce((s, r) => s + r.retrieval_ms, 0) / allResults.length;
  console.log(`\nRetrieval:  mean ${meanRetMs.toFixed(0)}ms`);

  manifest.sample_size = allResults.length;
  manifest.nowIso_passed = anyConvHadNowIso;

  const report = {
    benchmark: `beam-${size.toLowerCase()}`,
    timestamp: new Date().toISOString(),
    manifest,
    config: { size, maxRules, answerModel, judgeModel, mini, routed: process.env.ANSWER_ROUTING === 'true' },
    summary: { total: allResults.length, overallScore, conversations: convDirs.length },
    byAbility,
    byDiff,
    byConv,
    results: allResults,
  };
  const reportPath = resolve(
    outputDir,
    manifestedFilename({
      bench: `beam-${size.toLowerCase()}`,
      scope: manifest.scope_label,
      manifest,
    }),
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);

  // S59 / TEMPR: degraded-rate gate. Throws if rerank degraded ≥ 1% over the run.
  const { assertRerankDegradedBelow } = await import('../src/benchmark/shared/rerank-telemetry.js');
  assertRerankDegradedBelow(0.01, 'BEAM');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
