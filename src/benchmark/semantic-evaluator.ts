import type { BenchmarkResult, QuestionFixture } from './types.js';

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
 */

type EvalFn = (actualAnswer: string, fact: string) => Promise<boolean>;

/**
 * Create a semantic eval function using the Anthropic API.
 */
export function createSemanticEvalFn(): EvalFn | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  return async (actualAnswer: string, fact: string): Promise<boolean> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        temperature: 0,
        system: 'You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".',
        messages: [{
          role: 'user',
          content: `Does this answer contain or convey the fact "${fact}"? Consider number words (eight = 8), abbreviations, paraphrases, and synonyms as matches. Only say "no" if the fact is genuinely absent or contradicted.\n\nAnswer: "${actualAnswer}"`,
        }],
      }),
    });
    const data = (await response.json()) as { content: { text: string }[] };
    const text = (data.content?.[0]?.text ?? '').toLowerCase().trim();
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
