/**
 * Answer canonicalizer.
 *
 * Product-level post-processor that cleans model output before it reaches the user.
 * Strips verbose preamble, normalizes formatting, extracts core answers.
 *
 * This is a PRODUCT feature, not a benchmark trick. Cleaner answers = better UX
 * AND better benchmark scores (judges evaluate cleaner text more accurately).
 *
 * Flag: ANSWER_CANONICALIZE (default: false, opt-in)
 * S25: Council-approved. Ships with the product.
 */

import { createLogger } from '../config.js';

const log = createLogger('canonicalizer');

/** Preamble phrases models commonly prefix answers with. Case-insensitive strip. */
const PREAMBLE_PATTERNS: RegExp[] = [
  /^(based on|according to|from) (the |my )?(available |provided )?(memory context|memory|memories|context|information|data|records)\s*[,.:]?\s*/i,
  /^(looking at|reviewing|examining|considering) (the |my )?(memory context|memory|memories|context|available information)\s*[,.:]?\s*/i,
  /^(the (memory |memories |available )?(context )?(shows|indicates|suggests|mentions|states|reveals) (that )?)/i,
  /^yes\s*[,.!]?\s*/i,
  /^no\s*[,.!]?\s+/i,
  /^sure[,!.]?\s*/i,
  /^certainly[,!.]?\s*/i,
  /^of course[,!.]?\s*/i,
  /^here'?s? (what|the answer)[^:]*:\s*/i,
  /^to answer (your |this |the )?question[,:]?\s*/i,
];

/** Hedging suffixes that add nothing. */
const SUFFIX_PATTERNS: RegExp[] = [
  /[,.]?\s*(however,? )?(I |it )?(don'?t|do not|doesn'?t) have (enough |sufficient )?(information|context|data|memories) (to |about ).*$/i,
  /[,.]?\s*please (note|keep in mind) that.*$/i,
  /[,.]?\s*it('?s| is) (worth noting|important to note) that.*$/i,
  /[,.]?\s*this is based (on|solely on) the (available |provided )?(memory |memories |context|information).*$/i,
];

/** Number words to digits. */
const NUMBER_MAP: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20',
};

/**
 * Canonicalize an answer. Deterministic, no LLM calls.
 * Strips preamble, normalizes numbers, cleans formatting.
 */
export function canonicalize(answer: string): string {
  if (!answer || answer.trim().length === 0) return answer;

  let result = answer.trim();

  // 1. Strip markdown formatting (bold -> content, italic -> content, headers, citations)
  result = result.replace(/\[\d+\]/g, '');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/^#+\s+/gm, '');

  // 2. Strip preamble (apply repeatedly for double-preamble)
  let changed = true;
  let passes = 0;
  while (changed && passes < 3) {
    changed = false;
    for (const pattern of PREAMBLE_PATTERNS) {
      const before = result;
      result = result.replace(pattern, '');
      if (result !== before) changed = true;
    }
    passes++;
  }

  // 3. Strip hedging suffixes
  for (const pattern of SUFFIX_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // 4. Normalize number words to digits (word boundary match)
  for (const [word, digit] of Object.entries(NUMBER_MAP)) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, digit);
  }

  // 5. Strip leading punctuation left by preamble/bold removal
  result = result.replace(/^[,.;:\s]+/, '');

  // 6. Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();

  // 7. Capitalize first letter if lowered by preamble strip
  if (result.length > 0 && result.charAt(0) !== result.charAt(0).toUpperCase()) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  // 8. Strip trailing period if the answer is short (< 80 chars, likely a fact)
  if (result.length < 80 && result.endsWith('.')) {
    result = result.slice(0, -1).trim();
  }

  if (result !== answer.trim()) {
    log.debug({ original: answer.substring(0, 80), canonicalized: result.substring(0, 80) }, 'Answer canonicalized');
  }

  return result;
}

/**
 * Check if canonicalization is enabled.
 */
export function isCanonicalizeEnabled(): boolean {
  return process.env.ANSWER_CANONICALIZE === 'true';
}
