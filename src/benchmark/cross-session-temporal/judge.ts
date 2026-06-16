/**
 * Bench 2 (Cross-Session Temporal), deterministic judge.
 *
 * Recall types (recent/mid/distant): need ≥3 distinctive nouns OR (when
 * the fact has fewer than 3 distinctive tokens) all of them. Time-anchored:
 * same recall semantics, answer must contain the distinctive nouns. The
 * "±1 session window" is enforced by sampling at fixture-time (the question
 * already references the right session by date label).
 *
 * Order-aware: literal "before" or "after" must match expected_order.
 */

import type { CSTQuestion } from './generator.js';

export interface CSTJudgeResult {
  correct: boolean;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function distinctiveOverlap(answer: string, tokens: string[]): number {
  const a = lower(answer);
  let hits = 0;
  for (const t of tokens) {
    if (a.includes(lower(t))) hits++;
  }
  return hits;
}

export function judge(question: CSTQuestion, predicted: string): CSTJudgeResult {
  const ans = predicted ?? '';

  if (question.type === 'order-aware') {
    const a = lower(ans);
    if (!question.expected_order) return { correct: false };
    const sawBefore = /\bbefore\b/.test(a);
    const sawAfter = /\bafter\b/.test(a);
    if (question.expected_order === 'before') return { correct: sawBefore && !sawAfter };
    return { correct: sawAfter && !sawBefore };
  }

  // Recall types and time-anchored: distinctive-noun overlap.
  const tokens = question.distinctive;
  if (tokens.length === 0) return { correct: false };
  const required = Math.min(3, tokens.length);
  const hits = distinctiveOverlap(ans, tokens);
  return { correct: hits >= required };
}
