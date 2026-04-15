#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark Runner
 *
 * Two modes:
 * - extracted: uses pre-extracted facts (requires extraction step)
 * - verbatim: seeds raw conversation text directly (no extraction)
 *
 * Usage:
 *   npx tsx scripts/benchmark-longmemeval.ts                      # Full 500
 *   npx tsx scripts/benchmark-longmemeval.ts --limit 20           # First 20
 *   npx tsx scripts/benchmark-longmemeval.ts --mode verbatim      # Raw text
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { routeAnswerModel } from "../src/answer/router.js";
import { callLLM } from '../src/benchmark/llm-caller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? '500', 10) : 500;
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1]! : 'verbatim';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;
  const answerModelIdx = args.indexOf('--answer-model');
  const judgeModelIdx = args.indexOf('--judge-model');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'gpt-4o-mini';
  const seedAssistant = args.includes('--seed-assistant');
  const adaptiveGate = args.includes('--adaptive-gate');
  const routedMode = args.includes('--routed');
  if (routedMode) process.env.ANSWER_ROUTING = 'true';
  const ADAPTIVE_GATE_THRESHOLD = parseInt(process.env.ADAPTIVE_GATE_THRESHOLD || '200', 10);
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'gpt-4o-mini';

  process.env.AUTH_TOKEN = process.env.AUTH_TOKEN || 'benchmark-longmemeval-demiurge-2026';
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
  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  // Load extracted facts if in extracted mode
  let factsMap: Map<string, any[]> | null = null;
  if (mode === 'extracted') {
    const factsPath = resolve(__dirname, '../fixtures/benchmark/longmemeval/extracted-facts-s.json');
    if (existsSync(factsPath)) {
      const cache = JSON.parse(readFileSync(factsPath, 'utf-8'));
      factsMap = new Map(cache.entries.map((e: any) => [e.question_id, e.facts]));
      console.log(`Loaded ${factsMap.size} extracted fact sets`);
    }
  }

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { classifyQuery } = await import('../src/retrieval/query-classifier.js');
  const { CATEGORY_PROMPTS } = await import('../src/inject/prompts.js');

  // Mini mode: use stratified indices
  let questionsToRun: typeof dataset;
  const miniMode = args.includes('--mini');
  if (miniMode) {
    const miniFileIdx = args.indexOf('--mini-file');
    const miniIndicesPath = miniFileIdx !== -1 ? resolve(args[miniFileIdx + 1]!) : resolve(__dirname, '../fixtures/benchmark/longmemeval/longmemeval-mini-indices.json');
    if (existsSync(miniIndicesPath)) {
      const indices = JSON.parse(readFileSync(miniIndicesPath, 'utf-8')) as number[];
      questionsToRun = indices.map(i => dataset[i]!).filter(Boolean);
      console.log('Mini mode: ' + questionsToRun.length + ' stratified questions');
    } else {
      console.error('Mini indices not found. Run create-longmemeval-mini.py first.');
      process.exit(1);
    }
  } else {
    questionsToRun = dataset.slice(0, limit);
  }
  console.log(`LongMemEval: ${questionsToRun.length} questions, mode=${mode}, maxRules=${maxRules}`);
  console.log(`Answer: ${answerModel}, Judge: ${judgeModel}, seedAssistant: ${seedAssistant}, adaptiveGate: ${adaptiveGate}`);

  interface Result {
    question_id: string;
    question_type: string;
    question: string;
    expected: string;
    predicted: string;
    correct: boolean;
    facts_seeded: number;
    retrieval_ms: number;
    total_ms: number;
  }

  const results: Result[] = [];

  for (let i = 0; i < questionsToRun.length; i++) {
    const entry = questionsToRun[i]!;
    const totalStart = performance.now();
    const normalizedAnswer = Array.isArray(entry.answer) ? entry.answer.join("; ") : String(entry.answer ?? "");

    // Fresh isolated repo per question
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    // Seed memories
    let seeded = 0;
    const sessions = entry.haystack_sessions || entry.sessions || [];

    if (mode === 'verbatim') {
      // R11: Pre-count for adaptive gate
      let effectiveSeedAssistant = seedAssistant;
      if (adaptiveGate && seedAssistant) {
        let totalMsgCount = 0;
        for (const sess of sessions) {
          const sMsgs = Array.isArray(sess) ? sess : (sess.messages || sess.conversation || []);
          totalMsgCount += sMsgs.filter((m: any) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.length >= 10).length;
        }
        if (totalMsgCount >= ADAPTIVE_GATE_THRESHOLD) {
          effectiveSeedAssistant = false;
          if (i < 5) console.log(`    Adaptive gate: ${totalMsgCount} msgs >= ${ADAPTIVE_GATE_THRESHOLD}, user-only`);
        }
      }
      // Seed by chunking each session into 1-2 memories (not per-message)
      for (let si = 0; si < sessions.length; si++) {
        const session = sessions[si]!;
        const msgs = Array.isArray(session) ? session : (session.messages || session.conversation || []);
        // Concatenate user messages into one chunk per session
        const userMsgs = msgs
          .filter((m: any) => (m.role === 'user' || (effectiveSeedAssistant && m.role === 'assistant')) && m.content && m.content.length >= 10)
          .map((m: any) => m.content.substring(0, 300));
        if (userMsgs.length === 0) continue;
        // Split into chunks of ~500 chars
        let chunk = '';
        for (const msg of userMsgs) {
          if (chunk.length + msg.length > 500 && chunk.length > 0) {
            try {
              const result = await dispatch.addMemory({
                claim: chunk.trim(),
                subject: 'session-' + si,
                source: 'user',
                confidence: 0.95,
              });
              if (result.action !== 'rejected') seeded++;
            } catch { /* skip */ }
            chunk = '';
          }
          chunk += msg + ' ';
        }
        if (chunk.trim().length > 10) {
          try {
            const result = await dispatch.addMemory({
              claim: chunk.trim(),
              subject: 'session-' + si,
              source: 'user',
              confidence: 0.95,
            });
            if (result.action !== 'rejected') seeded++;
          } catch { /* skip */ }
        }
      }
    } else if (factsMap) {
      // Seed extracted facts
      const facts = factsMap.get(entry.question_id) || [];
      for (const fact of facts) {
        try {
          const result = await dispatch.addMemory({
            claim: fact.claim,
            subject: fact.subject || 'general',
            source: 'user',
            confidence: 0.95,
          });
          if (result.action !== 'rejected') seeded++;
        } catch { /* skip */ }
      }
    }

    // R11: Post-seed hooks
    if (seeded > 0) {
      try {
        const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
        if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
          if (i < 5) console.log(`    R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`);
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
        correct: false,
        facts_seeded: 0,
        retrieval_ms: 0,
        total_ms: performance.now() - totalStart,
      });
      console.log(`  [${i + 1}/${questionsToRun.length}] ${entry.question_id}: SKIP (0 seeded)`);
      await repo.close();
      continue;
    }

    try {
      // Retrieve
      const retStart = performance.now();
      const searchResult = await dispatch.search(entry.question, maxRules);
      const retrievalMs = performance.now() - retStart;

      // Answer with category-aware prompt
      const queryType = classifyQuery(entry.question);
      const basePrompt = CATEGORY_PROMPTS[queryType];
      const promptSuffix = process.env.ANSWER_PROMPT_SUFFIX || "";
      const routed = routeAnswerModel(queryType);
      const activeModel = routed ? routed.model : answerModel;
      const fullSuffix = [promptSuffix, routed?.promptSuffix].filter(Boolean).join(" ");
      const answerPrompt = `${basePrompt}${fullSuffix ? " " + fullSuffix : ""}\n\nContext:\n${searchResult.contextText}`;
      const predicted = await callLLM(activeModel, answerPrompt, entry.question, 150, 0);

      // Judge (GPT-4o standard LongMemEval prompt)
      const judgePrompt = `You are evaluating a memory system's answer.

Question: ${entry.question}
Reference answer: ${normalizedAnswer}
System answer: ${predicted}

Is the system answer correct? Accept paraphrases and equivalent information. Respond ONLY with "yes" or "no".`;

      const judgeText = (await callLLM(judgeModel, "", judgePrompt, 10, 0, true)).toLowerCase().trim();

      const correct = judgeText.startsWith('yes');
      const totalMs = performance.now() - totalStart;

      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        expected: normalizedAnswer,
        predicted,
        correct,
        facts_seeded: seeded,
        retrieval_ms: retrievalMs,
        total_ms: totalMs,
      });

      const status = correct ? 'PASS' : 'FAIL';
      if (i < 10) {
        console.log(`  [${i + 1}/${questionsToRun.length}] ${entry.question_type}: ${status} (${seeded} facts, ${Math.round(totalMs)}ms)`);
        console.log(`    Q: ${entry.question.substring(0, 80)}`);
        console.log(`    Expected: ${normalizedAnswer.substring(0, 80)}`);
        console.log(`    Got: ${predicted.substring(0, 80)}`);
      }

      if ((i + 1) % 50 === 0) {
        const scored = results.filter(r => r.facts_seeded > 0);
        const c = scored.filter(r => r.correct).length;
        console.log(`  [${i + 1}/${questionsToRun.length}] Running accuracy: ${scored.length > 0 ? ((c / scored.length) * 100).toFixed(1) : '0'}%`);
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
  const scored = results.filter(r => r.facts_seeded > 0);
  const skipped = results.filter(r => r.facts_seeded === 0);
  const correct = scored.filter(r => r.correct).length;

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
    console.log(`  ${type}: ${((counts.correct / counts.total) * 100).toFixed(1)}% (${counts.correct}/${counts.total})`);
  }

  // Save
  const report = {
    benchmark: 'longmemeval-s',
    mode,
    timestamp: new Date().toISOString(),
    config: { maxRules, answerModel, judgeModel, mode },
    summary: { total: scored.length, correct, accuracy: correct / scored.length, skipped: skipped.length },
    byType,
    results,
  };

  const reportPath = resolve(outputDir, `longmemeval-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
