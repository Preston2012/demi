import type { BenchmarkResult, QuestionFixture } from './types.js';

/**
 * Fact-based evaluation. Checks whether required facts from the
 * ground truth appear in the generated answer.
 *
 * A question is correct if ALL required facts are present (case-insensitive
 * substring match). Deliberately strict: partial credit = 0.
 */
export function evaluateAnswer(
  question: QuestionFixture,
  actualAnswer: string,
  meta: {
    memoriesInjected: number;
    retrievalTimeMs: number;
    totalTimeMs: number;
  },
): BenchmarkResult {
  const answerLower = actualAnswer.toLowerCase();

  const factsHit: string[] = [];
  const factsMissed: string[] = [];

  for (const fact of question.requiredFacts) {
    if (answerLower.includes(fact.toLowerCase())) {
      factsHit.push(fact);
    } else {
      factsMissed.push(fact);
    }
  }

  const correct = factsMissed.length === 0;

  return {
    questionId: question.id,
    question: question.question,
    expectedAnswer: question.expectedAnswer,
    actualAnswer,
    memoriesInjected: meta.memoriesInjected,
    correct,
    factsHit,
    factsMissed,
    retrievalTimeMs: meta.retrievalTimeMs,
    totalTimeMs: meta.totalTimeMs,
  };
}
