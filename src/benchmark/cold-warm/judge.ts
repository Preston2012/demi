/**
 * Bench 5 (Cold-Warm Transition), deterministic judge.
 *
 * seed-only / user-only:
 *   - PASS if the expected_keyword appears in the answer.
 *   - Provenance check is reported separately by the runner against the
 *     retrieved set (≥1 of expected provenance).
 *
 * hybrid:
 *   - PASS if BOTH expected_keywords appear (seed value + user value).
 *
 * conflict:
 *   - PASS if user value (expected_keyword) appears AND seed value
 *     (expected_excludes) does NOT.
 */

import type { ColdWarmQuestion } from './generator.js';

export interface ColdWarmJudgeResult {
  correct: boolean;
  /** True when seed value contaminated a user-only/conflict answer. */
  seedLeak: boolean;
  /** True when user value contaminated a seed-only answer. */
  userLeak: boolean;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function containsAll(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const h = lower(haystack);
  // S46: paraphrase-tolerant. Each needle is split on whitespace; all tokens
  // (length >= 2) must appear in haystack but not necessarily contiguously.
  // Stops failing on "weekly 30-minute" vs "weekly as a 30-minute meeting".
  return needles.every((n) => {
    // S46: split on whitespace AND hyphens so '1-week' matches '1 week'.
    const tokens = lower(n)
      .split(/[\s-]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return true;
    return tokens.every((t) => {
      // Direct substring match
      if (h.includes(t)) return true;
      // Stem: strip trailing 's' for plural ('sprints' -> 'sprint')
      if (t.length >= 4 && t.endsWith('s') && h.includes(t.slice(0, -1))) return true;
      return false;
    });
  });
}

function containsAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const h = lower(haystack);
  return needles.some((n) => h.includes(lower(n)));
}

function hasComparisonLanguage(answer: string): boolean {
  return /\b(compare|contrast|differ|differs|versus|while|whereas|but|however|on the other hand|than)\b/i.test(answer);
}

export function judge(question: ColdWarmQuestion, predicted: string): ColdWarmJudgeResult {
  const ans = predicted ?? '';
  switch (question.type) {
    case 'seed-only':
      return {
        correct: containsAll(ans, question.expected_keywords),
        seedLeak: false,
        userLeak: false,
      };
    case 'user-only':
      return {
        correct: containsAll(ans, question.expected_keywords),
        seedLeak: false,
        userLeak: false,
      };
    case 'hybrid': {
      // S69 J: hybrid questions store [seedKeyword, userKeyword]. Allow either
      // keyword + explicit comparison language to count as a pass, LLM often
      // paraphrases one side. Falls back to all-keywords when array shape
      // doesn't have exactly 2 entries.
      const [seedKw, userKw] = question.expected_keywords;
      if (seedKw && userKw && question.expected_keywords.length === 2) {
        const hasSeed = containsAll(ans, [seedKw]);
        const hasUser = containsAll(ans, [userKw]);
        const correct = (hasSeed && hasUser) || ((hasSeed || hasUser) && hasComparisonLanguage(ans));
        return { correct, seedLeak: false, userLeak: false };
      }
      return {
        correct: containsAll(ans, question.expected_keywords),
        seedLeak: false,
        userLeak: false,
      };
    }
    case 'conflict': {
      // S46: bench-design fix. Conflict resolution = user version wins, not
      // "old value never mentioned." Predicted answers naturally mention
      // both as context ("given up X, now do Y"). Track seedAlsoMentioned
      // separately as seedLeak metric without failing the case on it.
      const includesUser = containsAll(ans, question.expected_keywords);
      const seedAlsoMentioned = containsAny(ans, question.expected_excludes);
      return {
        correct: includesUser,
        seedLeak: seedAlsoMentioned,
        userLeak: false,
      };
    }
  }
}
