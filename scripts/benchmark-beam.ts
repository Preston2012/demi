#!/usr/bin/env npx tsx
/**
 * BEAM Benchmark Runner
 * Runs BEAM 100K (20 conversations, 400 questions, nugget-based scoring).
 *
 * Usage:
 *   npx tsx scripts/benchmark-beam.ts                           # Full 100K
 *   npx tsx scripts/benchmark-beam.ts --limit-convs 3           # First 3 convs
 *   npx tsx scripts/benchmark-beam.ts --mini                    # Mini sample
 *   npx tsx scripts/benchmark-beam.ts --judge-model gpt-4.1-mini
 */
import { resolve, dirname } from 'node:path';
import { routeAnswerModel } from "../src/answer/router.js";
import { callLLM } from '../src/benchmark/llm-caller.js';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ABILITIES = ['abstention','contradiction_resolution','event_ordering','information_extraction','instruction_following','knowledge_update','multi_session_reasoning','preference_following','summarization','temporal_reasoning'] as const;
type Ability = typeof ABILITIES[number];
interface BeamQuestion { question: string; answer?: string; ideal_response?: string; difficulty: string; rubric: string[]; [key: string]: unknown; }
interface BeamResult { conv_id: string; ability: Ability; question: string; expected: string; predicted: string; nugget_scores: boolean[]; nugget_score: number; difficulty: string; facts_seeded: number; retrieval_ms: number; total_ms: number; }

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string, fallback: string): string => { const idx = args.indexOf(flag); return idx !== -1 ? args[idx + 1]! : fallback; };
  const hasFlag = (flag: string): boolean => args.includes(flag);
  const limitConvs = parseInt(getArg('--limit-convs', '999'), 10);
  const size = getArg('--size', '100K');
  const maxRules = parseInt(getArg('--max-rules', '65'), 10);
  const answerModel = getArg('--answer-model', 'gpt-4o-mini');
  const judgeModel = getArg('--judge-model', 'gpt-4.1-mini');
  const mini = hasFlag('--mini');
  const seedAssistant = hasFlag('--seed-assistant');
  const adaptiveGate = hasFlag('--adaptive-gate');
  const ADAPTIVE_GATE_THRESHOLD = parseInt(process.env.ADAPTIVE_GATE_THRESHOLD || '200', 10);

  process.env.AUTH_TOKEN = process.env.AUTH_TOKEN || 'set-your-auth-token';
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey && !anthropicKey) { console.error('Need OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embedding model loaded');

  let miniIndices: Map<string, Set<string>> | null = null;
  if (mini) {
    const miniFileIdx = args.indexOf('--mini-file');
    const miniPath = miniFileIdx !== -1 ? resolve(args[miniFileIdx + 1]!) : resolve(__dirname, '../fixtures/benchmark/beam/beam-mini-indices.json');
    if (existsSync(miniPath)) {
      const raw = JSON.parse(readFileSync(miniPath, 'utf-8')) as Record<string, string[]>;
      miniIndices = new Map();
      for (const [convId, abilities] of Object.entries(raw)) { miniIndices.set(convId, new Set(abilities)); }
      console.log(`Loaded mini indices: ${miniIndices.size} conversations`);
    } else { console.error('Mini indices not found at', miniPath); process.exit(1); }
  }

  const datasetDir = resolve(`./fixtures/benchmark/beam/chats/${size}`);
  if (!existsSync(datasetDir)) { console.error('Dataset not found:', datasetDir); process.exit(1); }
  const convDirs = readdirSync(datasetDir).filter(d => existsSync(resolve(datasetDir, d, 'chat.json'))).sort((a, b) => parseInt(a) - parseInt(b)).slice(0, limitConvs);

  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { classifyQuery } = await import('../src/retrieval/query-classifier.js');
  const { CATEGORY_PROMPTS } = await import('../src/inject/prompts.js');

  console.log(`BEAM ${size}: ${convDirs.length} conversations, maxRules=${maxRules}`);
  console.log(`Answer: ${answerModel}, Judge: ${judgeModel}`);

  const allResults: BeamResult[] = [];

  for (let ci = 0; ci < convDirs.length; ci++) {
    const convId = convDirs[ci]!;
    const convDir = resolve(datasetDir, convId);
    const convStart = performance.now();

    const questionsPath = resolve(convDir, 'probing_questions/probing_questions.json');
    if (!existsSync(questionsPath)) { console.log(`  [Conv ${convId}] No questions, skipping`); continue; }
    if (miniIndices && !miniIndices.has(convId)) { continue; }
    const questionsMap = JSON.parse(readFileSync(questionsPath, 'utf-8')) as Record<Ability, BeamQuestion[]>;

    const userMsgsPath = resolve(convDir, 'user_messages.json');
    const chatPath = resolve(convDir, 'chat.json');

    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    let seeded = 0;
    const userMessages: Array<{ content: string; time_anchor?: string }> = [];

    // R11: seed-assistant + adaptive gate
    const includeAssistant = seedAssistant;
    const roleFilter = (role: string) => role === 'user' || (includeAssistant && role === 'assistant');
    
    const allMessages: Array<{ content: string; time_anchor?: string; role: string }> = [];
    if (!seedAssistant && existsSync(userMsgsPath)) {
      const batches = JSON.parse(readFileSync(userMsgsPath, 'utf-8')) as Array<{ batch: number; time_anchor: string; messages: Array<{ role: string; content: string }>; }>;
      for (const batch of batches) { for (const msg of batch.messages) { if (roleFilter(msg.role) && msg.content && msg.content.length >= 10) { allMessages.push({ content: msg.content, time_anchor: batch.time_anchor, role: msg.role }); } } }
    } else if (existsSync(chatPath)) {
      const chatBatches = JSON.parse(readFileSync(chatPath, 'utf-8')) as Array<{ batch_number: number; turns: Array<Array<{ role: string; content: string; time_anchor?: string }>>; }>;
      for (const batch of chatBatches) { for (const turn of batch.turns) { for (const msg of turn) { if (roleFilter(msg.role) && msg.content && msg.content.length >= 10) { allMessages.push({ content: msg.content, time_anchor: msg.time_anchor, role: msg.role }); } } } }
    }

    // Adaptive gate: if too many messages, drop assistant-sourced
    let messagesToSeed = allMessages;
    if (adaptiveGate && includeAssistant && allMessages.length >= ADAPTIVE_GATE_THRESHOLD) {
      messagesToSeed = allMessages.filter(m => m.role === 'user');
      console.log(`    Adaptive gate: ${allMessages.length} msgs >= ${ADAPTIVE_GATE_THRESHOLD}, filtering to ${messagesToSeed.length} user-only`);
    }
    
    for (const msg of messagesToSeed) {
      userMessages.push({ content: msg.content, time_anchor: msg.time_anchor });
    }

    let chunk = '';
    let chunkAnchor = '';
    for (const msg of userMessages) {
      const cleaned = msg.content.replace(/\s*->->\s*[\d,]+\s*$/, '').trim();
      if (cleaned.length < 10) continue;
      const capped = cleaned.substring(0, 1800);
      if (chunk.length + capped.length > 1500 && chunk.length > 0) {
        try {
          const result = await dispatch.addMemory({ claim: chunk.trim(), subject: chunkAnchor ? 'conversation-' + chunkAnchor : 'conversation', source: 'user', confidence: 0.95 });
          if (result.action !== 'rejected') { seeded++; } else { console.log('REJECTED:', (result as any).reason); }
        } catch(e: any) { console.log('SEED_ERR:', e.message?.substring(0, 120)); }
        chunk = '';
      }
      chunkAnchor = msg.time_anchor || chunkAnchor;
      chunk += capped + ' ';
    }
    if (chunk.trim().length > 10) {
      try {
        const result = await dispatch.addMemory({ claim: chunk.trim(), subject: chunkAnchor ? 'conversation-' + chunkAnchor : 'conversation', source: 'user', confidence: 0.95 });
        if (result.action !== 'rejected') { seeded++; } else { console.log('REJECTED:', (result as any).reason); }
      } catch(e: any) { console.log('SEED_ERR:', e.message?.substring(0, 120)); }
    }

    console.log(`  [Conv ${convId}] Seeded ${seeded} memories from ${userMessages.length} user messages`);

    // R11: Post-seed hooks
    try {
      const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
      if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
        console.log(`    R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`);
      }
    } catch (hookErr: any) {
      console.log('    R11 hooks failed:', hookErr?.message?.substring(0, 80));
    }
    if (seeded === 0) { console.log(`  [Conv ${convId}] SKIP (0 seeded)`); await repo.close(); continue; }

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
          const retStart = performance.now();
          const searchResult = await dispatch.search(q.question, maxRules);
          const retrievalMs = performance.now() - retStart;

          const queryType = classifyQuery(q.question);
          const basePrompt = CATEGORY_PROMPTS[queryType];
          const routed = routeAnswerModel(queryType);
          const activeModel = routed ? routed.model : answerModel;
          const fullSuffix = [process.env.ANSWER_PROMPT_SUFFIX, routed?.promptSuffix].filter(Boolean).join(" ");
          const answerPrompt = `${basePrompt}${fullSuffix ? " " + fullSuffix : ""}\n\nIMPORTANT: If the information is not available in the context, say so clearly. Do not guess.\n\nContext:\n${searchResult.contextText}`;
          const predicted = await callLLM(activeModel, answerPrompt, q.question, 200, 0);

          const nuggetScores: boolean[] = [];
          for (const nugget of rubricNuggets) {
            const judgePrompt = `You are evaluating whether a system's response contains a specific piece of information (nugget).\n\nQuestion: ${q.question}\nSystem response: ${predicted}\n\nNugget to check: ${nugget}\n\nDoes the system response contain or convey the information described in the nugget? Accept paraphrases and equivalent information. Respond ONLY with "yes" or "no".`;
            const judgeText = (await callLLM(judgeModel, "", judgePrompt, 10, 0, true)).toLowerCase().trim();
            nuggetScores.push(judgeText.startsWith('yes'));
          }

          const nuggetScore = rubricNuggets.length > 0 ? nuggetScores.filter(Boolean).length / rubricNuggets.length : 0;
          const totalMs = performance.now() - qStart;

          allResults.push({ conv_id: convId, ability, question: q.question, expected: expectedAnswer, predicted, nugget_scores: nuggetScores, nugget_score: nuggetScore, difficulty: q.difficulty, facts_seeded: seeded, retrieval_ms: retrievalMs, total_ms: totalMs });

          if (qi === 0) {
            console.log(`    ${ability}: ${(nuggetScore * 100).toFixed(0)}% (${nuggetScores.filter(Boolean).length}/${rubricNuggets.length} nuggets)`);
            console.log(`      Q: ${q.question.substring(0, 80)}`);
            console.log(`      Got: ${predicted.substring(0, 80)}`);
          }
        } catch (err) {
          allResults.push({ conv_id: convId, ability, question: q.question, expected: expectedAnswer, predicted: '', nugget_scores: [], nugget_score: 0, difficulty: q.difficulty, facts_seeded: seeded, retrieval_ms: 0, total_ms: performance.now() - qStart });
          console.error(`    ${ability} Q${qi}: ERROR:`, err instanceof Error ? err.message : err);
        }
      }
    }

    const convMs = performance.now() - convStart;
    const convResults = allResults.filter(r => r.conv_id === convId);
    const convScore = convResults.length > 0 ? convResults.reduce((s, r) => s + r.nugget_score, 0) / convResults.length : 0;
    console.log(`  [Conv ${convId}] Done: ${(convScore * 100).toFixed(1)}% avg (${convResults.length} Qs, ${Math.round(convMs / 1000)}s)`);
    await repo.close();
  }

  // Report
  console.log('\n========== BEAM RESULTS ==========');
  console.log(`Dataset:    ${size} (${convDirs.length} conversations)`);
  console.log(`Questions:  ${allResults.length}`);
  const overallScore = allResults.length > 0 ? allResults.reduce((s, r) => s + r.nugget_score, 0) / allResults.length : 0;
  console.log(`Overall:    ${(overallScore * 100).toFixed(1)}%`);

  const byAbility: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) { if (!byAbility[r.ability]) byAbility[r.ability] = { total: 0, scoreSum: 0 }; byAbility[r.ability]!.total++; byAbility[r.ability]!.scoreSum += r.nugget_score; }
  console.log('\nBy ability:');
  for (const [ability, counts] of Object.entries(byAbility).sort((a, b) => (b[1].scoreSum / b[1].total) - (a[1].scoreSum / a[1].total))) { console.log(`  ${ability}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`); }

  const byDiff: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) { if (!byDiff[r.difficulty]) byDiff[r.difficulty] = { total: 0, scoreSum: 0 }; byDiff[r.difficulty]!.total++; byDiff[r.difficulty]!.scoreSum += r.nugget_score; }
  console.log('\nBy difficulty:');
  for (const [d, counts] of Object.entries(byDiff).sort((a, b) => (b[1].scoreSum / b[1].total) - (a[1].scoreSum / a[1].total))) { console.log(`  ${d}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`); }

  const byConv: Record<string, { total: number; scoreSum: number }> = {};
  for (const r of allResults) { if (!byConv[r.conv_id]) byConv[r.conv_id] = { total: 0, scoreSum: 0 }; byConv[r.conv_id]!.total++; byConv[r.conv_id]!.scoreSum += r.nugget_score; }
  console.log('\nBy conversation:');
  for (const [cid, counts] of Object.entries(byConv).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) { console.log(`  Conv ${cid}: ${((counts.scoreSum / counts.total) * 100).toFixed(1)}% (${counts.total} Qs)`); }

  const meanRetMs = allResults.reduce((s, r) => s + r.retrieval_ms, 0) / allResults.length;
  console.log(`\nRetrieval:  mean ${meanRetMs.toFixed(0)}ms`);

  const report = { benchmark: `beam-${size.toLowerCase()}`, timestamp: new Date().toISOString(), config: { size, maxRules, answerModel, judgeModel, mini }, summary: { total: allResults.length, overallScore, conversations: convDirs.length }, byAbility, byDiff, byConv, results: allResults };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = mini ? '-mini' : '';
  const reportPath = resolve(outputDir, `beam-${size.toLowerCase()}${tag}-${ts}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
