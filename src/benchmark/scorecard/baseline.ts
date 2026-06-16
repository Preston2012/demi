/**
 * Product scorecard, baseline file (S78, spec §14.5).
 *
 * The committed baseline is the SINGLE source of truth for "what is a
 * regression". Per (bench, Q-tier, config-fingerprint) it records the measured
 * overall mean+sigma and per-cell mean+sigma+n+gated, plus the K constants and
 * the classifier hash the numbers are expressed in. Both the gate and the
 * scorecard read this file.
 *
 * It is built ONLY from fingerprint groups that have enough same-config runs to
 * measure sigma (gated). Ungated cells are still written (gated:false) so the
 * gate knows to skip them rather than guess.
 *
 * `writeBaseline` exists for the host re-baseline script only; the gate never
 * writes the baseline (spec §14.3).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Baseline, BaselineCell, BaselineEntry, VarianceReport } from './types.js';
import { ScorecardError } from './types.js';
import { HIGH_NOISE_SIGMA } from './analysis.js';

export interface BuildBaselineOptions {
  /** K for the overall mean - K*sigma rule (spec §14.1, default 3). */
  K_overall?: number;
  /** K for per-cell gating (looser, default 2). */
  K_cell?: number;
  /** Commit this baseline was cut at (stamped per entry). */
  rebaselinedCommit?: string;
  /** Include only gated (n>=min) groups. Default true, an ungated group has no
   *  measurable sigma so it cannot define a regression threshold. */
  gatedOnly?: boolean;
  /** Skip groups whose overall sigma exceeds this (default HIGH_NOISE_SIGMA): an
   *  unstable config (e.g. 5/6 runs at 0%) is not a valid baseline; stabilize
   *  the runs first. Set Infinity to baseline everything. */
  maxSigmaOverall?: number;
}

/** Result of a buildBaseline call, including what was excluded and why. */
export interface BuildBaselineResult {
  baseline: Baseline;
  /** groups dropped as too unstable to baseline (sigma > maxSigmaOverall). */
  excludedUnstable: Array<{ bench: string; qtier: string; fingerprint: string; sigma: number }>;
}

/** Build a baseline from a variance report's fingerprint groups. */
export function buildBaseline(variance: VarianceReport, opts: BuildBaselineOptions = {}): BuildBaselineResult {
  const K_overall = opts.K_overall ?? 3;
  const K_cell = opts.K_cell ?? 2;
  const gatedOnly = opts.gatedOnly ?? true;
  const maxSigma = opts.maxSigmaOverall ?? HIGH_NOISE_SIGMA;

  const entries: BaselineEntry[] = [];
  const excludedUnstable: BuildBaselineResult['excludedUnstable'] = [];
  for (const g of variance.groups) {
    if (gatedOnly && !g.gated_overall) continue;
    if (g.sigma_overall > maxSigma) {
      excludedUnstable.push({ bench: g.bench, qtier: g.qtier, fingerprint: g.fingerprint, sigma: g.sigma_overall });
      continue;
    }
    const per_cell: Record<string, BaselineCell> = {};
    for (const c of g.per_cell) {
      per_cell[c.cell] = { mean: c.mean, sigma: c.sigma, n: c.n, q_per_run: c.questions_per_run, gated: c.gated };
    }
    entries.push({
      bench: g.bench,
      qtier: g.qtier,
      config_fingerprint: g.fingerprint,
      n_runs: g.n_runs,
      mean: g.mean_overall,
      sigma_overall: g.sigma_overall,
      questions_per_run: g.questions_per_run,
      per_cell,
      last_rebaselined_commit: opts.rebaselinedCommit ?? '',
    });
  }

  return {
    baseline: {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      classifier_hash: variance.classifier_hash,
      K_overall,
      K_cell,
      entries,
    },
    excludedUnstable,
  };
}

/** Load and validate a committed baseline file. */
export function loadBaseline(path: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new ScorecardError(`cannot read baseline ${path}: ${(e as Error).message}`);
  }
  const b = raw as Baseline;
  if (!b || b.schema_version !== 1 || !Array.isArray(b.entries)) {
    throw new ScorecardError(`baseline ${path} is not a valid schema_version:1 baseline`);
  }
  return b;
}

/** Write a baseline file (host re-baseline only, NEVER called by the gate). */
export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
}

/** One-line human summary of a baseline's coverage. */
export function summarizeBaseline(baseline: Baseline): string {
  const benches = new Set(baseline.entries.map((e) => e.bench));
  const gatedCells = baseline.entries.reduce(
    (acc, e) => acc + Object.values(e.per_cell).filter((c) => c.gated).length,
    0,
  );
  return `baseline: ${baseline.entries.length} entries across ${benches.size} bench(es), ${gatedCells} gated cells, K_overall=${baseline.K_overall}, classifier ${baseline.classifier_hash.slice(0, 12)}`;
}
