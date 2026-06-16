/**
 * Product scorecard, variance establishment (S78, spec §13).
 *
 * "Within variance" is not allowed as an assertion. Every variance claim here
 * is a measured number from the committed archive, or it is explicitly marked
 * "sigma unknown" and the cell is gate-disabled. Before any metric movement is
 * called noise OR regression, its noise floor is established here.
 *
 * What this module computes from the archive (spec §13.2-§13.5):
 *  - per (bench, config-fingerprint, Q-tier) group with n>=3 same-config runs:
 *    overall mean+sigma and per-cell mean+sigma for every native-category and
 *    every unified query_type cell;
 *  - the "needs repeats" list: every group with n<3 (sigma unknown);
 *  - per-cell time series keyed by run timestamp, with a drift slope.
 *
 * What it CANNOT compute (requires the host harness, spec §13.1): judge-only
 * sigma (re-judge N>=5 with the cache off) and engine-only sigma (re-run N>=3
 * against a frozen judge). The archive has one verdict per output, so those
 * decompositions live in scripts/scorecard/host/.
 *
 * Statistic: sample standard deviation (Bessel's correction, divide by n-1) -
 * the defensible estimator of the underlying noise sigma from a small number of
 * repeats. This is a documented reporting decision (spec §8), not tuned.
 */

import type {
  BenchId,
  CellSigma,
  CellTimeseries,
  FingerprintVariance,
  NeedsRepeats,
  NormalizedRecord,
  TimeseriesPoint,
  VarianceReport,
} from './types.js';
import { classifierHash } from './taxonomy.js';

export const MIN_RUNS_FOR_SIGMA = 3;
export const MIN_RUNS_FOR_JUDGE_SIGMA = 5;
/** A cell with fewer than this many questions per run is too small to gate: a
 *  one-question flip dominates it and the measured sigma underestimates the true
 *  binomial spread (spec §13.2 "small cells carry large sigma"). */
export const MIN_CELL_QUESTIONS = 5;

/** Theoretical minimum (binomial) sigma for a cell of `q` questions at rate `p`.
 *  Used as a floor so a luckily-tight set of repeats can't produce a sigma so
 *  small that normal sampling noise trips the gate. */
export function binomialSigma(p: number, q: number): number {
  if (q <= 0) return 0;
  return Math.sqrt(Math.max(p * (1 - p), 0) / q);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation (ddof=1). Returns 0 for n<2 (undefined spread). */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Accuracy of a record slice: answered-and-correct / n. */
function accuracy(records: NormalizedRecord[]): number {
  if (records.length === 0) return 0;
  let ok = 0;
  for (const r of records) if (!r.abstained && r.correct) ok++;
  return ok / records.length;
}

/**
 * Least-squares slope of values against their index, plus the Pearson r. Slope
 * is in accuracy-units per run-step; for "pp per step" multiply by 100.
 */
export function driftSlope(values: number[]): { slope: number; r: number; n: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, r: 0, n };
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = values[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const denom = Math.sqrt(sxx * syy);
  const r = denom === 0 ? 0 : sxy / denom;
  return { slope, r, n };
}

/** The cell partitions for a single bench's records: every native_category
 *  (prefixed `cat:`) and every unified query_type (prefixed `qt:`). The CloneMem
 *  counterfactual cell surfaces as `cat:counterfactual`. */
function cellKeys(record: NormalizedRecord): string[] {
  const keys: string[] = [`qt:${record.query_type_unified}`];
  if (record.native_category) keys.push(`cat:${record.native_category}`);
  return keys;
}

/** Group an array by a derived string key. */
function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function computeCellSigmas(runs: NormalizedRecord[][]): CellSigma[] {
  // Collect every cell key seen across runs.
  const allCells = new Set<string>();
  for (const run of runs) for (const r of run) for (const k of cellKeys(r)) allCells.add(k);

  const out: CellSigma[] = [];
  for (const cell of [...allCells].sort()) {
    const perRunAcc: number[] = [];
    const perRunN: number[] = [];
    for (const run of runs) {
      const inCell = run.filter((r) => cellKeys(r).includes(cell));
      if (inCell.length === 0) continue; // run lacks this cell
      perRunAcc.push(accuracy(inCell));
      perRunN.push(inCell.length);
    }
    // Gate the cell only when EVERY run carried it, we have enough runs, AND
    // the cell is large enough that a one-question flip doesn't dominate it.
    const qPerRun = mean(perRunN);
    const gated =
      perRunAcc.length >= MIN_RUNS_FOR_SIGMA && perRunAcc.length === runs.length && qPerRun >= MIN_CELL_QUESTIONS;
    // Report the EMPIRICAL measured sigma (what the repeats actually showed). The
    // binomial-SE floor is applied at gate time, not here, so the report stays an
    // honest record of the observation.
    out.push({
      cell,
      mean: mean(perRunAcc),
      sigma: stdev(perRunAcc),
      n: perRunAcc.length,
      questions_per_run: qPerRun,
      gated,
    });
  }
  return out;
}

export interface ComputeVarianceOptions {
  minRunsForSigma?: number;
}

/**
 * Compute the full variance report from classified, abstention-resolved
 * records. Records must already carry their `fingerprint` (set by the pipeline).
 */
export function computeVariance(records: NormalizedRecord[], opts: ComputeVarianceOptions = {}): VarianceReport {
  const minRuns = opts.minRunsForSigma ?? MIN_RUNS_FOR_SIGMA;

  // ---- per-fingerprint sigma ----
  const byFingerprint = groupBy(records, (r) => r.fingerprint);
  const groups: FingerprintVariance[] = [];
  const needsRepeats: NeedsRepeats[] = [];

  for (const [fp, recs] of byFingerprint) {
    if (recs.length === 0) continue;
    const first = recs[0]!;
    // A "run" within a fingerprint is one source file.
    const byRun = groupBy(recs, (r) => r.source_file);
    const runs = [...byRun.values()];
    const nRuns = runs.length;

    const runRefs = [...byRun.entries()]
      .map(([file, rs]) => ({
        commit: rs[0]!.commit,
        timestamp: rs[0]!.run_timestamp,
        n: rs.length,
        accuracy: accuracy(rs),
        file,
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (nRuns < minRuns) {
      needsRepeats.push({
        bench: first.bench,
        fingerprint: fp,
        qtier: first.qtier,
        n_have: nRuns,
        n_needed: minRuns,
        reason: `sigma unknown: only ${nRuns} same-config run(s); need >=${minRuns} repeats on the host to measure the noise floor`,
      });
      continue;
    }

    const perRunOverall = runs.map((run) => accuracy(run));
    groups.push({
      bench: first.bench,
      fingerprint: fp,
      qtier: first.qtier,
      n_runs: nRuns,
      mean_overall: mean(perRunOverall),
      sigma_overall: stdev(perRunOverall),
      questions_per_run: mean(runs.map((run) => run.length)),
      gated_overall: nRuns >= minRuns,
      per_cell: computeCellSigmas(runs),
      run_refs: runRefs.map(({ commit, timestamp, n, accuracy }) => ({ commit, timestamp, n, accuracy })),
    });
  }

  groups.sort((a, b) => (a.bench === b.bench ? a.qtier.localeCompare(b.qtier) : a.bench.localeCompare(b.bench)));
  needsRepeats.sort((a, b) => (a.bench === b.bench ? a.qtier.localeCompare(b.qtier) : a.bench.localeCompare(b.bench)));

  // ---- time series (across all fingerprints, by run) ----
  const timeseries = buildTimeseries(records);

  return {
    generated_at: new Date().toISOString(),
    classifier_hash: classifierHash(),
    min_runs_for_sigma: minRuns,
    min_runs_for_judge_sigma: MIN_RUNS_FOR_JUDGE_SIGMA,
    groups,
    needs_repeats: needsRepeats,
    timeseries,
  };
}

/**
 * Per-(bench, cell) accuracy over time, keyed by run timestamp. One point per
 * source file. Includes a bench-overall series (cell = `__overall__`) plus a
 * series for every native-category cell. Drift slope is fit over the series so
 * a slow downward bleed surfaces even when each step is inside noise (§14.4).
 */
function buildTimeseries(records: NormalizedRecord[]): CellTimeseries[] {
  const out: CellTimeseries[] = [];

  // Group records by (bench, cell). cell = '__overall__' | cat:<native_category>.
  const series = new Map<string, Map<string, NormalizedRecord[]>>(); // bench|cell -> file -> recs
  const benches = new Set<BenchId>();
  for (const r of records) {
    benches.add(r.bench);
    const cells = ['__overall__', ...(r.native_category ? [`cat:${r.native_category}`] : [])];
    for (const cell of cells) {
      const key = `${r.bench} ${cell}`;
      let byFile = series.get(key);
      if (!byFile) {
        byFile = new Map();
        series.set(key, byFile);
      }
      const arr = byFile.get(r.source_file);
      if (arr) arr.push(r);
      else byFile.set(r.source_file, [r]);
    }
  }

  for (const [key, byFile] of series) {
    const [bench, cell] = key.split(' ') as [BenchId, string];
    const points: TimeseriesPoint[] = [...byFile.values()]
      .map((recs) => ({
        timestamp: recs[0]!.run_timestamp,
        commit: recs[0]!.commit,
        fingerprint: recs[0]!.fingerprint,
        n: recs.length,
        accuracy: accuracy(recs),
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const { slope, r, n } = driftSlope(points.map((p) => p.accuracy));
    out.push({
      bench,
      cell,
      points,
      slope: n >= 2 ? slope : null,
      slope_significant: n >= 4 && Math.abs(r) >= 0.6,
    });
  }

  out.sort((a, b) => (a.bench === b.bench ? a.cell.localeCompare(b.cell) : a.bench.localeCompare(b.bench)));
  return out;
}
