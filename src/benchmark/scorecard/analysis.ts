/**
 * Product scorecard, cell regression analysis (S78, spec §13.2).
 *
 * The "anti-hand-wave" verdict engine. For a given (bench, cell) it gathers the
 * per-run accuracy across the whole archive, measures the same-config noise
 * floor (sigma from fingerprint groups with n>=3 runs), and delivers a verdict
 * on whether a claimed move is real or noise, or, honestly, "sigma unknown"
 * when no config has enough repeats.
 *
 * Its mandatory first use (spec §13.2) is the CloneMem counterfactual cell,
 * which the roadmap calls a ~19pp regression (95→76). The verdict must be a
 * measured number, never an assertion either way.
 */

import type { BenchId, NormalizedRecord } from './types.js';
import { MIN_RUNS_FOR_SIGMA } from './variance.js';

export interface CellRunPoint {
  file: string;
  commit: string;
  timestamp: string;
  fingerprint: string;
  host: string;
  n: number;
  correct: number;
  accuracy: number;
}

export interface SameConfigGroup {
  fingerprint: string;
  n_runs: number;
  mean: number;
  sigma: number;
  gated: boolean;
  accuracies: number[];
}

export interface CellAnalysis {
  bench: BenchId;
  cell: string;
  points: CellRunPoint[];
  same_config_groups: SameConfigGroup[];
  /** the gated group (n>=min) with the most runs, if any. */
  best_gated_group: SameConfigGroup | null;
  peak: CellRunPoint | null;
  trough: CellRunPoint | null;
  /** claimed move = peak.accuracy - trough.accuracy across all runs. */
  claimed_move_pp: number | null;
  verdict: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** Does a record belong to this cell? cell is `cat:<x>` or `qt:<x>`. */
function inCell(r: NormalizedRecord, cell: string): boolean {
  if (cell.startsWith('cat:')) return r.native_category === cell.slice(4);
  if (cell.startsWith('qt:')) return r.query_type_unified === cell.slice(3);
  return false;
}

/**
 * Analyze one cell across the archive. `K` is the sigma multiple used to phrase
 * the verdict (default 2 for a per-cell "inside/outside 2σ" read).
 */
export function analyzeCell(records: NormalizedRecord[], bench: BenchId, cell: string, K = 2): CellAnalysis {
  const cellRecs = records.filter((r) => r.bench === bench && inCell(r, cell));

  // per run (source file)
  const byFile = new Map<string, NormalizedRecord[]>();
  for (const r of cellRecs) {
    const arr = byFile.get(r.source_file);
    if (arr) arr.push(r);
    else byFile.set(r.source_file, [r]);
  }
  const points: CellRunPoint[] = [...byFile.values()]
    .map((rs) => {
      const correct = rs.filter((x) => !x.abstained && x.correct).length;
      return {
        file: rs[0]!.source_file,
        commit: rs[0]!.commit,
        timestamp: rs[0]!.run_timestamp,
        fingerprint: rs[0]!.fingerprint,
        host: rs[0]!.host,
        n: rs.length,
        correct,
        accuracy: rs.length ? correct / rs.length : 0,
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // same-config groups
  const byFp = new Map<string, CellRunPoint[]>();
  for (const p of points) {
    const arr = byFp.get(p.fingerprint);
    if (arr) arr.push(p);
    else byFp.set(p.fingerprint, [p]);
  }
  const sameConfigGroups: SameConfigGroup[] = [...byFp.entries()]
    .map(([fp, ps]) => {
      const accs = ps.map((p) => p.accuracy);
      return {
        fingerprint: fp,
        n_runs: ps.length,
        mean: mean(accs),
        sigma: stdev(accs),
        gated: ps.length >= MIN_RUNS_FOR_SIGMA,
        accuracies: accs,
      };
    })
    .sort((a, b) => b.n_runs - a.n_runs);

  const gated = sameConfigGroups.filter((g) => g.gated);
  const bestGated = gated.length ? gated[0]! : null;

  const peak = points.length ? points.reduce((a, b) => (b.accuracy > a.accuracy ? b : a)) : null;
  const trough = points.length ? points.reduce((a, b) => (b.accuracy < a.accuracy ? b : a)) : null;
  const claimedMove = peak && trough ? (peak.accuracy - trough.accuracy) * 100 : null;

  const verdict = buildVerdict({ bench, cell, points, bestGated, peak, trough, claimedMove, K });

  return {
    bench,
    cell,
    points,
    same_config_groups: sameConfigGroups,
    best_gated_group: bestGated,
    peak,
    trough,
    claimed_move_pp: claimedMove,
    verdict,
  };
}

/**
 * Scan every (bench, native-category) cell in the archive and return its
 * regression analysis, so any cell anyone has called a regression gets a
 * measured real-or-noise verdict, not just the CloneMem counterfactual. Sorted
 * by the size of the archive swing (largest first). A cell with no gated
 * same-config group returns a "sigma unknown" verdict (not hand-waved).
 */
export function scanRegressions(records: NormalizedRecord[], K = 2): CellAnalysis[] {
  const cells = new Set<string>();
  for (const r of records) if (r.native_category) cells.add(`${r.bench}::cat:${r.native_category}`);
  const analyses = [...cells].map((key) => {
    const [bench, cell] = key.split('::') as [BenchId, string];
    return analyzeCell(records, bench, cell, K);
  });
  return analyses
    .filter((a) => a.points.length > 1) // only cells that actually vary across runs
    .sort((a, b) => (b.claimed_move_pp ?? 0) - (a.claimed_move_pp ?? 0));
}

/** When a measured sigma exceeds this, the noise floor is too high to adjudicate
 *  a move at all, the bench/cell is unstable and the honest verdict is "can't
 *  tell", not "all clear". */
export const HIGH_NOISE_SIGMA = 0.15;

export type VerdictClass = 'noise' | 'residual' | 'sigma-unknown' | 'flat' | 'high-noise';

/**
 * Compact verdict classification. Adjudicates the RECENT (latest-run) value
 * against the measured same-config band, a regression is about where the
 * metric is now, not a historical trough that may belong to a different/broken
 * config. The cross-archive swing is still reported as context.
 */
export function verdictClass(a: CellAnalysis, K = 2): VerdictClass {
  if (!a.best_gated_group) return 'sigma-unknown';
  if ((a.claimed_move_pp ?? 0) < 1) return 'flat';
  const g = a.best_gated_group;
  if (g.sigma > HIGH_NOISE_SIGMA) return 'high-noise';
  const recent = a.points.length ? a.points[a.points.length - 1]! : null;
  const recentWithinBand = recent !== null && recent.accuracy >= g.mean - K * g.sigma;
  return recentWithinBand ? 'noise' : 'residual';
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function buildVerdict(a: {
  bench: BenchId;
  cell: string;
  points: CellRunPoint[];
  bestGated: SameConfigGroup | null;
  peak: CellRunPoint | null;
  trough: CellRunPoint | null;
  claimedMove: number | null;
  K: number;
}): string {
  if (a.points.length === 0) return `no runs carry the ${a.cell} cell on ${a.bench}.`;
  if (!a.bestGated) {
    return (
      `SIGMA UNKNOWN. No ${a.bench} config has >=${MIN_RUNS_FOR_SIGMA} same-config runs for the ${a.cell} cell, so its ` +
      `noise floor is unmeasurable from the archive. The observed spread ` +
      `[${a.trough ? pct(a.trough.accuracy) : '?'}..${a.peak ? pct(a.peak.accuracy) : '?'}] across ` +
      `${a.points.length} run(s)/commits CANNOT be called noise OR regression until >=${MIN_RUNS_FOR_SIGMA} repeats ` +
      `are run at a frozen config (see needs-repeats). Not hand-waved either way.`
    );
  }

  const g = a.bestGated;
  const sigmaPp = g.sigma * 100;
  const band = g.accuracies.length ? `[${pct(Math.min(...g.accuracies))}..${pct(Math.max(...g.accuracies))}]` : 'n/a';
  const recent = a.points.length ? a.points[a.points.length - 1]! : null;
  const peakUnreplicated = a.peak && a.peak.fingerprint !== g.fingerprint;
  const recentWithinBand = recent !== null && recent.accuracy >= g.mean - a.K * g.sigma;
  const highNoise = g.sigma > HIGH_NOISE_SIGMA;

  const parts: string[] = [];
  parts.push(
    `MEASURED. Same-config noise floor: sigma = ${sigmaPp.toFixed(1)}pp ` +
      `(n=${g.n_runs} runs at one frozen config, mean ${pct(g.mean)}). On that config alone the cell spans ${band}.`,
  );
  if (a.claimedMove !== null && a.peak && a.trough) {
    parts.push(
      `The full archive swing is ${a.claimedMove.toFixed(1)}pp (peak ${pct(a.peak.accuracy)} @ ${a.peak.commit.slice(
        0,
        7,
      )} → trough ${pct(a.trough.accuracy)} @ ${a.trough.commit.slice(0, 7)}).`,
    );
  }
  if (highNoise) {
    parts.push(
      `Verdict: NOISE FLOOR TOO HIGH. The measured same-config sigma (${sigmaPp.toFixed(
        1,
      )}pp) is so large that NO move in this cell can be distinguished from same-config noise, this signals run instability for this (bench, config), which is itself the finding. Stabilize the runs before any regression call here.`,
    );
    return parts.join(' ');
  }
  if (peakUnreplicated && a.peak) {
    parts.push(
      `The peak ${pct(a.peak.accuracy)} is UNREPLICATED (its config has fewer than ${MIN_RUNS_FOR_SIGMA} repeats), it may be a favorable noise draw, not a true ceiling.`,
    );
  }
  if (recent !== null) {
    if (recentWithinBand) {
      parts.push(
        `The most recent run (${pct(recent.accuracy)} @ ${recent.commit.slice(0, 7)}) sits within ${a.K}σ of the measured same-config mean, so the cell is INSIDE the noise band at head, not a regression beyond noise.`,
      );
    } else {
      parts.push(
        `The most recent run (${pct(recent.accuracy)} @ ${recent.commit.slice(0, 7)}) is below mean - ${a.K}σ of the measured config, a residual that is NOT explained by same-config noise and warrants a host-side bisect at head.`,
      );
    }
  }
  parts.push(
    `Verdict: ${recentWithinBand ? 'the swing is inside measured same-config noise' + (peakUnreplicated ? ' plus an unreplicated peak' : '') + '; not a confirmed regression on the measured evidence' : 'the head value exceeds measured same-config noise; confirm with n>=' + MIN_RUNS_FOR_SIGMA + ' repeats at head before calling it real, then bisect'}.`,
  );
  return parts.join(' ');
}
