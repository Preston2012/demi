/**
 * Bench 3 (Multi-Hop Chain), judge.
 *
 * Two scores per question, kept independent in the report:
 *   1. answer correctness (LLM-as-judge, 0/1) via gpt-4o-mini
 *   2. evidence-chain coverage = |retrieved ∩ evidence_chain| / |evidence_chain|
 *
 * Hallucination rate (computed in the runner summary) = % correct answers
 * with coverage < 1.0, model nailed the answer without all the facts.
 */

import { callJudgeCached } from '../judge-cache.js';
import type { Question } from './schema.js';

const JUDGE_MODEL = 'gpt-4o-mini';

/**
 * Map LLM-generated fact_ids in the question's evidence_chain to the actual
 * MemoryRecord UUIDs assigned at insert time.
 */
export type EvidenceMap = Map<string, string>;

export interface MultiHopJudgeResult {
  correct: boolean;
  /** 0..1, fraction of evidence-chain facts present in retrieved set. */
  evidenceCoverage: number;
}

export async function judgeAnswer(question: Question, predicted: string): Promise<boolean> {
  const prompt = `Question: ${question.question}
Ground truth answer: ${question.answer}
System answer: ${predicted}

Score the system answer:
- 1 = correct, contains the ground truth answer (paraphrase OK, extra info OK)
- 0 = incorrect or missing key information

Output only a single digit: 1 or 0.`;

  let raw: string;
  try {
    // S68: persistent judge cache (M9). cacheTag scopes entries per-bench.
    const judgeRes = await callJudgeCached({
      model: JUDGE_MODEL,
      system:
        'You are a strict scoring judge. Output only the requested single digit as instructed in the user prompt.',
      user: prompt,
      predicted,
      cacheTag: 'multi-hop',
      maxTokens: 5,
      llmCacheKey: 'demiurge:multi-hop:judge:v1',
    });
    raw = judgeRes.verdict;
  } catch {
    return false;
  }
  const m = raw.trim().match(/[01]/);
  return m?.[0] === '1';
}

export function evidenceCoverage(
  question: Question,
  retrievedRecordIds: string[],
  factIdToRecordId: EvidenceMap,
): number {
  if (question.evidence_chain.length === 0) return 1;
  const retrievedSet = new Set(retrievedRecordIds);
  let hit = 0;
  for (const factId of question.evidence_chain) {
    const recId = factIdToRecordId.get(factId);
    if (recId && retrievedSet.has(recId)) hit++;
  }
  return hit / question.evidence_chain.length;
}
