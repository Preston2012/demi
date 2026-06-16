import type { FinalScoredCandidate } from '../retrieval/scorer.js';
import { createLogger } from '../config.js';
import { Provenance } from '../schema/memory.js';
import { spanSync } from '../telemetry/index.js';

const log = createLogger('budget');

/**
 * Packet C3 / Bug 4: provenance ranking for conflict resolution.
 *
 * When two memories collapse into the same canonical family
 * (`canonicalFactId`), the one with the higher rank wins. User-confirmed
 * facts beat seeded ones. Quarantined facts are deprioritized but not
 * dropped (they may still be the only available answer).
 *
 * Hierarchy (high → low):
 *   USER_CONFIRMED > LLM_EXTRACTED_CONFIDENT > IMPORTED (seeded) >
 *   LLM_EXTRACTED_QUARANTINE
 */
function provenanceRank(p: string): number {
  switch (p) {
    case Provenance.USER_CONFIRMED:
      return 4;
    case Provenance.LLM_EXTRACTED_CONFIDENT:
      return 3;
    case Provenance.IMPORTED:
      return 2;
    case Provenance.LLM_EXTRACTED_QUARANTINE:
      return 1;
    default:
      return 0;
  }
}

/**
 * Memory budget compiler: allocate injection slots by category.
 *
 * Given N total slots, distribute across memory types to ensure
 * diversity. Prevents one hot subject from consuming all slots.
 *
 * Strategy: proportional allocation with minimum 1 per category present,
 * then fill remaining slots by score.
 *
 * Risk per Preston: bad compiler buries critical memory. Log all decisions.
 */

export interface BudgetAllocation {
  candidates: FinalScoredCandidate[];
  allocation: Record<string, number>;
  dropped: { id: string; reason: string }[];
  /**
   * S4: cumulative estimated token count of the candidates that survived
   * the budget. Populated when caller passes `maxTokens`; otherwise 0.
   */
  estimatedTokens?: number;
}

/**
 * S4: estimate token count for a claim string.
 *
 * Uses a cheap heuristic: ~4 characters per token plus a small per-claim
 * overhead for separators/markdown markers added by the renderer. Good
 * enough for "don't blow past the LLM context budget" without pulling in
 * a real tokenizer for every claim on the hot path. If you need exact
 * counts (cost accounting, billing), use the provider's tokenizer instead.
 *
 * Conservative bias: rounds up so the cap is hit a little early rather
 * than late. Never returns less than 1.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars/token for English text; +4 tokens of formatting overhead per
  // claim line (M-prefix, score parens, newline, etc.).
  return Math.max(1, Math.ceil(text.length / 4) + 4);
}

/**
 * Family-aware: enforce one slot per canonical family.
 *
 * Packet C3 / Bug 4: provenance-aware conflict resolution. When two
 * memories share a canonical family, prefer the user version over the
 * seeded version. Tiebreak on validFrom/createdAt recency (more-recent
 * wins). S69: hardcoded ON; v1 first-in-input back-compat branch deleted.
 */
function deduplicateFamilies(candidates: FinalScoredCandidate[]): FinalScoredCandidate[] {
  // v2 (Packet C3 / Bug 4): pick winner per family using provenance + recency.
  const families = new Map<string, FinalScoredCandidate[]>();
  const noFamily: FinalScoredCandidate[] = [];
  for (const c of candidates) {
    const famId = c.candidate.record.canonicalFactId;
    if (!famId) {
      noFamily.push(c);
      continue;
    }
    if (!families.has(famId)) families.set(famId, []);
    families.get(famId)!.push(c);
  }

  const winners: FinalScoredCandidate[] = [];
  for (const family of families.values()) {
    if (family.length === 1) {
      winners.push(family[0]!);
      continue;
    }
    const sorted = [...family].sort((a, b) => {
      const pa = provenanceRank(a.candidate.record.provenance);
      const pb = provenanceRank(b.candidate.record.provenance);
      if (pa !== pb) return pb - pa; // higher rank first
      const ta = new Date(a.candidate.record.validFrom ?? a.candidate.record.createdAt).getTime();
      const tb = new Date(b.candidate.record.validFrom ?? b.candidate.record.createdAt).getTime();
      if (ta !== tb) return tb - ta; // more recent first
      return b.finalScore - a.finalScore;
    });
    winners.push(sorted[0]!);
  }

  // Preserve roughly the original order: walk the input, emit each
  // candidate when it's the family winner or has no family.
  const winnerIds = new Set(winners.map((c) => c.id));
  const result: FinalScoredCandidate[] = [];
  for (const c of candidates) {
    if (!c.candidate.record.canonicalFactId) {
      result.push(c);
    } else if (winnerIds.has(c.id)) {
      result.push(c);
    }
  }
  return result;
}

/**
 * S4: optional cumulative token budget. Counts memory CLAIM tokens (not
 * the surrounding renderer formatting beyond the small per-line overhead
 * baked into `estimateTokens`). Default 0 = no token cap (legacy
 * behavior preserved for benches and existing callers). Set via env
 * `INJECT_TOKEN_BUDGET` for the production path; tests pass it directly.
 */
function resolveTokenBudget(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return Math.floor(explicit);
  const raw = process.env.INJECT_TOKEN_BUDGET;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function compileBudget(
  inputCandidates: FinalScoredCandidate[],
  totalSlots: number,
  minPerCategory: number = 1,
  maxPerCategory: number = Math.max(1, parseInt(process.env.BUDGET_MAX_PER_CATEGORY ?? '5', 10) || 5),
  maxTokens?: number,
): BudgetAllocation {
  return spanSync(
    'inject.budget',
    () => {
      const candidates = deduplicateFamilies(inputCandidates);
      const tokenBudget = resolveTokenBudget(maxTokens);

      // Q6: Guard against zero/negative slots
      if (totalSlots <= 0) {
        return {
          candidates: [],
          allocation: {},
          dropped: candidates.map((c) => ({ id: c.id, reason: 'budget: zero slots' })),
          estimatedTokens: tokenBudget > 0 ? 0 : undefined,
        };
      }

      if (candidates.length <= totalSlots) {
        // Everything fits the slot budget. May still need token enforcement.
        const allocation: Record<string, number> = {};
        for (const c of candidates) {
          const cat = categorize(c);
          allocation[cat] = (allocation[cat] ?? 0) + 1;
        }
        const baseResult = { candidates, allocation, dropped: [] };
        return applyTokenBudget(baseResult, tokenBudget);
      }

      // Group by category
      const groups = new Map<string, FinalScoredCandidate[]>();
      for (const c of candidates) {
        const cat = categorize(c);
        const group = groups.get(cat) ?? [];
        group.push(c);
        groups.set(cat, group);
      }

      // Phase 1: guarantee minimum per category
      // Q6: Sort groups by total score descending for deterministic allocation.
      const selected: FinalScoredCandidate[] = [];
      const allocation: Record<string, number> = {};
      let remaining = totalSlots;

      const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
        const scoreA = a[1].reduce((sum, c) => sum + c.finalScore, 0);
        const scoreB = b[1].reduce((sum, c) => sum + c.finalScore, 0);
        return scoreB - scoreA;
      });

      for (const [cat, group] of sortedGroups) {
        // Sort within category by score
        group.sort((a, b) => b.finalScore - a.finalScore);

        const take = Math.min(minPerCategory, group.length, remaining);
        for (let i = 0; i < take; i++) {
          selected.push(group[i]!);
        }
        allocation[cat] = take;
        remaining -= take;
      }

      if (remaining <= 0) {
        // Log what was dropped
        const selectedIds = new Set(selected.map((c) => c.id));
        const dropped = candidates
          .filter((c) => !selectedIds.has(c.id))
          .map((c) => ({ id: c.id, reason: `budget: ${categorize(c)} at max` }));

        // STR-3: Sort output by score
        selected.sort((a, b) => b.finalScore - a.finalScore);
        log.debug({ allocation, droppedCount: dropped.length }, 'Budget compiled (min-fill only)');
        return applyTokenBudget({ candidates: selected, allocation, dropped }, tokenBudget);
      }

      // Phase 2: fill remaining slots by global score
      const selectedIds = new Set(selected.map((c) => c.id));
      const overflow = candidates.filter((c) => !selectedIds.has(c.id)).sort((a, b) => b.finalScore - a.finalScore);

      for (const c of overflow) {
        if (remaining <= 0) break;
        const cat = categorize(c);
        if ((allocation[cat] ?? 0) >= maxPerCategory) continue;

        selected.push(c);
        allocation[cat] = (allocation[cat] ?? 0) + 1;
        selectedIds.add(c.id);
        remaining--;
      }

      const dropped = candidates
        .filter((c) => !selectedIds.has(c.id))
        .map((c) => ({ id: c.id, reason: `budget: overflow, score ${c.finalScore.toFixed(3)}` }));

      // STR-3: Sort output by score so injection order matches relevance
      selected.sort((a, b) => b.finalScore - a.finalScore);
      log.debug({ allocation, droppedCount: dropped.length, totalSelected: selected.length }, 'Budget compiled');
      return applyTokenBudget({ candidates: selected, allocation, dropped }, tokenBudget);
    },
    { candidates_in: inputCandidates.length },
  );
}

/**
 * S4: enforce a cumulative token budget on an already-slot-compiled
 * allocation. Drops lowest-scored survivors until cumulative tokens fit
 * the cap. No-op when `tokenBudget <= 0` (back-compat default).
 *
 * Input invariant: `result.candidates` is already sorted by finalScore
 * desc (the callers above ensure this). We walk top-to-bottom, accumulate
 * tokens, and cut off as soon as adding the next candidate would exceed
 * the cap. Anything past the cut is moved into `dropped` with a
 * `budget: token cap` reason so the trace logs make the cause obvious.
 */
function applyTokenBudget(
  result: {
    candidates: FinalScoredCandidate[];
    allocation: Record<string, number>;
    dropped: { id: string; reason: string }[];
  },
  tokenBudget: number,
): BudgetAllocation {
  if (tokenBudget <= 0) {
    return { ...result, estimatedTokens: undefined };
  }

  let cumulative = 0;
  const kept: FinalScoredCandidate[] = [];
  const tokenDropped: { id: string; reason: string }[] = [];
  for (const c of result.candidates) {
    const t = estimateTokens(c.candidate.record.claim);
    if (cumulative + t > tokenBudget) {
      tokenDropped.push({
        id: c.id,
        reason: `budget: token cap ${tokenBudget} (claim ~${t} tok, cumulative would be ${cumulative + t})`,
      });
      continue;
    }
    cumulative += t;
    kept.push(c);
  }

  if (tokenDropped.length === 0) {
    return { ...result, estimatedTokens: cumulative };
  }

  // Rebuild allocation map from the surviving set so the breakdown stays
  // accurate after dropping.
  const allocation: Record<string, number> = {};
  for (const c of kept) {
    const cat = categorize(c);
    allocation[cat] = (allocation[cat] ?? 0) + 1;
  }
  log.debug(
    {
      tokenBudget,
      kept: kept.length,
      droppedByTokens: tokenDropped.length,
      estimatedTokens: cumulative,
    },
    'Budget: token cap enforced',
  );
  return {
    candidates: kept,
    allocation,
    dropped: [...result.dropped, ...tokenDropped],
    estimatedTokens: cumulative,
  };
}

/**
 * Categorize a candidate for budget allocation.
 * Uses subject as primary category. Hub memories get their own bucket.
 */
function categorize(c: FinalScoredCandidate): string {
  const subject = c.candidate.record.subject;
  if (subject.startsWith('hub:')) return 'hub';
  if (c.candidate.record.memoryType === 'procedural') return 'procedural';
  // T2: Normalize to lowercase to prevent case-variant duplicate buckets
  return subject.toLowerCase();
}
