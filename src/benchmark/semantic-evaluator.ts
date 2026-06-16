import type { BenchmarkResult, QuestionFixture } from './types.js';
import { callLLM } from '../llm/client.js';

/**
 * Semantic evaluator using LLM judgment.
 *
 * Instead of strict substring matching, asks an LLM whether each
 * required fact is present in the answer. Handles:
 * - Number normalization (8 vs "eight")
 * - Paraphrasing ("physical therapist" vs "PT" vs "physiotherapist")
 * - Implicit answers ("moved for work at Meridian" covers "Meridian")
 *
 * Industry standard: SQuAD, TriviaQA, Natural Questions all use
 * model-based or fuzzy evaluation for exactly these reasons.
 *
 * S65 Sprint 1 (M13): swapped from Anthropic Haiku → engine callLLM with
 * gpt-4o-mini default. Anthropic dropped from default judge surface; still
 * available via fallback chain if explicitly model='claude-...' is requested.
 */

type EvalFn = (actualAnswer: string, fact: string) => Promise<boolean>;

const SEMANTIC_JUDGE_MODEL = 'gpt-4o-mini';

const SEMANTIC_JUDGE_SYSTEM = 'You are a semantic equivalence judge. Reply with YES or NO only.';

/**
 * Create a semantic eval function backed by the engine callLLM client.
 * Returns null only if no provider keys are configured at all (we don't
 * gate on a single provider, the engine client picks whatever's available
 * via fallback).
 */
export function createSemanticEvalFn(): EvalFn | null {
  const hasAnyProvider =
    !!process.env.OPENAI_API_KEY ||
    !!process.env.MISTRAL_API_KEY ||
    !!process.env.DEEPSEEK_API_KEY ||
    !!process.env.GOOGLE_API_KEY ||
    !!process.env.XAI_API_KEY ||
    !!process.env.ANTHROPIC_API_KEY;
  if (!hasAnyProvider) return null;

  return async (actualAnswer: string, fact: string): Promise<boolean> => {
    const prompt = `Does the following answer contain or imply the given fact? Reply with YES or NO only.\n\nAnswer: ${actualAnswer}\n\nFact: ${fact}`;
    const text = (
      await callLLM(SEMANTIC_JUDGE_MODEL, SEMANTIC_JUDGE_SYSTEM, prompt, 5, 0, {
        cacheKey: 'demiurge:semantic-judge:v1',
      })
    )
      .trim()
      .toLowerCase();
    return text.startsWith('yes');
  };
}

/**
 * Evaluate answer using semantic LLM judgment for each required fact.
 * Falls back to substring matching if semantic eval is unavailable.
 */
export async function evaluateAnswerSemantic(
  question: QuestionFixture,
  actualAnswer: string,
  meta: {
    memoriesInjected: number;
    retrievalTimeMs: number;
    totalTimeMs: number;
    injectedContext?: string;
  },
  evalFn: EvalFn,
): Promise<BenchmarkResult> {
  const factsHit: string[] = [];
  const factsMissed: string[] = [];

  for (const fact of question.requiredFacts) {
    // Try substring first (fast path)
    if (actualAnswer.toLowerCase().includes(fact.toLowerCase())) {
      factsHit.push(fact);
      continue;
    }
    // Semantic fallback for misses
    const present = await evalFn(actualAnswer, fact);
    if (present) {
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
    injectedContext: meta.injectedContext,
  };
}
