import type { CoreDispatch } from '../core/dispatch.js';
import type { BenchmarkCorpus, BenchmarkResult, BenchmarkReport, QuestionFixture } from './types.js';
import { evaluateAnswer } from './evaluator.js';

/**
 * Benchmark runner. Seeds memories from corpus, then runs retrieval +
 * LLM answer generation for each question, evaluates against ground truth.
 */

export interface RunnerConfig {
  maxRules: number;
  killThreshold: number;
  answerFn: (injectionText: string, question: string) => Promise<string>;
}

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxRules: 15,
  killThreshold: 0.73,
  answerFn: async () => {
    throw new Error('answerFn not configured');
  },
};

/**
 * Seed memories from corpus via dispatch.addMemory().
 * Uses pre-extracted memories if available, otherwise falls back
 * to raw conversation messages.
 */
export async function seedCorpus(dispatch: CoreDispatch, corpus: BenchmarkCorpus): Promise<number> {
  let seeded = 0;

  // Prefer pre-extracted facts (deterministic, tests retrieval not extraction)
  if (corpus.memories && corpus.memories.length > 0) {
    // Build conversation timestamp map for temporal seeding.
    // Freshness scoring needs real timestamps to rank recent > stale.
    const convTimestamps = new Map<string, string>();
    for (const conv of corpus.conversations) {
      if (conv.messages.length > 0) {
        convTimestamps.set(conv.id, conv.messages[0]!.timestamp);
      }
    }

    for (const mem of corpus.memories) {
      const validFrom = convTimestamps.get(mem.conversationId);
      const result = await dispatch.addMemory({
        claim: mem.claim,
        subject: mem.subject,
        source: 'user',
        confidence: 0.95,
        validFrom,
      });
      if (result.action !== 'rejected') seeded++;
    }
    return seeded;
  }

  // Fallback: raw conversation messages
  for (const conv of corpus.conversations) {
    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        const result = await dispatch.addMemory({
          claim: msg.content,
          subject: 'user',
          source: 'user',
          confidence: 0.95,
        });
        if (result.action !== 'rejected') seeded++;
      }
    }
  }

  return seeded;
}

/**
 * Run full benchmark: for each question, retrieve + inject + answer + evaluate.
 */
export async function runBenchmark(
  dispatch: CoreDispatch,
  corpus: BenchmarkCorpus,
  config: Partial<RunnerConfig> = {},
): Promise<BenchmarkReport> {
  const cfg = { ...DEFAULT_RUNNER_CONFIG, ...config };
  const results: BenchmarkResult[] = [];

  for (const question of corpus.questions) {
    const result = await runSingleQuestion(dispatch, question, cfg);
    results.push(result);
  }

  return buildReport(corpus.name, results, cfg.killThreshold);
}

async function runSingleQuestion(
  dispatch: CoreDispatch,
  question: QuestionFixture,
  config: RunnerConfig,
): Promise<BenchmarkResult> {
  const totalStart = performance.now();

  // Retrieve + inject
  const retrievalStart = performance.now();
  const searchResult = await dispatch.search(question.question, config.maxRules);
  const retrievalTimeMs = performance.now() - retrievalStart;

  // Generate answer via LLM
  const actualAnswer = await config.answerFn(searchResult.contextText, question.question);

  const totalTimeMs = performance.now() - totalStart;

  return evaluateAnswer(question, actualAnswer, {
    memoriesInjected: searchResult.payload.memories.length,
    retrievalTimeMs,
    totalTimeMs,
  });
}

function buildReport(corpusName: string, results: BenchmarkResult[], killThreshold: number): BenchmarkReport {
  const correct = results.filter((r) => r.correct).length;
  const accuracy = results.length > 0 ? correct / results.length : 0;

  const retrievalTimes = results.map((r) => r.retrievalTimeMs).sort((a, b) => a - b);
  const totalTimes = results.map((r) => r.totalTimeMs).sort((a, b) => a - b);

  // Category breakdown (flat "all" for V1)
  const categoryBreakdown: Record<string, { total: number; correct: number; accuracy: number }> = {
    all: {
      total: results.length,
      correct,
      accuracy,
    },
  };

  return {
    corpus: corpusName,
    timestamp: new Date().toISOString(),
    totalQuestions: results.length,
    correct,
    accuracy,
    meanRetrievalMs: mean(retrievalTimes),
    p95RetrievalMs: percentile(retrievalTimes, 0.95),
    meanTotalMs: mean(totalTimes),
    p95TotalMs: percentile(totalTimes, 0.95),
    killConditionMet: accuracy >= killThreshold,
    killThreshold,
    results,
    categoryBreakdown,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}
