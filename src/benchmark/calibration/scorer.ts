/**
 * Calibration scoring helpers.
 *
 * - expectedCalibrationError: weighted gap between predicted confidence and
 *   empirical accuracy across confidence buckets. Lower is better.
 *     ECE = sum_b (|B_b| / N) * |acc(B_b) - conf(B_b)|
 *
 * - brierScore: mean squared error between confidence and outcome.
 *     Brier = mean((confidence - 1)^2) for correct preds + mean(confidence^2)
 *     for incorrect, equivalently mean((conf - y)^2) where y in {0,1}.
 *
 * - reliabilityDiagram: per-bucket counts + mean-conf + accuracy. Plottable.
 *
 * - precisionRecallAtK / auprc: held-out recall metrics for D8.
 *
 * - calibrationBand: excellent (<0.05) / acceptable (<0.10) / miscalibrated.
 */

import type { ReliabilityBucket } from './types.js';

export interface ConfidenceOutcome {
  confidence: number;
  correct: boolean;
}

export function reliabilityDiagram(results: ReadonlyArray<ConfidenceOutcome>, numBuckets = 10): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = [];
  const width = 1 / numBuckets;
  for (let i = 0; i < numBuckets; i++) {
    const lo = i * width;
    const hi = i === numBuckets - 1 ? 1.000001 : (i + 1) * width;
    buckets.push({ lo, hi: i === numBuckets - 1 ? 1.0 : hi, count: 0, meanConfidence: 0, accuracy: 0 });
  }
  for (const r of results) {
    const c = Math.max(0, Math.min(1, r.confidence));
    const idx = Math.min(numBuckets - 1, Math.floor(c / width));
    const b = buckets[idx]!;
    b.count++;
    b.meanConfidence += c;
    if (r.correct) b.accuracy += 1;
  }
  for (const b of buckets) {
    if (b.count > 0) {
      b.meanConfidence = b.meanConfidence / b.count;
      b.accuracy = b.accuracy / b.count;
    }
  }
  return buckets;
}

export function expectedCalibrationError(
  results: ReadonlyArray<ConfidenceOutcome>,
  numBuckets = 10,
): { ece: number; buckets: ReliabilityBucket[] } {
  const buckets = reliabilityDiagram(results, numBuckets);
  const N = results.length;
  if (N === 0) return { ece: 0, buckets };
  let ece = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    ece += (b.count / N) * Math.abs(b.accuracy - b.meanConfidence);
  }
  return { ece, buckets };
}

export function brierScore(results: ReadonlyArray<ConfidenceOutcome>): number {
  if (results.length === 0) return 0;
  let sum = 0;
  for (const r of results) {
    const y = r.correct ? 1 : 0;
    const d = r.confidence - y;
    sum += d * d;
  }
  return sum / results.length;
}

export function calibrationBand(ece: number): 'excellent' | 'acceptable' | 'miscalibrated' {
  if (ece < 0.05) return 'excellent';
  if (ece < 0.1) return 'acceptable';
  return 'miscalibrated';
}

// ----- Recall@K -----

export interface RankedItem {
  id: string;
  /** Optional rank score. Not used by precision/recall, but kept for the report. */
  rankedScore?: number;
}

export function precisionRecallAtK(
  retrieved: ReadonlyArray<RankedItem>,
  groundTruthRelevant: ReadonlySet<string>,
  k: number,
): { precision: number; recall: number; f1: number; truePositives: number } {
  const top = retrieved.slice(0, k);
  let tp = 0;
  for (const r of top) if (groundTruthRelevant.has(r.id)) tp++;
  const fpfn = top.length;
  const precision = fpfn === 0 ? 0 : tp / fpfn;
  const recall = groundTruthRelevant.size === 0 ? 0 : tp / groundTruthRelevant.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, truePositives: tp };
}

/**
 * Area under the Precision-Recall curve, swept over K = 1..N. Trapezoidal
 * integration on the (recall, precision) sequence after deduping repeated
 * recall values (keep max precision). Equivalent to average-precision when
 * all relevants appear in `retrieved`.
 */
export function aupr(retrieved: ReadonlyArray<RankedItem>, groundTruthRelevant: ReadonlySet<string>): number {
  if (groundTruthRelevant.size === 0 || retrieved.length === 0) return 0;
  const points: Array<{ recall: number; precision: number }> = [{ recall: 0, precision: 1 }];
  for (let k = 1; k <= retrieved.length; k++) {
    const { precision, recall } = precisionRecallAtK(retrieved, groundTruthRelevant, k);
    points.push({ recall, precision });
  }
  // Trapezoidal area
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.recall - points[i - 1]!.recall;
    const avg = (points[i]!.precision + points[i - 1]!.precision) / 2;
    area += dx * avg;
  }
  return area;
}
