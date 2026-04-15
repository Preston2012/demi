/**
 * BEAM benchmark adapter.
 *
 * Per-conversation memory stores: each conversation gets a fresh DB,
 * seeded with extracted facts, then all 20 questions are run against it.
 *
 * Start with 128K scale, expand to 500K/1M/10M once validated.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { Config } from '../config.js';
import { SqliteMemoryRepository } from '../repository/sqlite/index.js';
import { createCoreDispatch } from '../core/dispatch.js';
import type { BeamConversation, BeamResult, BeamReport, BeamExtractedFactsCache } from './beam-types.js';

export interface BeamConfig {
  maxRules: number;
  answerFn: (injectionText: string, question: string) => Promise<string>;
  judgeApiKey: string;
  judgeModel?: string;
  limitConversations?: number;
}

/**
 * Load BEAM dataset from disk.
 */
export function loadBeamDataset(datasetPath: string): BeamConversation[] {
  if (!existsSync(datasetPath)) {
    throw new Error(`BEAM dataset not found at: ${datasetPath}\nDownload from HuggingFace: Mohammadta/BEAM`);
  }

  const raw = readFileSync(datasetPath, 'utf-8');
  const data = JSON.parse(raw);

  if (Array.isArray(data)) return data as BeamConversation[];
  if (data.conversations) return data.conversations as BeamConversation[];

  throw new Error('Unexpected BEAM dataset format');
}

/**
 * Load pre-extracted facts cache.
 */
export function loadBeamExtractedFacts(cachePath: string): BeamExtractedFactsCache | null {
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, 'utf-8')) as BeamExtractedFactsCache;
}

/**
 * Judge a BEAM answer using LLM.
 * Returns 1.0 (correct), 0.5 (partial), or 0.0 (wrong).
 */
async function judgeBeamAnswer(
  question: string,
  referenceAnswer: string,
  hypothesis: string,
  apiKey: string,
  model: string = 'claude-haiku-4-5-20251001',
): Promise<number> {
  const prompt = `Score this response against the reference answer on a scale of 0, 0.5, or 1.

Question: ${question}

Reference Answer: ${referenceAnswer}

Model Response: ${hypothesis}

Score 1.0 if the response contains the correct and complete answer.
Score 0.5 if the response contains a partial answer (some correct info but missing key details).
Score 0.0 if the response is wrong, irrelevant, or says it doesn't know.

Output ONLY the number: 0, 0.5, or 1`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Judge API error ${response.status}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  const text = (data.content?.[0]?.text ?? '0').trim();

  if (text === '1' || text === '1.0') return 1.0;
  if (text === '0.5') return 0.5;
  return 0.0;
}

/**
 * Run the full BEAM benchmark.
 *
 * For each conversation:
 * 1. Create fresh in-memory repo
 * 2. Seed with pre-extracted facts
 * 3. Run all probing questions
 * 4. Judge each answer
 * 5. Tear down
 */
export async function runBeam(
  conversations: BeamConversation[],
  factsCache: BeamExtractedFactsCache,
  baseConfig: Config,
  benchConfig: BeamConfig,
  scale: string = '128k',
): Promise<BeamReport> {
  const results: BeamResult[] = [];
  const factsMap = new Map(factsCache.conversations.map((c) => [c.conversation_id, c]));

  const convsToRun = benchConfig.limitConversations
    ? conversations.slice(0, benchConfig.limitConversations)
    : conversations;

  console.log(`Running BEAM-${scale}: ${convsToRun.length} conversations`);

  for (let ci = 0; ci < convsToRun.length; ci++) {
    const conv = convsToRun[ci]!;
    const facts = factsMap.get(conv.conversation_id);

    console.log(
      `  [${ci + 1}/${convsToRun.length}] Conversation ${conv.conversation_id} (${conv.probing_questions.length} questions)...`,
    );

    if (!facts || facts.facts.length === 0) {
      console.log(`    No extracted facts, skipping`);
      for (const q of conv.probing_questions) {
        results.push({
          conversation_id: conv.conversation_id,
          question_id: q.question_id,
          category: q.category,
          question: q.question,
          reference_answer: q.answer,
          hypothesis: '',
          score: 0,
          retrievalTimeMs: 0,
          totalTimeMs: 0,
        });
      }
      continue;
    }

    // Fresh isolated repo per conversation
    const isolatedConfig = { ...baseConfig, dbPath: ':memory:' };
    const repo = new SqliteMemoryRepository(isolatedConfig);
    await repo.initialize();
    const dispatch = createCoreDispatch(repo, isolatedConfig);

    // Seed facts
    let seeded = 0;
    for (const fact of facts.facts) {
      try {
        const result = await dispatch.addMemory({
          claim: fact.claim,
          subject: fact.subject,
          source: 'user',
          confidence: 0.95,
        });
        if (result.action !== 'rejected') seeded++;
      } catch {
        // Skip
      }
    }

    console.log(`    Seeded ${seeded} facts, running ${conv.probing_questions.length} questions...`);

    // Run each probing question
    for (const q of conv.probing_questions) {
      const totalStart = performance.now();
      try {
        const retrievalStart = performance.now();
        const searchResult = await dispatch.search(q.question, benchConfig.maxRules);
        const retrievalTimeMs = performance.now() - retrievalStart;

        const hypothesis = await benchConfig.answerFn(searchResult.contextText, q.question);

        const score = await judgeBeamAnswer(
          q.question,
          q.answer,
          hypothesis,
          benchConfig.judgeApiKey,
          benchConfig.judgeModel,
        );

        results.push({
          conversation_id: conv.conversation_id,
          question_id: q.question_id,
          category: q.category,
          question: q.question,
          reference_answer: q.answer,
          hypothesis,
          score,
          retrievalTimeMs,
          totalTimeMs: performance.now() - totalStart,
        });
      } catch (err) {
        console.error(`    ${q.question_id}: ERROR`, err instanceof Error ? err.message : err);
        results.push({
          conversation_id: conv.conversation_id,
          question_id: q.question_id,
          category: q.category,
          question: q.question,
          reference_answer: q.answer,
          hypothesis: '',
          score: 0,
          retrievalTimeMs: 0,
          totalTimeMs: performance.now() - totalStart,
        });
      }
    }

    await repo.close();
  }

  // Build report
  const byCategory: Record<string, { total: number; meanScore: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, meanScore: 0 };
    byCategory[r.category]!.total++;
    byCategory[r.category]!.meanScore += r.score;
  }
  for (const cat of Object.values(byCategory)) {
    cat.meanScore = cat.total > 0 ? cat.meanScore / cat.total : 0;
  }

  return {
    dataset: 'beam',
    scale,
    timestamp: new Date().toISOString(),
    totalQuestions: results.length,
    meanScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    byCategory,
    meanRetrievalMs: results.reduce((s, r) => s + r.retrievalTimeMs, 0) / results.length,
    meanTotalMs: results.reduce((s, r) => s + r.totalTimeMs, 0) / results.length,
    results,
  };
}
