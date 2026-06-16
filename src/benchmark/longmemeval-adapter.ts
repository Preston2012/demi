/**
 * LongMemEval benchmark adapter.
 *
 * Per-question isolated memory stores: each question gets a fresh DB,
 * seeded with facts extracted from its sessions, then queried.
 *
 * This is the key difference from LOCOMO (shared corpus).
 * 500 questions x fresh DB each = ~10-30 min total.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { Config } from '../config.js';
import { SqliteMemoryRepository } from '../repository/sqlite/index.js';
import { createCoreDispatch } from '../core/dispatch.js';
import type {
  LongMemEvalEntry,
  LongMemEvalResult,
  LongMemEvalReport,
  ExtractedFactsCache,
} from './longmemeval-types.js';
import { judgeAnswer } from './longmemeval-evaluator.js';

export interface LongMemEvalConfig {
  maxRules: number;
  answerFn: (injectionText: string, question: string) => Promise<string>;
  judgeApiKey: string;
  judgeModel?: string;
  limit?: number; // limit number of questions (for testing)
}

/**
 * Load the LongMemEval dataset from disk.
 */
export function loadLongMemEvalDataset(datasetPath: string): LongMemEvalEntry[] {
  if (!existsSync(datasetPath)) {
    throw new Error(
      `LongMemEval dataset not found at: ${datasetPath}\nDownload it first:\n  curl -L -o ${datasetPath} https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`,
    );
  }

  const raw = readFileSync(datasetPath, 'utf-8');
  const data = JSON.parse(raw);

  // Handle both array format and object-with-entries format
  if (Array.isArray(data)) return data as LongMemEvalEntry[];
  if (data.entries) return data.entries as LongMemEvalEntry[];

  throw new Error('Unexpected LongMemEval dataset format');
}

/**
 * Load pre-extracted facts cache.
 */
export function loadExtractedFacts(cachePath: string): ExtractedFactsCache | null {
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, 'utf-8')) as ExtractedFactsCache;
}

/**
 * Run the full LongMemEval benchmark.
 *
 * For each question:
 * 1. Create fresh in-memory repo
 * 2. Seed with pre-extracted facts for that question
 * 3. Run retrieval + answer generation
 * 4. Judge the answer
 * 5. Tear down
 */
export async function runLongMemEval(
  entries: LongMemEvalEntry[],
  factsCache: ExtractedFactsCache,
  baseConfig: Config,
  benchConfig: LongMemEvalConfig,
): Promise<LongMemEvalReport> {
  const results: LongMemEvalResult[] = [];
  const factsMap = new Map(factsCache.entries.map((e) => [e.question_id, e]));

  const questionsToRun = benchConfig.limit ? entries.slice(0, benchConfig.limit) : entries;
  const total = questionsToRun.length;

  console.log(`Running LongMemEval: ${total} questions`);

  for (let i = 0; i < total; i++) {
    const entry = questionsToRun[i]!;
    const facts = factsMap.get(entry.question_id);

    if (!facts || facts.facts.length === 0) {
      console.log(`  [${i + 1}/${total}] ${entry.question_id}: No extracted facts, skipping`);
      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        reference_answer: entry.answer,
        hypothesis: '',
        correct: false,
        retrievalTimeMs: 0,
        totalTimeMs: 0,
      });
      continue;
    }

    const totalStart = performance.now();

    // Fresh isolated repo per question
    const isolatedConfig = { ...baseConfig, dbPath: ':memory:' };
    const repo = new SqliteMemoryRepository(isolatedConfig);
    await repo.initialize();
    const dispatch = createCoreDispatch(repo, isolatedConfig);

    // Seed extracted facts
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
        // Skip failed seeds
      }
    }

    // Retrieve + answer
    const retrievalStart = performance.now();
    let hypothesis = '';
    try {
      const searchResult = await dispatch.search(entry.question, benchConfig.maxRules);
      const retrievalTimeMs = performance.now() - retrievalStart;

      hypothesis = await benchConfig.answerFn(searchResult.contextText, entry.question);

      // Judge the answer
      const correct = await judgeAnswer(
        entry.question_type,
        entry.question,
        entry.answer,
        hypothesis,
        benchConfig.judgeApiKey,
        benchConfig.judgeModel,
      );

      const totalTimeMs = performance.now() - totalStart;

      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        reference_answer: entry.answer,
        hypothesis,
        correct,
        retrievalTimeMs,
        totalTimeMs,
      });

      const status = correct ? 'PASS' : 'FAIL';
      console.log(
        `  [${i + 1}/${total}] ${entry.question_id} (${entry.question_type}): ${status} [${seeded} facts, ${Math.round(totalTimeMs)}ms]`,
      );
    } catch (err) {
      const totalTimeMs = performance.now() - totalStart;
      console.error(`  [${i + 1}/${total}] ${entry.question_id}: ERROR`, err instanceof Error ? err.message : err);
      results.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        reference_answer: entry.answer,
        hypothesis,
        correct: false,
        retrievalTimeMs: 0,
        totalTimeMs,
      });
    }

    await repo.close();
  }

  // Build report
  const correct = results.filter((r) => r.correct).length;
  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};

  for (const r of results) {
    const cat = r.question_type;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, correct: 0, accuracy: 0 };
    byCategory[cat]!.total++;
    if (r.correct) byCategory[cat]!.correct++;
  }

  for (const cat of Object.values(byCategory)) {
    cat.accuracy = cat.total > 0 ? cat.correct / cat.total : 0;
  }

  return {
    dataset: 'longmemeval-s',
    timestamp: new Date().toISOString(),
    totalQuestions: results.length,
    correct,
    accuracy: results.length > 0 ? correct / results.length : 0,
    byCategory,
    meanRetrievalMs: results.reduce((s, r) => s + r.retrievalTimeMs, 0) / results.length,
    meanTotalMs: results.reduce((s, r) => s + r.totalTimeMs, 0) / results.length,
    results,
  };
}
