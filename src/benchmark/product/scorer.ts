/**
 * Shared scoring helpers for the product-correctness bench suite.
 *
 * - jaccard: set overlap on retrieved-id sets (paraphrase consistency)
 * - judgeSemantic: LLM-based correctness with paraphrase tolerance
 * - aggregatePerCategory: per-pattern slicing for the report
 */

import type { ProductQuestionResult } from './types.js';

export function jaccard<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersect = 0;
  for (const x of sa) if (sb.has(x)) intersect++;
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 1 : intersect / union;
}

const SEMANTIC_JUDGE_PROMPT_DEFAULT = `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: {question}
Gold answer: {gold}
System answer: {predicted}

Does the system answer correctly answer the question?
Accept paraphrases, synonyms, abbreviations, and alternate spellings as correct (e.g. "Microsoft" / "MSFT" / "Microsoft Corp" all match).
Accept partial dates as long as no contradiction (e.g. "January 2024" matches "2024-01-15").
Say "no" if the key information is missing, wrong, or contradicted.`;

export interface SemanticJudgeOpts {
  promptTemplate?: string;
}

/**
 * Build a prompt for the LLM judge. Returns the prompt string the caller
 * should pass into callLLM. Caller decides which judge model to use.
 */
export function buildSemanticJudgePrompt(
  question: string,
  gold: string | string[],
  predicted: string,
  opts: SemanticJudgeOpts = {},
): string {
  const goldStr = Array.isArray(gold) ? gold.join(' | ') : gold;
  return (opts.promptTemplate ?? SEMANTIC_JUDGE_PROMPT_DEFAULT)
    .replace('{question}', question)
    .replace('{gold}', goldStr)
    .replace('{predicted}', predicted);
}

export function parseYesNo(judgeOutput: string): boolean {
  return /^\s*yes/i.test(judgeOutput.trim());
}

export function aggregatePerCategory(
  results: ReadonlyArray<ProductQuestionResult>,
): Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }> {
  const out: Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }> = {};
  for (const r of results) {
    const k = r.category ?? '_uncategorised';
    out[k] = out[k] ?? { total: 0, correct: 0, accuracy: 0, meanRetrievalMs: 0 };
    out[k].total++;
    if (r.correct) out[k].correct++;
    out[k].meanRetrievalMs += r.retrieval_ms;
  }
  for (const k of Object.keys(out)) {
    const c = out[k]!;
    c.accuracy = c.total > 0 ? c.correct / c.total : 0;
    c.meanRetrievalMs = c.total > 0 ? c.meanRetrievalMs / c.total : 0;
  }
  return out;
}
