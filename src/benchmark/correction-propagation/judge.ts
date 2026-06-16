/**
 * Bench 1 (Correction Propagation), deterministic judge.
 *
 * Per question type, decide pass/fail. NO LLM. Returns phantom flag too,
 * so the runner can report the phantom rate (current questions answered
 * with the superseded value).
 */

import type { TraceQuestion } from './generator.js';

export interface JudgeResult {
  correct: boolean;
  /** True when a `current` question's answer mentions the superseded value. */
  phantom: boolean;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function containsAll(haystack: string, needles: string[]): boolean {
  const h = lower(haystack);
  return needles.every((n) => h.includes(lower(n)));
}

function containsAny(haystack: string, needles: string[]): boolean {
  const h = lower(haystack);
  return needles.some((n) => h.includes(lower(n)));
}

function containsNone(haystack: string, needles: string[]): boolean {
  const h = lower(haystack);
  return needles.every((n) => !h.includes(lower(n)));
}

export function judge(question: TraceQuestion, predicted: string): JudgeResult {
  const ans = predicted ?? '';

  switch (question.type) {
    case 'current': {
      const includesNew = containsAll(ans, question.expected_keywords);
      const excludesOld = containsNone(ans, question.expected_excludes);
      const phantom = !excludesOld;
      return { correct: includesNew && excludesOld, phantom };
    }
    case 'historical': {
      // Only require keyword match; do NOT exclude the new value (the
      // model may legitimately mention both for context).
      return { correct: containsAll(ans, question.expected_keywords), phantom: false };
    }
    case 'change': {
      // Accept either: an explicit change-marker keyword OR mentions of
      // both old and new values (which encodes "transitioned from X to Y").
      const explicitMarker = containsAny(ans, question.expected_keywords);
      const bothValues = containsAll(ans, [question.old_value, question.new_value]);
      return { correct: explicitMarker || bothValues, phantom: false };
    }
    case 'list': {
      return { correct: containsAll(ans, question.expected_keywords), phantom: false };
    }
  }
}
