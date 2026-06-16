/**
 * C2: Post-retrieval semantic dedup
 * 
 * Removes near-duplicate facts from the injection set before they reach
 * the answer model. Uses token-overlap (Jaccard similarity) within
 * subject groups. Deterministic, no LLM calls.
 *
 * Called after ranking, before injection builder.
 */

import type { FinalScoredCandidate } from './scorer.js';
import { createLogger } from '../config.js';

const log = createLogger('dedup-injection');

const STOP_WORDS = new Set([
  'the','a','an','in','on','at','to','for','of','with','by','from',
  'and','or','but','not','that','this','their','her','his','its',
  'she','he','they','is','are','was','were','has','have','had',
  'be','been','being','do','does','did','will','would','could',
  'should','may','might','can','about','also','than','some','very',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Remove near-duplicate facts from ranked candidates.
 * 
 * Within each subject group, if two facts have Jaccard similarity > threshold,
 * keep the one with higher finalScore.
 * 
 * @param threshold - Jaccard similarity threshold (default 0.7)
 */
export function dedupInjectionSet(
  candidates: FinalScoredCandidate[],
  threshold = 0.7,
): FinalScoredCandidate[] {
  if (candidates.length <= 1) return candidates;

  // Group by subject for faster comparison (only compare within same subject)
  const bySubject = new Map<string, FinalScoredCandidate[]>();
  for (const c of candidates) {
    const subj = c.candidate.record.subject || '__general__';
    const group = bySubject.get(subj);
    if (group) group.push(c);
    else bySubject.set(subj, [c]);
  }

  const kept: FinalScoredCandidate[] = [];
  let droppedCount = 0;

  for (const [_subject, group] of bySubject) {
    // Sort by score descending (highest first = kept first)
    group.sort((a, b) => b.finalScore - a.finalScore);

    const tokenSets = group.map(c => tokenize(c.candidate.record.claim));
    const dropped = new Set<number>();

    for (let i = 0; i < group.length; i++) {
      if (dropped.has(i)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (dropped.has(j)) continue;
        const sim = jaccardSimilarity(tokenSets[i]!, tokenSets[j]!);
        if (sim >= threshold) {
          // Drop the lower-scored one (j, since sorted desc)
          dropped.add(j);
          droppedCount++;
        }
      }
    }

    for (let i = 0; i < group.length; i++) {
      if (!dropped.has(i)) kept.push(group[i]!);
    }
  }

  if (droppedCount > 0) {
    log.debug({ droppedCount, before: candidates.length, after: kept.length }, 'Dedup removed near-duplicates');
  }

  // Re-sort by original finalScore descending
  kept.sort((a, b) => b.finalScore - a.finalScore);
  return kept;
}
