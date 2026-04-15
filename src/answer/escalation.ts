/**
 * Answer confidence escalation.
 *
 * The confidence cascade:
 * 1. Cheap model answers first (gpt-4.1-mini, $0.40/$1.60)
 * 2. Confidence gate evaluates answer quality
 * 3. If low confidence, expensive model re-answers (Grok reasoning, $0.20/$0.50)
 *
 * This is answer-quality routing, not query-type routing.
 * The router.ts picks model by query category.
 * This module picks model by answer quality. More precise, more adaptive.
 *
 * Flag: ANSWER_ESCALATION_ENABLED=true (default: false)
 * Cost control: only ~20% of queries should escalate (the hard ones)
 */

import { createLogger } from '../config.js';

const log = createLogger('answer-escalation');

export interface EscalationResult {
  /** Should escalate to expensive model? */
  shouldEscalate: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Why this decision was made */
  reason: string;
  /** Detected signals */
  signals: string[];
}

// Hedging patterns that indicate low confidence
const HEDGE_PATTERNS = [
  /\b(I'm not sure|I don't know|I cannot determine|unclear|uncertain|hard to say)\b/i,
  /\b(it('s| is) (possible|likely|unclear) (that|whether))\b/i,
  /\b(I don't have (enough|sufficient) (information|context|data))\b/i,
  /\b(based on (the )?(limited|available) (context|information))\b/i,
  /\b(there (is|are) no (clear|explicit|direct) (mention|reference|indication))\b/i,
  /\b(cannot (be determined|confirm|verify))\b/i,
  /\b(not (explicitly|clearly|directly) (mentioned|stated|indicated))\b/i,
];

// Refusal patterns that indicate the model couldn't answer
const REFUSAL_PATTERNS = [
  /\b(I (cannot|can't|am unable to) (answer|determine|find|provide))\b/i,
  /\b(no (information|data|context|mention|record) (about|regarding|on|for))\b/i,
  /\b(the (memory|context) does(n't| not) (contain|include|mention|provide))\b/i,
  /\b(not enough (context|information) to)\b/i,
];

// Vagueness patterns
const VAGUE_PATTERNS = [
  /\b(various|several|some|many|multiple) (things|activities|events)\b/i,
  /\b(and (other|more|so on|etc))\b/i,
];

/**
 * Evaluate answer confidence based on linguistic signals.
 * Pure deterministic analysis, no LLM calls.
 */
export function evaluateConfidence(
  answer: string,
  query: string,
  retrievedFactCount: number,
): EscalationResult {
  if (process.env.ANSWER_ESCALATION_ENABLED !== 'true') {
    return { shouldEscalate: false, confidence: 1.0, reason: 'escalation disabled', signals: [] };
  }

  const signals: string[] = [];
  let confidence = 1.0;

  // Signal 1: Hedging language
  for (const pattern of HEDGE_PATTERNS) {
    if (pattern.test(answer)) {
      signals.push('hedging');
      confidence -= 0.25;
      break; // One hedge is enough signal
    }
  }

  // Signal 2: Refusal / inability
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(answer)) {
      signals.push('refusal');
      confidence -= 0.35;
      break;
    }
  }

  // Signal 3: Very short answer for a complex question
  const wordCount = answer.split(/\s+/).length;
  const isComplexQuery = /\b(when|how|why|what happened|describe|explain|compare)\b/i.test(query);
  if (isComplexQuery && wordCount < 8) {
    signals.push('too_short');
    confidence -= 0.2;
  }

  // Signal 4: Vagueness
  for (const pattern of VAGUE_PATTERNS) {
    if (pattern.test(answer)) {
      signals.push('vague');
      confidence -= 0.15;
      break;
    }
  }

  // Signal 5: Low retrieval support (few facts found)
  if (retrievedFactCount < 2) {
    signals.push('low_retrieval');
    confidence -= 0.2;
  }

  // Signal 6: Answer doesn't address the question entity
  // Extract the main entity from the query and check if answer mentions it
  const queryEntities = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  if (queryEntities.length > 0) {
    const mentionsEntity = queryEntities.some(e => answer.includes(e));
    if (!mentionsEntity) {
      signals.push('entity_missing');
      confidence -= 0.15;
    }
  }

  // Clamp confidence
  confidence = Math.max(0, Math.min(1, confidence));

  // Escalation threshold
  const threshold = parseFloat(process.env.ESCALATION_THRESHOLD || '0.6');
  const shouldEscalate = confidence < threshold;

  if (shouldEscalate) {
    log.info({
      confidence: confidence.toFixed(2),
      signals,
      queryPreview: query.substring(0, 60),
      answerPreview: answer.substring(0, 60),
    }, 'Answer escalation triggered');
  }

  return {
    shouldEscalate,
    confidence,
    reason: shouldEscalate
      ? `confidence ${confidence.toFixed(2)} < threshold ${threshold}`
      : `confidence ${confidence.toFixed(2)} >= threshold ${threshold}`,
    signals,
  };
}

/**
 * Get the escalation model (the expensive one).
 */
export function getEscalationModel(): string {
  return process.env.ESCALATION_MODEL || 'grok-4-1-fast-reasoning';
}

/**
 * Build escalation prompt suffix.
 * Tells the expensive model that a cheaper model struggled.
 */
export function getEscalationPromptSuffix(originalAnswer: string, signals: string[]): string {
  const signalText = signals.length > 0
    ? ` (detected issues: ${signals.join(', ')})`
    : '';

  return (
    `A simpler model attempted this question but produced a low-confidence answer${signalText}. ` +
    `Its attempt was: "${originalAnswer.substring(0, 200)}". ` +
    `Please provide a more thorough, well-reasoned answer using the memory context. ` +
    `Be specific and cite details from the context.`
  );
}
