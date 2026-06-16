/**
 * Bench 6 (Intent Inference), judge.
 *
 * Two scores per question, kept independent in the report:
 *   1. answer score (LLM-as-judge gpt-4o-mini, 3-way: 1.0 / 0.5 / 0.0)
 *      - 1.0 = matched preferred interpretation
 *      - 0.5 = matched incorrect interpretation but plausibly (not hallucinated)
 *      - 0.0 = wrong or hallucinated
 *
 *   2. disambiguation rate (deterministic) = of retrieved facts, what
 *      fraction are "about" the preferred entity vs the incorrect entity?
 */

import { callJudgeCached } from '../judge-cache.js';
import type { Fact, Question } from './schema.js';

const JUDGE_MODEL = 'gpt-4o-mini';

export type IntentScore = 1.0 | 0.5 | 0.0;

export interface IntentJudgeResult {
  score: IntentScore;
  /** Fraction of retrieved facts about the preferred entity. */
  disambiguationRate: number;
  /** Did retrieval actually surface ANY preferred-entity facts? */
  preferredRetrieved: boolean;
}

export async function judgeAnswer(question: Question, predicted: string): Promise<IntentScore> {
  const prompt = `Question: ${question.question}

Preferred interpretation: about "${question.preferred_interpretation.entity}".
Preferred answer: ${question.preferred_interpretation.answer}

Incorrect interpretation: about "${question.incorrect_interpretation.entity}".
Incorrect answer: ${question.incorrect_interpretation.answer}

System answer: ${predicted}

Score the system answer on this 3-point scale:
- 2 = matches the preferred interpretation
- 1 = matches the incorrect interpretation (plausible from the question, just wrong target)
- 0 = does not match either interpretation (wrong, refused, or hallucinated)

Output only a single digit: 0, 1, or 2.`;

  let raw: string;
  try {
    // S68: persistent judge cache (M9). cacheTag scopes entries per-bench.
    const judgeRes = await callJudgeCached({
      model: JUDGE_MODEL,
      system:
        'You are a strict scoring judge. Output only the requested single digit as instructed in the user prompt.',
      user: prompt,
      predicted,
      cacheTag: 'intent-ambig',
      maxTokens: 5,
      llmCacheKey: 'demiurge:intent-ambig:judge:v1',
    });
    raw = judgeRes.verdict;
  } catch {
    return 0;
  }
  const m = raw.trim().match(/[012]/);
  const digit = m?.[0];
  if (digit === '2') return 1.0;
  if (digit === '1') return 0.5;
  return 0;
}

/**
 * Disambiguation rate from the retrieval set.
 *
 * `factsByRetrievedRecordId` maps each retrieved memory id back to its
 * source fixture Fact (with `about_entity`). Returns the fraction of those
 * facts whose `about_entity` equals the question's preferred entity.
 */
export function disambiguationRate(
  question: Question,
  retrievedRecordIds: string[],
  factsByRecordId: Map<string, Fact>,
): { rate: number; preferredRetrieved: boolean } {
  const preferred = question.preferred_interpretation.entity.toLowerCase();
  let preferredHits = 0;
  let total = 0;
  for (const id of retrievedRecordIds) {
    const f = factsByRecordId.get(id);
    if (!f) continue;
    total++;
    if (f.about_entity.toLowerCase() === preferred) preferredHits++;
  }
  return {
    rate: total ? preferredHits / total : 0,
    preferredRetrieved: preferredHits > 0,
  };
}
