/**
 * B1b: offline retrieval-quality analyzer + weight-recommendation engine.
 *
 * Reads `retrievals` + `injections` (B1a telemetry capture), joins on
 * conversation_id × time, and reports recommendations for the per-query-
 * type ScoringWeights.
 *
 * Core signal: "memory reuse." For each pair of consecutive turns in a
 * conversation, check whether the IDs the system INJECTED at turn N
 * appear in the top-K candidate list at turn N+1. A high reuse rate
 * means the budget compiler picked the right facts; a low rate means
 * either the user is asking unrelated questions OR the retrieval at
 * turn N+1 isn't surfacing the same things the model needed at turn N.
 *
 * Correlation-to-weights: for each surviving (reused) candidate at
 * turn N+1, look at its scoreBreakdown components recorded at turn N.
 * The components that consistently rank reused candidates higher than
 * non-reused candidates are the ones that "earned" the reuse, and
 * therefore deserve a small weight bump.
 *
 * This is intentionally a coarse first cut. The recommendation is
 * always advisory until B1c's auto-apply path runs it through three
 * safety gates (sample size, confidence floor, delta cap).
 */

import type Database from 'better-sqlite3-multiple-ciphers';
import type { ScoringWeights } from '../retrieval/scorer.js';

export interface RetrievalRow {
  retrieval_id: string;
  trace_id: string;
  query: string;
  query_sha: string;
  query_type: string;
  user_id: string;
  conversation_id: string | null;
  candidates_json: string;
  candidates_total: number;
  weights_json: string;
  duration_ms: number;
  created_at: string;
}

export interface InjectionRow {
  injection_id: string;
  retrieval_id: string;
  injected_ids_json: string;
  injected_count: number;
  injected_token_estimate: number | null;
  budget_dropped: number;
  created_at: string;
}

export interface CandidateSnapshot {
  id: string;
  claim_excerpt: string;
  finalScore: number;
  breakdown: Record<string, number>;
}

export type Confidence = 'low' | 'medium' | 'high';

export interface WeightRecommendation {
  queryType: string;
  sampleSize: number;
  /** When sampleSize is below threshold, suggestedDelta is empty. */
  suggestedDelta: Partial<ScoringWeights>;
  confidence: Confidence;
  /** Human-readable explanation safe for ops dashboards / logs. */
  rationale: string;
  /** Optional aggregate stats useful for the report. */
  stats?: {
    reuseRate: number;
    pairsAnalyzed: number;
    componentCorrelations: Record<string, number>;
  };
}

export interface AnalyzeOptions {
  /** Limit analysis to events within this many days. Default 7. */
  windowDays?: number;
  /**
   * Minimum sample size per query-type bucket to produce a non-empty
   * suggestedDelta. Below this, the recommendation reports the bucket
   * exists with low confidence.
   */
  minSampleSize?: number;
}

const DEFAULT_MIN_SAMPLE = 100;
const DEFAULT_WINDOW_DAYS = 7;

/** Confidence floor used when filtering recommendations for auto-apply. */
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Compute a per-query-type weight recommendation from the trace DB.
 *
 * Algorithm:
 *   1. Pull retrievals + injections in the window.
 *   2. Group by conversation_id, sort by created_at.
 *   3. For each adjacent pair (N, N+1) where N has an injection and
 *      N+1 has a retrieval, scan the retrieval's stored candidates.
 *      Each injected ID at N becomes either "reused" or "not reused"
 *      based on whether it appears in N+1's candidate list.
 *   4. For each reused/not-reused candidate, look up its scoreBreakdown
 *      from the N retrieval's stored candidates. Build per-component
 *      correlations: mean component value for reused vs. not-reused.
 *   5. Convert to a signed delta proportional to the correlation:
 *      a positive delta on a component means "the data suggests bumping
 *      this weight slightly improves reuse."
 *   6. Bucket by query_type. Sum sample sizes. Emit one
 *      WeightRecommendation per bucket.
 */
export function analyzeRetrievalQuality(db: Database.Database, opts: AnalyzeOptions = {}): WeightRecommendation[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE;
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Per-query-type accumulator.
  interface Bucket {
    reusedComponentSums: Record<string, number>;
    reusedCount: number;
    notReusedComponentSums: Record<string, number>;
    notReusedCount: number;
    pairsAnalyzed: number;
  }
  const buckets = new Map<string, Bucket>();
  const getBucket = (qt: string): Bucket => {
    let b = buckets.get(qt);
    if (!b) {
      b = {
        reusedComponentSums: {},
        reusedCount: 0,
        notReusedComponentSums: {},
        notReusedCount: 0,
        pairsAnalyzed: 0,
      };
      buckets.set(qt, b);
    }
    return b;
  };

  // Pull everything in the window.
  const retrievals = db
    .prepare(`SELECT * FROM retrievals WHERE created_at >= ? ORDER BY conversation_id, created_at`)
    .all(cutoff) as RetrievalRow[];
  const injections = db.prepare(`SELECT * FROM injections WHERE created_at >= ?`).all(cutoff) as InjectionRow[];

  // Index injections by retrieval_id for O(1) lookup.
  const injByRetrieval = new Map<string, InjectionRow>();
  for (const inj of injections) injByRetrieval.set(inj.retrieval_id, inj);

  // Group retrievals by conversation_id. Anonymous (null conversation_id)
  // rows don't form pairs, skip them.
  const byConv = new Map<string, RetrievalRow[]>();
  for (const r of retrievals) {
    if (!r.conversation_id) continue;
    const arr = byConv.get(r.conversation_id) ?? [];
    arr.push(r);
    byConv.set(r.conversation_id, arr);
  }

  // Walk each conversation's adjacent pairs.
  for (const convRetrievals of byConv.values()) {
    if (convRetrievals.length < 2) continue;
    for (let i = 0; i < convRetrievals.length - 1; i++) {
      const turnN = convRetrievals[i]!;
      const turnNext = convRetrievals[i + 1]!;
      const injectionAtN = injByRetrieval.get(turnN.retrieval_id);
      if (!injectionAtN) continue;

      let injectedIds: string[];
      let candidatesAtN: CandidateSnapshot[];
      let candidatesAtNext: CandidateSnapshot[];
      try {
        injectedIds = JSON.parse(injectionAtN.injected_ids_json) as string[];
        candidatesAtN = JSON.parse(turnN.candidates_json) as CandidateSnapshot[];
        candidatesAtNext = JSON.parse(turnNext.candidates_json) as CandidateSnapshot[];
      } catch {
        continue; // malformed row, skip
      }
      if (injectedIds.length === 0 || candidatesAtN.length === 0) continue;

      const nextIds = new Set(candidatesAtNext.map((c) => c.id));
      const candByIdAtN = new Map<string, CandidateSnapshot>();
      for (const c of candidatesAtN) candByIdAtN.set(c.id, c);

      const bucket = getBucket(turnN.query_type);
      bucket.pairsAnalyzed += 1;

      for (const injectedId of injectedIds) {
        const snap = candByIdAtN.get(injectedId);
        if (!snap) continue; // injected but not in stored top-K, skip
        const reused = nextIds.has(injectedId);
        if (reused) {
          bucket.reusedCount += 1;
          for (const [k, v] of Object.entries(snap.breakdown)) {
            bucket.reusedComponentSums[k] = (bucket.reusedComponentSums[k] ?? 0) + v;
          }
        } else {
          bucket.notReusedCount += 1;
          for (const [k, v] of Object.entries(snap.breakdown)) {
            bucket.notReusedComponentSums[k] = (bucket.notReusedComponentSums[k] ?? 0) + v;
          }
        }
      }
    }
  }

  const recommendations: WeightRecommendation[] = [];
  for (const [queryType, b] of buckets) {
    const sampleSize = b.reusedCount + b.notReusedCount;
    const reuseRate = sampleSize > 0 ? b.reusedCount / sampleSize : 0;

    // Mean component contribution among reused vs. not-reused.
    const meanReused: Record<string, number> = {};
    const meanNotReused: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.reusedComponentSums)) {
      meanReused[k] = b.reusedCount > 0 ? v / b.reusedCount : 0;
    }
    for (const [k, v] of Object.entries(b.notReusedComponentSums)) {
      meanNotReused[k] = b.notReusedCount > 0 ? v / b.notReusedCount : 0;
    }

    // Correlation proxy: signed (mean_reused - mean_not_reused). A
    // positive value means "this component scored higher among the
    // ones that ended up reused" → bump its weight slightly.
    const correlations: Record<string, number> = {};
    const componentToWeight: Record<string, keyof ScoringWeights> = {
      lexicalComponent: 'lexicalWeight',
      vectorComponent: 'vectorWeight',
      provenanceComponent: 'provenanceWeight',
      freshnessComponent: 'freshnessWeight',
    };
    for (const componentKey of Object.keys(componentToWeight)) {
      const reused = meanReused[componentKey] ?? 0;
      const notReused = meanNotReused[componentKey] ?? 0;
      correlations[componentKey] = reused - notReused;
    }

    let confidence: Confidence = 'low';
    if (sampleSize >= minSampleSize * 5) confidence = 'high';
    else if (sampleSize >= minSampleSize) confidence = 'medium';

    const suggestedDelta: Partial<ScoringWeights> = {};
    let rationale: string;
    if (sampleSize < minSampleSize) {
      rationale = `Only ${sampleSize} reused/not-reused pairs in window (min ${minSampleSize}). Need more data.`;
    } else {
      // Translate correlation into a small signed delta. Scale by 0.1
      // so a perfect-1.0 correlation maxes out at +0.1 on the weight,
      // and B1c's per-component cap (default 0.05) still applies.
      let largestAbs = 0;
      let largestKey = '';
      for (const [componentKey, weightKey] of Object.entries(componentToWeight)) {
        const corr = correlations[componentKey] ?? 0;
        if (Math.abs(corr) < 0.01) continue; // ignore noise floor
        suggestedDelta[weightKey] = Math.max(-0.1, Math.min(0.1, corr * 0.1));
        if (Math.abs(corr) > largestAbs) {
          largestAbs = Math.abs(corr);
          largestKey = componentKey;
        }
      }
      rationale =
        Object.keys(suggestedDelta).length === 0
          ? `Reuse rate ${(reuseRate * 100).toFixed(1)}% over ${sampleSize} samples; no component shows actionable correlation.`
          : `Reuse rate ${(reuseRate * 100).toFixed(1)}% over ${sampleSize} samples. Largest signal: ${largestKey} (Δ=${correlations[largestKey]!.toFixed(3)}).`;
    }

    recommendations.push({
      queryType,
      sampleSize,
      suggestedDelta,
      confidence,
      rationale,
      stats: {
        reuseRate,
        pairsAnalyzed: b.pairsAnalyzed,
        componentCorrelations: correlations,
      },
    });
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// B1c: auto-apply (flag-gated; see src/boot.ts)
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  /** Per-component cap on a single application. Default 0.05. */
  maxDeltaPerComponent?: number;
  /** Skip recommendations below this sample size. Default 500. */
  minSampleSize?: number;
  /** Skip recommendations below this confidence. Default 'medium'. */
  minConfidence?: Confidence;
}

export interface ApplyResult {
  /** The merged weights after gate-filtered application. */
  applied: ScoringWeights;
  /** Human-readable line per accepted delta (and the reason for rejected ones). */
  audit: string[];
}

/**
 * Apply weight recommendations through the safety gates. Used by the
 * boot-time auto-apply path AND by the analyzer script when
 * `--apply` is passed (for dry-runs against fixture trace DBs).
 *
 * Rules:
 *   - Deltas are clamped to ±maxDeltaPerComponent.
 *   - Recommendations with confidence < minConfidence are dropped.
 *   - Recommendations with sampleSize < minSampleSize are dropped.
 *   - Weights are merged on top of `currentConfig`; missing components
 *     fall back to `currentConfig`'s value.
 *
 * The audit array enumerates every accepted delta with old → new + the
 * confidence/sampleSize that justified it, AND every rejected one with
 * the gate reason. This is what B1c writes to the audit log.
 */
export function applyRecommendations(
  recommendations: WeightRecommendation[],
  currentConfig: ScoringWeights,
  options: ApplyOptions = {},
): ApplyResult {
  const maxDelta = options.maxDeltaPerComponent ?? 0.05;
  const minSample = options.minSampleSize ?? 500;
  const minConfidence: Confidence = options.minConfidence ?? 'medium';
  const minConfRank = CONFIDENCE_RANK[minConfidence];

  const applied: ScoringWeights = { ...currentConfig };
  const audit: string[] = [];

  for (const rec of recommendations) {
    if (rec.sampleSize < minSample) {
      audit.push(`[${rec.queryType}] SKIPPED: sample size ${rec.sampleSize} < min ${minSample}. ${rec.rationale}`);
      continue;
    }
    if (CONFIDENCE_RANK[rec.confidence] < minConfRank) {
      audit.push(`[${rec.queryType}] SKIPPED: confidence '${rec.confidence}' < min '${minConfidence}'.`);
      continue;
    }
    if (Object.keys(rec.suggestedDelta).length === 0) {
      audit.push(`[${rec.queryType}] SKIPPED: no actionable delta. ${rec.rationale}`);
      continue;
    }
    for (const [component, rawDelta] of Object.entries(rec.suggestedDelta) as Array<[keyof ScoringWeights, number]>) {
      const clamped = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));
      const oldVal = applied[component] ?? 0;
      const newVal = Math.max(0, oldVal + clamped);
      const clampNote = clamped !== rawDelta ? ` (clamped from ${rawDelta.toFixed(4)})` : '';
      audit.push(
        `[${rec.queryType}] ${String(component)} ${oldVal.toFixed(4)} → ${newVal.toFixed(4)} ` +
          `(Δ${clamped >= 0 ? '+' : ''}${clamped.toFixed(4)}${clampNote}, conf=${rec.confidence}, n=${rec.sampleSize})`,
      );
      applied[component] = newVal;
    }
  }

  return { applied, audit };
}

/**
 * B1c boot-time entry point.
 *
 * Reads `WEIGHT_TUNER_*` env vars, opens the trace DB (separately from
 * the repo's main DB, different file), runs the analyzer, applies
 * recommendations through the gates, and returns:
 *   - the merged weights to install on the running config
 *   - the audit array to log + write to the per-user audit log
 *   - whether anything actually changed (so callers can skip the audit
 *     write when no deltas applied)
 *
 * Failure modes (all return a no-op result, never throw):
 *   - WEIGHT_TUNER_AUTO_APPLY != 'true' → no-op
 *   - Trace DB missing → no-op with an audit line noting the skip
 *   - DB read errors → no-op with an audit line; original config wins
 */
export interface BootApplyResult {
  applied: ScoringWeights;
  audit: string[];
  changed: boolean;
}

export function bootApplyWeightTuner(
  currentConfig: ScoringWeights,
  traceDbPath: string,
  openDb: (path: string) => Database.Database,
): BootApplyResult {
  if (process.env.WEIGHT_TUNER_AUTO_APPLY !== 'true') {
    return { applied: currentConfig, audit: [], changed: false };
  }
  const windowDays = parseInt(process.env.WEIGHT_TUNER_WINDOW_DAYS ?? '7', 10);
  const minSampleSize = parseInt(process.env.WEIGHT_TUNER_MIN_SAMPLES ?? '500', 10);
  const maxDeltaPerComponent = parseFloat(process.env.WEIGHT_TUNER_MAX_DELTA ?? '0.05');
  const minConfidenceRaw = (process.env.WEIGHT_TUNER_MIN_CONFIDENCE ?? 'medium').toLowerCase();
  const minConfidence: Confidence =
    minConfidenceRaw === 'low' || minConfidenceRaw === 'high' ? (minConfidenceRaw as Confidence) : 'medium';

  let db: Database.Database;
  try {
    db = openDb(traceDbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      applied: currentConfig,
      audit: [`WEIGHT_TUNER_AUTO_APPLY=true but trace DB open failed (${traceDbPath}): ${msg}. No-op.`],
      changed: false,
    };
  }
  try {
    const recs = analyzeRetrievalQuality(db, { windowDays, minSampleSize: Math.min(minSampleSize, 100) });
    const { applied, audit } = applyRecommendations(recs, currentConfig, {
      maxDeltaPerComponent,
      minSampleSize,
      minConfidence,
    });
    const changed = audit.some((line) => !line.startsWith('[') || line.includes(' → '));
    // We detect change by inspecting actual weight diff (audit lines that
    // include " → " correspond to applied deltas; SKIPPED lines don't).
    const reallyChanged = Object.keys(applied).some(
      (k) => applied[k as keyof ScoringWeights] !== currentConfig[k as keyof ScoringWeights],
    );
    return { applied, audit, changed: reallyChanged || changed };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}
