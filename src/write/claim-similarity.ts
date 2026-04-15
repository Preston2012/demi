/**
 * Claim similarity check for conflict detection.
 *
 * Two memories with the same subject only conflict if their claims
 * are about the same topic. "User prefers dark mode" vs "User prefers
 * light mode" = conflict. "Demiurge was verified" vs "connectors use
 * Streamable HTTP" = not a conflict, even though both have subject "demiurge".
 *
 * Uses Jaccard similarity on meaningful tokens (stop words removed).
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'about', 'also', 'then', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'them', 'their', 'we', 'us',
  'i', 'me', 'my', 'you', 'your',
]);

/**
 * Tokenize a claim into meaningful words.
 * Lowercases, splits on non-word characters, removes stop words and short tokens.
 */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0-1 where 1 = identical token sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}

/**
 * Check if two claims are about the same topic (and thus may conflict).
 *
 * Returns true when Jaccard similarity on meaningful tokens exceeds
 * the threshold (default 0.3). Two completely unrelated claims about
 * the same subject will have low overlap and return false.
 */
export function claimsRelated(
  claimA: string,
  claimB: string,
  threshold: number = 0.3,
): boolean {
  const tokensA = tokenize(claimA);
  const tokensB = tokenize(claimB);

  // If either claim has very few meaningful tokens, be lenient —
  // short claims about the same subject are more likely to conflict.
  if (tokensA.size <= 2 || tokensB.size <= 2) return true;

  return jaccardSimilarity(tokensA, tokensB) >= threshold;
}
