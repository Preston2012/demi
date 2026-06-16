/**
 * Bench 4 (Skin Persona), deterministic judge.
 *
 * direct-relevant / adjacent-relevant:
 *   - PASS if at least 1 expected_keyword present (substring, case-insensitive)
 *     AND no expected_excludes appear.
 *   - The "any keyword" rule is forgiving: real LLM answers vary in vocabulary;
 *     what we want to lock down is the *exclusion* of persona-violating items.
 *
 * unrelated-control:
 *   - PASS if NO persona_keywords appear in the answer.
 *   - The persona must not "leak" into orthogonal questions.
 */

import type { SkinPersonaQuestion } from './generator.js';

export interface SkinPersonaJudgeResult {
  correct: boolean;
  /** True when persona-keyword leaked into an unrelated answer. */
  personaLeak: boolean;
  /** True when an excluded keyword appeared in a relevant answer (persona constraint violated). */
  exclusionViolation: boolean;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const h = lower(haystack);
  return needles.some((n) => h.includes(lower(n)));
}

function containsNone(haystack: string, needles: string[]): boolean {
  // Word-boundary aware: "peanut-free" must NOT trigger "peanut" exclusion.
  return needles.every((n) => {
    const escaped = lower(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, 'i');
    return !pattern.test(haystack);
  });
}

export function judge(question: SkinPersonaQuestion, predicted: string): SkinPersonaJudgeResult {
  const ans = predicted ?? '';

  if (question.type === 'unrelated-control') {
    const leak = containsAny(ans, question.persona_keywords);
    return { correct: !leak, personaLeak: leak, exclusionViolation: false };
  }

  // Direct or adjacent relevant.
  const includesAtLeastOne = question.expected_keywords.length === 0 || containsAny(ans, question.expected_keywords);
  const excludesAllForbidden = containsNone(ans, question.expected_excludes);
  const exclusionViolation = !excludesAllForbidden;
  return {
    correct: includesAtLeastOne && excludesAllForbidden,
    personaLeak: false,
    exclusionViolation,
  };
}
