import type { ScoredCandidate } from '../schema/memory.js';
import { TrustClass, PermanenceStatus, PROVENANCE_SCORES } from '../schema/memory.js';
import type { Provenance } from '../schema/memory.js';

/**
 * Hybrid scorer. Deterministic. No LLM calls. No randomness.
 * Same inputs always produce same outputs (unlike Thompson).
 *
 * Formula:
 *   finalScore =
 *     (lexicalScore * lexicalWeight) +
 *     (vectorScore * vectorWeight) +
 *     (provenanceScore * provenanceWeight) +
 *     (freshnessScore * freshnessWeight) +
 *     (confirmedBonus if trust_class === 'confirmed') -
 *     (contradictionPenalty if conflicts_with.length > 0)
 *
 * All weights come from config. Defaults tuned during benchmark phase.
 */

export interface ScoringWeights {
  lexicalWeight: number;
  vectorWeight: number;
  provenanceWeight: number;
  freshnessWeight: number;
  confirmedBonus: number;
  contradictionPenaltyBase: number;
  contradictionPenaltyMax: number;
  freshnessHalfLifeDays: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  lexicalWeight: 0.3,
  vectorWeight: 0.4,
  provenanceWeight: 0.15,
  freshnessWeight: 0.1,
  confirmedBonus: 0.15,
  contradictionPenaltyBase: 0.1,
  contradictionPenaltyMax: 0.3,
  freshnessHalfLifeDays: 30,
};

export interface FinalScoredCandidate {
  id: string;
  candidate: ScoredCandidate;
  finalScore: number;
  scoreBreakdown: {
    lexicalComponent: number;
    vectorComponent: number;
    provenanceComponent: number;
    freshnessComponent: number;
    confirmedBonus: number;
    contradictionPenalty: number;
  };
}

// --- Freshness ---

/**
 * Exponential decay freshness score.
 * Returns 1.0 for now, 0.5 at half-life, 0.25 at 2x half-life, etc.
 *
 * @param updatedAt ISO datetime string of the memory's last update
 * @param now Reference time (defaults to current time)
 * @param halfLifeDays Decay half-life in days
 */
export function computeFreshness(updatedAt: string, halfLifeDays: number, now?: Date): number {
  const reference = now || new Date();
  const updated = new Date(updatedAt);

  // Guard against invalid dates (NaN poisons sort)
  if (isNaN(updated.getTime())) return 0;

  const ageMs = reference.getTime() - updated.getTime();

  if (ageMs <= 0) return 1.0; // Future or same time = max freshness

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const lambda = Math.LN2 / halfLifeDays;

  return Math.exp(-lambda * ageDays);
}

// --- Provenance ---

/**
 * Get the provenance score for a memory.
 * Maps from the PROVENANCE_SCORES lookup table.
 */
export function computeProvenanceScore(provenance: Provenance): number {
  return PROVENANCE_SCORES[provenance] ?? 0;
}

// --- Merge ---

/**
 * Merge candidates from lexical and vector searches.
 * Duplicates (same memory ID) combine: take max of each score, source = 'both'.
 */
export function mergeCandidates(
  lexicalCandidates: ScoredCandidate[],
  vectorCandidates: ScoredCandidate[],
): ScoredCandidate[] {
  const merged = new Map<string, ScoredCandidate>();

  for (const c of lexicalCandidates) {
    merged.set(c.id, { ...c });
  }

  for (const c of vectorCandidates) {
    const existing = merged.get(c.id);
    if (existing) {
      // Pick the record with the newer updatedAt to avoid stale metadata
      const existingTime = new Date(existing.record.updatedAt).getTime() || 0;
      const incomingTime = new Date(c.record.updatedAt).getTime() || 0;
      if (incomingTime > existingTime) {
        existing.record = c.record;
      }
      existing.lexicalScore = Math.max(existing.lexicalScore, c.lexicalScore);
      existing.vectorScore = Math.max(existing.vectorScore, c.vectorScore);
      existing.source = 'both';
    } else {
      merged.set(c.id, { ...c });
    }
  }

  return Array.from(merged.values());
}

// --- Filter ---

/**
 * Filter candidates to only injectable trust classes.
 * Only confirmed and auto-approved memories are eligible for injection.
 * Quarantined and rejected are excluded.
 */
const INJECTABLE_TRUST_CLASSES = new Set<string>([TrustClass.CONFIRMED, TrustClass.AUTO_APPROVED]);

/**
 * Filter candidates to injectable trust classes.
 * Also excludes cold/archived memories (interference-based forgetting)
 * and inhibitory memories (they suppress, not inject).
 */
export function filterInjectable(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return candidates.filter((c) => {
    if (!INJECTABLE_TRUST_CLASSES.has(c.record.trustClass)) return false;
    // Interference: cold/archived memories are excluded from retrieval
    if (c.record.interferenceStatus !== 'active') return false;
    // Inhibitory memories are suppressors, not directly injected
    if (c.record.isInhibitory) return false;
    return true;
  });
}

/**
 * Apply inhibitory suppression: for each inhibitory memory targeting a subject,
 * penalize or remove candidates matching that subject.
 * Returns candidates with inhibited ones removed.
 */
export function applyInhibition(
  candidates: ScoredCandidate[],
  inhibitions: { inhibitionTarget: string; confidence: number }[],
): ScoredCandidate[] {
  if (inhibitions.length === 0) return candidates;

  const suppressedSubjects = new Map<string, number>();
  for (const inh of inhibitions) {
    if (inh.inhibitionTarget) {
      const existing = suppressedSubjects.get(inh.inhibitionTarget.toLowerCase()) ?? 0;
      suppressedSubjects.set(inh.inhibitionTarget.toLowerCase(), Math.max(existing, inh.confidence));
    }
  }

  return candidates.filter((c) => {
    const subject = c.record.subject.toLowerCase();
    const suppressionStrength = suppressedSubjects.get(subject);
    // If inhibition confidence >= memory confidence, suppress it
    if (suppressionStrength !== undefined && suppressionStrength >= c.record.confidence) {
      return false;
    }
    return true;
  });
}

// --- Score ---

/**
 * Score a single candidate using the hybrid formula.
 */
export function scoreCandidate(candidate: ScoredCandidate, weights: ScoringWeights, now?: Date): FinalScoredCandidate {
  const lexicalComponent = candidate.lexicalScore * weights.lexicalWeight;
  const vectorComponent = candidate.vectorScore * weights.vectorWeight;

  const provenanceComponent = computeProvenanceScore(candidate.record.provenance) * weights.provenanceWeight;

  // Permanent memories get max freshness (they've earned their spot)
  // Frozen memories also skip decay (user explicitly preserved them)
  const freshnessComponent =
    candidate.record.permanenceStatus === PermanenceStatus.PERMANENT || candidate.record.isFrozen
      ? weights.freshnessWeight
      : computeFreshness(candidate.record.updatedAt, weights.freshnessHalfLifeDays, now) * weights.freshnessWeight;

  const confirmedBonus = candidate.record.trustClass === TrustClass.CONFIRMED ? weights.confirmedBonus : 0;

  // T1: Don't penalize confirmed memories for historical conflicts they've already won.
  // Confirmed status means consensus/user already resolved the conflict.
  const conflictCount =
    candidate.record.trustClass === TrustClass.CONFIRMED
      ? 0 // Confirmed memories have already won their conflicts
      : candidate.record.conflictsWith.length;
  const contradictionPenalty =
    conflictCount > 0 ? Math.min(conflictCount * weights.contradictionPenaltyBase, weights.contradictionPenaltyMax) : 0;

  const finalScore =
    lexicalComponent +
    vectorComponent +
    provenanceComponent +
    freshnessComponent +
    confirmedBonus -
    contradictionPenalty;

  return {
    id: candidate.id,
    candidate,
    finalScore,
    scoreBreakdown: {
      lexicalComponent,
      vectorComponent,
      provenanceComponent,
      freshnessComponent,
      confirmedBonus,
      contradictionPenalty,
    },
  };
}

// --- Rank ---

/**
 * Score, sort, and return top-N candidates.
 * Tie-breaking: higher confidence first, then newer (createdAt descending).
 */
export function rankCandidates(
  candidates: ScoredCandidate[],
  weights: ScoringWeights,
  limit: number,
  now?: Date,
): FinalScoredCandidate[] {
  // T5: Instantiate once instead of new Date() per candidate in computeFreshness
  const referenceTime = now ?? new Date();
  const scored = candidates.map((c) => scoreCandidate(c, weights, referenceTime));

  scored.sort((a, b) => {
    // Primary: higher score first
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    // Tie-break 1: higher confidence
    if (b.candidate.record.confidence !== a.candidate.record.confidence)
      return b.candidate.record.confidence - a.candidate.record.confidence;
    // Tie-break 2: most recently updated (recency of state, not creation)
    const aUpdated = new Date(a.candidate.record.updatedAt).getTime() || 0;
    const bUpdated = new Date(b.candidate.record.updatedAt).getTime() || 0;
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    // Tie-break 3: newer creation (stable)
    const aCreated = new Date(a.candidate.record.createdAt).getTime() || 0;
    const bCreated = new Date(b.candidate.record.createdAt).getTime() || 0;
    if (bCreated !== aCreated) return bCreated - aCreated;
    // Tie-break 4: deterministic by ID
    return a.id.localeCompare(b.id);
  });

  return scored.slice(0, limit);
}

// --- Adaptive Weights ---

/**
 * Adaptive weight redistribution.
 * When non-semantic signals (lexical, provenance, freshness) have near-zero
 * variance across candidates (all score the same), their weight is noise.
 * Redistribute uniform signal weights to the vector component.
 *
 * In production (varied provenance/freshness): weights stay as configured.
 * In benchmark seeding (all same provenance/freshness): auto-amplifies semantic signal.
 */
const MIN_CANDIDATES_FOR_ADAPT = 5;
const VARIANCE_THRESHOLD = 0.001;
const LEXICAL_FLOOR = 0.1; // TAC-4: Keep minimum lexical weight for exact name matches

export function adaptWeights(candidates: ScoredCandidate[], weights: ScoringWeights): ScoringWeights {
  // Q4b: Need 5+ candidates for variance to be statistically meaningful
  if (candidates.length < MIN_CANDIDATES_FOR_ADAPT) return weights;

  // Compute raw scores per dimension
  const lexScores = candidates.map((c) => c.lexicalScore);
  const provScores = candidates.map((c) => computeProvenanceScore(c.record.provenance));
  const freshScores = candidates.map((c) =>
    c.record.permanenceStatus === PermanenceStatus.PERMANENT || c.record.isFrozen
      ? 1.0
      : computeFreshness(c.record.updatedAt, weights.freshnessHalfLifeDays),
  );

  const variance = (arr: number[]): number => {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  };

  const adapted = { ...weights };
  let redistributed = 0;

  const dims: { key: keyof ScoringWeights; scores: number[] }[] = [
    { key: 'lexicalWeight', scores: lexScores },
    { key: 'provenanceWeight', scores: provScores },
    { key: 'freshnessWeight', scores: freshScores },
  ];

  for (const dim of dims) {
    if (variance(dim.scores) < VARIANCE_THRESHOLD) {
      const weight = adapted[dim.key] as number;
      // TAC-4: Keep lexical floor so exact keyword matches still carry signal
      if (dim.key === 'lexicalWeight' && weight > LEXICAL_FLOOR) {
        redistributed += weight - LEXICAL_FLOOR;
        (adapted as any)[dim.key] = LEXICAL_FLOOR;
      } else if (dim.key !== 'lexicalWeight') {
        redistributed += weight;
        (adapted as any)[dim.key] = 0;
      }
    }
  }

  adapted.vectorWeight += redistributed;
  return adapted;
}
