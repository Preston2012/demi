import type { FinalScoredCandidate } from '../retrieval/scorer.js';
import type { ConflictNotice } from '../schema/memory.js';
import { claimsRelated } from '../write/claim-similarity.js';

/**
 * Conflict detection + surfacing logic.
 *
 * Refusal-first injection: when retrieved memories conflict with each
 * other, we don't silently pick one or drop both. We inject the most
 * recent memory AND a notice that earlier context disagrees.
 *
 * Two conflict types detected:
 * 1. Explicit: memory.conflictsWith contains IDs of other retrieved memories
 * 2. Subject overlap: multiple memories about the same subject with different claims
 *
 * V1 is conservative: only surfaces explicit conflicts (stored in schema).
 * V2 could add semantic contradiction detection via LLM.
 */

/**
 * Find explicit conflicts among a set of retrieved candidates.
 * A conflict exists when memory A's conflictsWith array contains
 * the ID of memory B, and both A and B are in the result set.
 */
export function detectExplicitConflicts(
  candidates: FinalScoredCandidate[],
): ConflictNotice[] {
  const notices: ConflictNotice[] = [];
  const idSet = new Set(candidates.map((c) => c.id));

  for (const candidate of candidates) {
    const record = candidate.candidate.record;
    for (const conflictId of record.conflictsWith) {
      // Only surface if both sides are in the result set
      if (idSet.has(conflictId)) {
        notices.push({
          memoryId: record.id,
          conflictsWithId: conflictId,
          message: buildConflictMessage(candidate, conflictId, candidates),
        });
      }
    }
  }

  return deduplicateNotices(notices);
}

/**
 * Detect subject-overlap conflicts: multiple memories about the
 * same subject that might contradict each other.
 * Only flags when same subject has 2+ memories with different claims.
 */
export function detectSubjectConflicts(
  candidates: FinalScoredCandidate[],
): ConflictNotice[] {
  const notices: ConflictNotice[] = [];
  const bySubject = new Map<string, FinalScoredCandidate[]>();

  for (const c of candidates) {
    const subject = c.candidate.record.subject.toLowerCase();
    const group = bySubject.get(subject) || [];
    group.push(c);
    bySubject.set(subject, group);
  }

  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;

    // Check if claims are actually different (not just different provenance)
    const uniqueClaims = new Set(
      group.map((c) => c.candidate.record.claim.toLowerCase().trim()),
    );

    if (uniqueClaims.size > 1) {
      // Sort by score descending. Top is "winner", flag the rest.
      const sorted = [...group].sort((a, b) => b.finalScore - a.finalScore);

      for (let i = 1; i < sorted.length; i++) {
        // Only flag as conflict if the claims are about the same topic
        const topClaim = sorted[0]!.candidate.record.claim;
        const otherClaim = sorted[i]!.candidate.record.claim;
        if (!claimsRelated(topClaim, otherClaim)) continue;

        notices.push({
          memoryId: sorted[0]!.id,
          conflictsWithId: sorted[i]!.id,
          message: `Multiple memories about "${subject}" with different claims. Showing highest-scored. Earlier context may disagree.`,
        });
      }
    }
  }

  return notices;
}

/**
 * Build a human-readable conflict message.
 */
function buildConflictMessage(
  _candidate: FinalScoredCandidate,
  conflictId: string,
  allCandidates: FinalScoredCandidate[],
): string {
  const conflicting = allCandidates.find((c) => c.id === conflictId);
  if (!conflicting) {
    return `Memory conflicts with ${conflictId} (not in current result set).`;
  }

  const conflictDate = new Date(
    conflicting.candidate.record.updatedAt,
  ).toLocaleDateString();

  return `Earlier context from ${conflictDate} disagrees. Review recommended.`;
}

/**
 * Deduplicate conflict notices.
 * A↔B should only produce one notice, not two.
 */
function deduplicateNotices(notices: ConflictNotice[]): ConflictNotice[] {
  const seen = new Set<string>();
  const result: ConflictNotice[] = [];

  for (const notice of notices) {
    // Create a canonical key (sorted pair)
    const pair = [notice.memoryId, notice.conflictsWithId].sort().join('|');
    if (!seen.has(pair)) {
      seen.add(pair);
      result.push(notice);
    }
  }

  return result;
}

/**
 * Run all conflict detection and merge results.
 */
export function detectAllConflicts(
  candidates: FinalScoredCandidate[],
): ConflictNotice[] {
  const explicit = detectExplicitConflicts(candidates);
  const subject = detectSubjectConflicts(candidates);

  // Merge and deduplicate across both detection methods
  return deduplicateNotices([...explicit, ...subject]);
}

/**
 * Build a map of memory ID to inline conflict tag.
 * Used by the formatter to prepend [CURRENT] or [SUPERSEDED] to facts.
 */
export function buildConflictTagMap(
  candidates: FinalScoredCandidate[],
): Map<string, string> {
  const tags = new Map<string, string>();
  const bySubject = new Map<string, FinalScoredCandidate[]>();

  for (const c of candidates) {
    const subject = c.candidate.record.subject.toLowerCase();
    const group = bySubject.get(subject) || [];
    group.push(c);
    bySubject.set(subject, group);
  }

  for (const [, group] of bySubject) {
    if (group.length < 2) continue;

    // Check for explicit supersedes relationships
    for (const c of group) {
      const rec = c.candidate.record;
      if (rec.supersedes) {
        const supersededInGroup = group.find(g => g.id === rec.supersedes);
        if (supersededInGroup) {
          tags.set(rec.id, "[CURRENT]");
          tags.set(supersededInGroup.id, "[SUPERSEDED]");
        }
      }
    }

    // For subject-overlap conflicts without explicit supersedes,
    // use timestamp: newer = CURRENT, older = SUPERSEDED
    const related = group.filter(c => !tags.has(c.id));
    if (related.length < 2) continue;

    // Only tag if claims are actually different and related
    for (let i = 0; i < related.length; i++) {
      for (let j = i + 1; j < related.length; j++) {
        const a = related[i]!;
        const b = related[j]!;
        if (!claimsRelated(a.candidate.record.claim, b.candidate.record.claim)) continue;
        if (tags.has(a.id) || tags.has(b.id)) continue;

        const aTime = new Date(a.candidate.record.updatedAt).getTime();
        const bTime = new Date(b.candidate.record.updatedAt).getTime();
        if (aTime > bTime) {
          tags.set(a.id, "[CURRENT]");
          tags.set(b.id, "[SUPERSEDED]");
        } else if (bTime > aTime) {
          tags.set(b.id, "[CURRENT]");
          tags.set(a.id, "[SUPERSEDED]");
        } else {
          tags.set(a.id, "[CONFLICT-UNRESOLVED]");
          tags.set(b.id, "[CONFLICT-UNRESOLVED]");
        }
      }
    }
  }

  return tags;
}
