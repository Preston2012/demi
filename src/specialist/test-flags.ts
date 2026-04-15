import { extractEntities } from './ir.js';
/**
 * Test flag modules.
 *
 * Council R16 split decisions. Build as flags, A/B test after specialists land.
 * - COT_SCRATCHPAD: Gemini says mandatory, 3 say no
 * - HIGHLIGHT_KEYWORDS: Gemini only, clever but unproven
 * - RERANK_AFTER_IR: GPT + Gemini say worth it, Grok says unnecessary
 *
 * Each exports a simple transform function and an isEnabled check.
 */

// ---------------------------------------------------------------------------
// 1. COT_SCRATCHPAD
//    Adds chain-of-thought instruction for list/summary queries.
//    Forces model to enumerate in a scratchpad before answering.
// ---------------------------------------------------------------------------

/**
 * Wrap the answer prompt with a chain-of-thought instruction.
 * The model is asked to think step-by-step in a scratchpad block
 * before producing the final answer.
 */
export function applyCotScratchpad(answerPrompt: string, queryRequiresList: boolean): string {
  if (!isCotEnabled()) return answerPrompt;
  if (!queryRequiresList) return answerPrompt;

  const cotPrefix =
    'Before answering, use a <scratchpad> block to:\n' +
    '1. List every distinct entity, item, or fact from the memories that is relevant.\n' +
    '2. Count them.\n' +
    '3. Check if any are duplicates or superseded.\n' +
    'Then provide your final answer after the scratchpad.\n\n';

  return cotPrefix + answerPrompt;
}

export function isCotEnabled(): boolean {
  return process.env.COT_SCRATCHPAD === 'true';
}

// ---------------------------------------------------------------------------
// 2. HIGHLIGHT_KEYWORDS
//    Bolds query keywords in injected memory text for attention anchoring.
//    Gemini council: mechanical anchor for LLM attention mechanism.
// ---------------------------------------------------------------------------

/**
 * Highlight query keywords in memory text by wrapping them in **bold**.
 * This serves as an attention anchor without altering the content.
 */
export function highlightKeywords(memoryText: string, query: string): string {
  if (!isHighlightEnabled()) return memoryText;

  // Extract content keywords from query (skip stopwords)
  const stopwords = new Set([
    'what', 'which', 'where', 'when', 'who', 'how', 'does', 'did', 'is', 'are',
    'was', 'were', 'has', 'have', 'had', 'the', 'a', 'an', 'of', 'in', 'to',
    'for', 'with', 'on', 'at', 'by', 'from', 'that', 'this', 'and', 'or', 'but',
    'do', 'can', 'could', 'would', 'will', 'about', 'not', 'been', 'his', 'her',
    'their', 'its', 'my', 'your', 'she', 'he', 'they', 'it', 'me', 'him',
  ]);

  const keywords = query
    .replace(/[?.,!'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()));

  if (keywords.length === 0) return memoryText;

  let result = memoryText;
  for (const kw of keywords) {
    // Case-insensitive replace, preserve original case
    const regex = new RegExp(`\\b(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
    result = result.replace(regex, '**$1**');
  }

  return result;
}

export function isHighlightEnabled(): boolean {
  return process.env.HIGHLIGHT_KEYWORDS === 'true';
}

// ---------------------------------------------------------------------------
// 3. RERANK_AFTER_IR
//    Re-ranks normalized facts by relevance to the query after IR extraction.
//    Uses keyword overlap + subject match (no vector ops in hot path).
// ---------------------------------------------------------------------------

import type { NormalizedFact } from './types.js';

/**
 * Re-rank normalized facts by query relevance.
 * Lightweight scoring: keyword overlap + subject match + recency.
 * No vector operations (per Grok: keep vectors out of pre-processing hot path).
 */
export function rerankFacts(facts: NormalizedFact[], query: string): NormalizedFact[] {
  if (!isRerankEnabled()) return facts;

  const queryLower = query.toLowerCase();
  const queryWords = queryLower
    .replace(/[?.,!'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Extract names from query for subject matching
  const queryNames = extractEntities(query);
  const queryNamesLower = queryNames.map((n: string) => n.toLowerCase());

  interface ScoredFact { fact: NormalizedFact; rerankScore: number }

  const scored: ScoredFact[] = facts.map(fact => {
    let score = fact.score; // base retrieval score

    // Subject match
    const subjectLower = fact.subject.toLowerCase();
    for (const name of queryNamesLower) {
      if (subjectLower.includes(name)) {
        score += 0.3;
        break;
      }
    }

    // Keyword overlap in claim
    const claimLower = fact.sourceText.toLowerCase();
    let hits = 0;
    for (const word of queryWords) {
      if (claimLower.includes(word)) hits++;
    }
    if (queryWords.length > 0) {
      score += (hits / queryWords.length) * 0.4;
    }

    // Predicate relevance
    const objectLower = fact.object.toLowerCase();
    for (const word of queryWords) {
      if (objectLower.includes(word)) {
        score += 0.1;
        break;
      }
    }

    // Recency boost (newer facts slightly preferred)
    if (fact.time) {
      const ageMs = Date.now() - new Date(fact.time).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 30) score += 0.1;
      else if (ageDays < 90) score += 0.05;
    }

    // Certainty: asserted > planned > hypothetical
    if (fact.certainty === 'asserted') score += 0.05;
    if (fact.certainty === 'superseded') score -= 0.3;
    if (fact.negated) score -= 0.1;

    return { fact, rerankScore: score };
  });

  // Sort by rerank score descending
  scored.sort((a, b) => b.rerankScore - a.rerankScore);

  return scored.map(s => s.fact);
}

export function isRerankEnabled(): boolean {
  return process.env.RERANK_AFTER_IR === 'true';
}
