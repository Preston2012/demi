/**
 * Fact-Family Collapse (FFC)
 *
 * Collapses dual-phrasing siblings: keeps highest-scored member per canonical family.
 * Deterministic tiebreak: prefer isCanonical=true on equal score.
 *
 * Called twice in pipeline:
 *   1. After rankCandidates (before cascade) — prevents siblings from consuming cascade slots
 *   2. After cascade output — prevents cascade from reintroducing siblings
 */

import type { FinalScoredCandidate } from './scorer.js';
import { createLogger } from '../config.js';

const log = createLogger('collapse');

export function collapseFactFamilies(candidates: FinalScoredCandidate[]): FinalScoredCandidate[] {
  if (candidates.length === 0) return candidates;

  const families = new Map<string, FinalScoredCandidate[]>();
  const noFamily: FinalScoredCandidate[] = [];

  for (const c of candidates) {
    const famId = c.candidate.record.canonicalFactId;
    if (!famId) {
      noFamily.push(c);
      continue;
    }
    const group = families.get(famId);
    if (group) {
      group.push(c);
    } else {
      families.set(famId, [c]);
    }
  }

  const collapsed: FinalScoredCandidate[] = [...noFamily];
  let droppedCount = 0;

  for (const [_famId, group] of families) {
    if (group.length === 1) {
      collapsed.push(group[0]!);
      continue;
    }

    // Sort: highest score first, tiebreak on isCanonical
    group.sort((a, b) => {
      const scoreDiff = b.finalScore - a.finalScore;
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      // Tiebreak: prefer canonical
      const aCanon = a.candidate.record.isCanonical ? 1 : 0;
      const bCanon = b.candidate.record.isCanonical ? 1 : 0;
      return bCanon - aCanon;
    });

    collapsed.push(group[0]!);
    droppedCount += group.length - 1;
  }

  if (droppedCount > 0) {
    log.debug({ droppedCount, remaining: collapsed.length }, 'FFC collapsed fact families');
  }

  // Re-sort by finalScore to maintain ranking order
  collapsed.sort((a, b) => b.finalScore - a.finalScore);
  return collapsed;
}
