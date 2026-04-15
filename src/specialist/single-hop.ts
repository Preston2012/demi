import { extractEntities } from './ir.js';
/**
 * Single-hop fact extractor.
 *
 * Targets: LOCOMO single-hop (17.9 pts). 75% of failures are "wrong fact"
 * where the model sees the right memory but extracts the wrong detail.
 *
 * Council R16:
 *   - GPT: fielded evidence extractor, identify target slot from question
 *   - Grok: pre-compute answer snippet the model currently mishandles
 *   - Gemini: highlighting specialist (test as flag)
 *
 * Approach: parse the question to identify what SLOT is being asked about,
 * then extract and rank candidate values from the IR facts.
 *
 * Example:
 *   Q: "What is Melanie's favorite restaurant?"
 *   Slot: favorite_restaurant
 *   Subject: Melanie
 *   Candidates:
 *     1. M14 | favorite_restaurant | Rosa Mexicano | 2023-06-14
 *     2. M09 | went_to_restaurant | Chipotle | 2023-05-02
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Answer Slot Detection
// ---------------------------------------------------------------------------

type AnswerSlot =
  | 'person' | 'location' | 'date' | 'count' | 'boolean'
  | 'activity' | 'object' | 'reason' | 'status' | 'attribute';

interface SlotDetection {
  slot: AnswerSlot;
  targetPredicate: string | null;  // inferred predicate to match
  targetSubject: string | null;    // inferred subject entity
  keywords: string[];              // key terms from the question
}

// S27 fix #8: predicateHint now set per slot (was dead code, +0.4 bonus now fires)
const SLOT_PATTERNS: Array<{ pattern: RegExp; slot: AnswerSlot; predicateHint?: string }> = [
  { pattern: /\b(?:where|which (?:city|country|state|place|location))\b/i, slot: 'location', predicateHint: 'location' },
  { pattern: /\b(?:when|what (?:date|time|year|month|day))\b/i, slot: 'date', predicateHint: 'visited' },
  { pattern: /\b(?:how many|how much|count|number of)\b/i, slot: 'count', predicateHint: 'has_count' },
  { pattern: /^(?:does|do|did|is|are|was|were|has|have|had|can|could|will|would)\b/i, slot: 'boolean' },
  { pattern: /\b(?:who|whom)\b/i, slot: 'person', predicateHint: 'relationship' },
  { pattern: /\b(?:activit|hobb|sport|exercise|pastime)\b/i, slot: 'activity', predicateHint: 'interest' },
  { pattern: /\b(?:why|reason|cause|motivation)\b/i, slot: 'reason' },
  { pattern: /\b(?:what(?:'s| is| was| are))\b/i, slot: 'attribute' },
];

function detectAnswerSlot(query: string): SlotDetection {
  let slot: AnswerSlot = 'attribute'; // default
  let predicateHint: string | null = null;

  for (const { pattern, slot: s, predicateHint: ph } of SLOT_PATTERNS) {
    if (pattern.test(query)) {
      slot = s;
      predicateHint = ph || null;
      break;
    }
  }

  // Extract subject from query (capitalized proper nouns)
  const names = extractEntities(query);
  const targetSubject = names?.[0] || null;

  // Extract key content words (nouns/adjectives from the question)
  const stopwords = new Set([
    'what', 'which', 'where', 'when', 'who', 'how', 'does', 'did', 'is', 'are',
    'was', 'were', 'has', 'have', 'had', 'the', 'a', 'an', 'of', 'in', 'to',
    'for', 'with', 'on', 'at', 'by', 'from', 'that', 'this', 'and', 'or', 'but',
    'do', 'can', 'could', 'would', 'will', 'about', 'into', 'not', 'been',
    'his', 'her', 'their', 'its', 'my', 'your', 'our', 'she', 'he', 'they',
    'it', 'we', 'you', 'me', 'him', 'them', 'us',
  ]);

  const keywords = query
    .replace(/[?.,!'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());

  return { slot, targetPredicate: predicateHint, targetSubject, keywords };
}

// ---------------------------------------------------------------------------
// Candidate Ranking
// ---------------------------------------------------------------------------

interface RankedCandidate {
  fact: NormalizedFact;
  score: number;        // composite rank score
  matchReasons: string[];
}

function rankCandidates(
  facts: NormalizedFact[],
  detection: SlotDetection,
): RankedCandidate[] {
  const candidates: RankedCandidate[] = [];

  for (const fact of facts) {
    let score = fact.score; // start with retrieval score
    const reasons: string[] = [];

    // Subject match bonus
    if (detection.targetSubject) {
      if (fact.subject.toLowerCase() === detection.targetSubject.toLowerCase()) {
        score += 0.5;
        reasons.push('exact_subject');
      } else if (fact.subject.toLowerCase().includes(detection.targetSubject.toLowerCase())) {
        score += 0.25;
        reasons.push('partial_subject');
      }
    }

    // Keyword overlap bonus
    const claimLower = fact.sourceText.toLowerCase();
    let keywordHits = 0;
    for (const kw of detection.keywords) {
      if (claimLower.includes(kw)) keywordHits++;
    }
    if (detection.keywords.length > 0) {
      const keywordRatio = keywordHits / detection.keywords.length;
      score += keywordRatio * 0.3;
      if (keywordRatio > 0.5) reasons.push(`keywords_${keywordHits}/${detection.keywords.length}`);
    }

    // Predicate match bonus
    if (detection.targetPredicate && fact.predicate === detection.targetPredicate) {
      score += 0.4;
      reasons.push('predicate_match');
    }

    // Negation penalty for non-boolean questions
    if (fact.negated && detection.slot !== 'boolean') {
      score -= 0.3;
      reasons.push('negated');
    }

    // Certainty bonus: asserted > planned > hypothetical
    if (fact.certainty === 'asserted') score += 0.1;
    if (fact.certainty === 'superseded') score -= 0.4;

    // Recency bonus (newer facts slightly preferred for current-state style questions)
    if (fact.time) {
      const ageMs = Date.now() - new Date(fact.time).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 90) score += 0.05;
    }

    candidates.push({ fact, score, matchReasons: reasons });
  }

  // Sort by composite score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

// ---------------------------------------------------------------------------
// Single-Hop Specialist
// ---------------------------------------------------------------------------

export const singleHopSpecialist = {
  name: 'single-hop',

  shouldRun(ops: RequiredOperations): boolean {
    return ops.extractFact;
  },

  process(facts: NormalizedFact[], query: string, _queryType: QueryType): SpecialistOutput {
    const detection = detectAnswerSlot(query);
    const ranked = rankCandidates(facts, detection);

    // Take top candidates (more than 1 for the model to verify against)
    const topN = Math.min(ranked.length, 5);
    const top = ranked.slice(0, topN);

    if (top.length === 0) {
      return {
        source: 'single-hop',
        derivedEvidence: `[FACT EXTRACTION] No candidate facts found for: ${detection.slot} about ${detection.targetSubject || 'unknown'}`,
        factsUsed: [],
        processingMs: 0,
      };
    }

    const lines: string[] = [];
    lines.push(`ANSWER SLOT: ${detection.slot}${detection.targetSubject ? ` | SUBJECT: ${detection.targetSubject}` : ''}`);
    lines.push(`KEYWORDS: ${detection.keywords.join(', ')}`);
    lines.push('');
    lines.push('RANKED CANDIDATES:');

    for (let i = 0; i < top.length; i++) {
      const c = top[i]!;
      const timeStr = c.fact.time ? ` | time=${c.fact.time}` : '';
      const negStr = c.fact.negated ? ' | NEGATED' : '';
      const certStr = c.fact.certainty !== 'asserted' ? ` | ${c.fact.certainty}` : '';

      lines.push(
        `  ${i + 1}. ${c.fact.memoryId} | subject=${c.fact.subject} | ` +
        `${c.fact.predicate}=${c.fact.object}${timeStr}${negStr}${certStr}`
      );
      if (c.matchReasons.length > 0) {
        lines.push(`     match: ${c.matchReasons.join(', ')}`);
      }
    }

    // Highlight the top candidate
    const best = top[0]!;
    lines.push('');
    lines.push(
      `BEST MATCH: ${best.fact.object} ` +
      `(from ${best.fact.memoryId}, ${best.fact.predicate}, subject=${best.fact.subject})`
    );

    return {
      source: 'single-hop',
      derivedEvidence: lines.join('\n'),
      factsUsed: top.map(c => c.fact.memoryId),
      processingMs: 0,
    };
  },
};
