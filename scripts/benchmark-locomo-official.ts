#!/usr/bin/env npx tsx
/**
 * Official LOCOMO Benchmark Runner
 *
 * Runs the full official LOCOMO benchmark (10 conversations, 1,986 questions)
 * through the REAL Demiurge retrieval pipeline.
 *
 * Usage:
 *   npx tsx scripts/benchmark-locomo-official.ts                    # Full run
 *   npx tsx scripts/benchmark-locomo-official.ts --limit-convos 2   # First 2 conversations
 *   npx tsx scripts/benchmark-locomo-official.ts --limit-qa 10      # First 10 QA per conversation
 *
 * Prerequisites:
 *   - fixtures/benchmark/locomo-official/locomo10.json (official LOCOMO dataset)
 *   - fixtures/benchmark/locomo-official/extracted-facts.json (pre-extracted facts)
 *   - ANTHROPIC_API_KEY in .env
 *   - Real ONNX model + tokenizer in models/
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callLLM } from '../src/benchmark/llm-caller.js';
import { locomoCategoryToQueryType, CATEGORY_PROMPTS } from "../src/inject/prompts.js";
import { classifyQuery } from "../src/retrieval/query-classifier.js";
import { routeAnswerModel } from "../src/answer/router.js";

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

interface ExtractedFact {
  claim: string;
  subject: string;
  session_id?: number;
}

interface ExtractedConversation {
  conversation_index: number;
  facts: ExtractedFact[];
}

interface QuestionResult {
  conversation_index: number;
  question_index: number;
  category: number;
  question: string;
  expected_answer: string;
  predicted_answer: string;
  llm_judge_correct: boolean;
  f1_score: number;
  retrieval_time_ms: number;
  total_time_ms: number;
  memories_injected: number;
}

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const limitConvosIdx = args.indexOf('--limit-convos');
  const limitQaIdx = args.indexOf('--limit-qa');
  const maxRulesIdx = args.indexOf('--max-rules');
  const startConvIdx = args.indexOf("--start-conv");
  const startConv = startConvIdx !== -1 ? parseInt(args[startConvIdx + 1] ?? "0", 10) : 0;
  const limitConvos = limitConvosIdx !== -1 ? parseInt(args[limitConvosIdx + 1] ?? '10', 10) : 10;
  const limitQa = limitQaIdx !== -1 ? parseInt(args[limitQaIdx + 1] ?? '9999', 10) : 9999;
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;
  const answerModelIdx = args.indexOf('--answer-model');
  const judgeModelIdx = args.indexOf('--judge-model');
  const factsFileIdx = args.indexOf('--facts-file');
  const answerModel = answerModelIdx !== -1 ? args[answerModelIdx + 1]! : 'claude-haiku-4-5-20251001';
  const judgeModel = judgeModelIdx !== -1 ? args[judgeModelIdx + 1]! : 'claude-haiku-4-5-20251001';
  const factsFileArg = factsFileIdx !== -1 ? args[factsFileIdx + 1]! : null;
  const miniFileIdx = args.indexOf('--mini-file');
  const miniFileArg = miniFileIdx !== -1 ? args[miniFileIdx + 1]! : null;
  const routedMode = args.includes("--routed");
  if (routedMode) process.env.ANSWER_ROUTING = "true";

  // LOCOMO-mini: stratified 20% sample for fast A/B testing (~14 min vs 2-3 hrs)
  const miniMode = args.includes('--mini');
  let miniIndices: Map<number, Set<number>> | null = null;
  if (miniMode) {
    const miniPath = miniFileArg || resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo-mini-indices.json');
    if (existsSync(miniPath)) {
      const miniData = JSON.parse(readFileSync(miniPath, 'utf-8'));
      miniIndices = new Map();
      for (const conv of miniData.conversations) {
        miniIndices.set(conv.conversation_index, new Set(conv.question_indices));
      }
      console.log('LOCOMO-mini mode: ' + miniData.total_sampled + ' questions (' + miniData.sample_rate * 100 + '% sample)');
    } else {
      console.error('Mini indices not found. Run: python3 scripts/create-locomo-mini.py');
      process.exit(1);
    }
  }

  // Category labels — JSON cat values (NOT paper narrative order):
  //   1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial(excluded)
  const CATEGORY_LABELS: Record<number, string> = {
    1: 'Multi-hop',
    2: 'Temporal',
    3: 'Open-domain',
    4: 'Single-hop',
    5: 'Adversarial (EXCLUDED)',
  };

  // Setup
  process.env.AUTH_TOKEN = process.env.AUTH_TOKEN || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY required');
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
  const factsPath = factsFileArg ? resolve(factsFileArg) : resolve(__dirname, '../fixtures/benchmark/locomo-official/extracted-facts.json');
  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error('Download the official LOCOMO dataset first.');
    process.exit(1);
  }

  if (!existsSync(factsPath)) {
    console.error(`Extracted facts not found: ${factsPath}`);
    console.error('Run fact extraction first.');
    process.exit(1);
  }

  const dataset: LocomoConversation[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const factsCache: ExtractedConversation[] = JSON.parse(readFileSync(factsPath, 'utf-8'));

  const convsToRun = Math.min(startConv + limitConvos, dataset.length);
  console.log(`Answer model: ${answerModel}`);
  if (routedMode) console.log("Answer routing: ENABLED");
  console.log(`Judge model: ${judgeModel}`);
  console.log(`Facts file: ${factsFileArg || "default"}`);
  console.log(`Official LOCOMO: ${convsToRun} conversations, maxRules=${maxRules}, cat5=excluded`);

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');
  const { computeF1 } = await import('../src/benchmark/locomo-official-seeder.js');
  const { seedConversationFacts } = await import('../src/benchmark/locomo-official-seeder.js');

  const allResults: QuestionResult[] = [];

  for (let ci = startConv; ci < convsToRun; ci++) {
    const conv = dataset[ci]!;
    const cachedFacts = factsCache.find((f) => f.conversation_index === ci);

    if (!cachedFacts || cachedFacts.facts.length === 0) {
      console.log(`[Conv ${ci}] No extracted facts, skipping`);
      continue;
    }

    console.log(`\n[Conv ${ci}] ${cachedFacts.facts.length} facts, ${conv.qa.length} questions`);

    // Fresh isolated repo per conversation
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString()); // Unlock circuit breaker for fresh benchmark DBs
    const dispatch = createCoreDispatch(repo, config);

    // Seed facts
    const seeded = await seedConversationFacts(dispatch, cachedFacts.facts, ci);
    console.log(`  Seeded: ${seeded} memories`);

    // R11: Post-seed hooks (episodes, summaries, bridges)
    try {
      const hooks = await repo.runPostSeedHooks(anthropicKey || undefined);
      if (hooks.episodes > 0 || hooks.summaries > 0 || hooks.bridges > 0) {
        console.log(`  R11 hooks: ${hooks.episodes} episodes, ${hooks.summaries} summaries, ${hooks.bridges} bridges`);
      }
    } catch (hookErr: any) {
      console.log('  R11 hooks failed (non-critical):', hookErr?.message?.substring(0, 80));
    }

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

        // Skip Cat 5 (adversarial) — excluded from scoring, save API cost
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

        // Retrieve using FULL Demiurge pipeline
        const retrievalStart = performance.now();
        const searchResult = await dispatch.search(qa.question, maxRules);
        const retrievalTimeMs = performance.now() - retrievalStart;

        // Generate answer — concise for all scored categories
        // U4: Per-category answer prompts
        const queryType = locomoCategoryToQueryType(qa.category);
        const basePrompt = process.env.ANSWER_PROMPT || CATEGORY_PROMPTS[queryType];
        const promptSuffix = process.env.ANSWER_PROMPT_SUFFIX || "";
        const routed = routeAnswerModel(queryType);
        const activeModel = routed ? routed.model : answerModel;
        const fullSuffix = [promptSuffix, routed?.promptSuffix].filter(Boolean).join(" ");
        const answerPrompt = `${basePrompt}${fullSuffix ? " " + fullSuffix : ""}\n\nContext:\n${searchResult.contextText}`;

        const predicted = await callLLM(activeModel, answerPrompt, qa.question, parseInt(process.env.ANSWER_MAX_TOKENS || "100"), 0);

        // LLM judge — binary J-score (industry standard for LOCOMO)
        // Cat 5 is skipped above, so qa.answer is always defined for scored questions.
        const expectedAnswer = qa.answer ?? 'N/A';
        const judgePrompt = `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: ${qa.question}
Gold answer: ${expectedAnswer}
System response: ${predicted}

Does the system response correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.`;

        const judgeText = (await callLLM(judgeModel, "", judgePrompt, 10, 0, true)).toLowerCase().trim();
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
          llm_judge_correct: llmCorrect,
          f1_score: f1,
          retrieval_time_ms: retrievalTimeMs,
          total_time_ms: totalTimeMs,
          memories_injected: searchResult.payload.memories.length,
        };

        // S25: Gold-evidence instrumentation (log all injected memory claims)
        if (process.env.GOLD_EVIDENCE_LOG === 'true') {
          resultEntry.injected_claims = searchResult.payload.memories
            .map((m: { claim: string; subject?: string }) => ({ claim: m.claim, subject: m.subject }));
          resultEntry.query_type = queryType;
          resultEntry.answer_model = activeModel;
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

  // Report — EXCLUDE Cat 5 from headline score (industry standard).
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
  const reportPath = resolve(outputDir, `locomo-official-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report = {
    benchmark: 'locomo-official',
    timestamp: new Date().toISOString(),
    config: {
      maxRules,
      lexicalWeight: config.lexicalWeight,
      vectorWeight: config.vectorWeight,
      freshnessHalfLifeDays: config.freshnessHalfLifeDays,
      candidateOverfetchMultiplier: config.candidateOverfetchMultiplier,
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

  // S25: Gold-evidence instrumentation — separate file with injected claims
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
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
