#!/usr/bin/env npx tsx
/**
 * Demiurge scorecard, in-repo anti-regression gate (S78, spec §14.2).
 *
 * Runs over the COMMITTED archive (benchmark-archive/) against a committed
 * baseline. Because both the archive and the baseline are in-tree, this gate
 * runs anywhere, including GitHub Actions, with no engine, data, or API keys.
 * It catches regressions and drift already recorded in committed result JSONs
 * and validates the baseline's integrity.
 *
 * The host-side fresh-run gate (scripts/scorecard/host/live-gate.ts) is the
 * complement: it runs a NEW bench on CAX11/CAX21 and gates it. Routine gating
 * there uses the mini tier; pre-publish uses full.
 *
 * UNSKIPPABLE (spec §14.3): there is no SKIP env, no --force, no --no-verify. A
 * regression exits 1. The baseline is read-only here; it changes only through
 * host/rebaseline.ts.
 *
 * Usage:
 *   tsx scripts/scorecard/gate.ts --baseline scorecard/baselines/<file>.json
 *        [--results benchmark-archive] [--bench b] [--correct-threshold f]
 */

import {
  buildRecords,
  selectLatestRuns,
  applyAbstention,
  computeVariance,
  loadBaseline,
  summarizeBaseline,
  evaluateGate,
  formatGateResult,
  classifierHash,
  type BenchId,
} from '../../src/benchmark/scorecard/index.js';

function argVal(args: string[], flag: string, dflt?: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : dflt;
}

function main(): void {
  const args = process.argv.slice(2);
  const baselinePath = argVal(args, '--baseline');
  if (!baselinePath) {
    process.stderr.write('error: --baseline <path> is required\n');
    process.exit(2);
  }
  const results = argVal(args, '--results', 'benchmark-archive')!;
  const bench = argVal(args, '--bench') as BenchId | undefined;
  const correctThreshold = parseFloat(argVal(args, '--correct-threshold', '0.5')!);

  const baseline = loadBaseline(baselinePath);

  // Self-check (R29-N1/W0-2): announce exactly which baseline file is gating and
  // when it was generated, so a stale or mis-pinned baseline is visible in the
  // CI log instead of silently passing green.
  process.stdout.write(`gate baseline file: ${baselinePath}\n`);
  process.stdout.write(`gate baseline generated_at: ${baseline.generated_at}\n`);

  const built = buildRecords(results, { correctThreshold, ...(bench ? { bench } : {}) });
  applyAbstention(built.records, {});

  const fresh = selectLatestRuns(built.records);
  const variance = computeVariance(built.records);

  const result = evaluateGate({
    freshRecords: fresh,
    baseline,
    freshClassifierHash: classifierHash(),
    timeseries: variance.timeseries,
  });

  process.stdout.write(summarizeBaseline(baseline) + '\n');
  process.stdout.write(`gate matched baseline cells: ${result.matchedCells}\n\n`);
  process.stdout.write(formatGateResult(result) + '\n');

  // Self-check: a baseline that matches zero fresh cells is gating nothing -
  // exactly the stale/mis-pinned failure mode R29-N1 caught. Hard-fail rather
  // than report a hollow PASS.
  if (result.matchedCells === 0) {
    process.stderr.write('GATE ERROR: baseline matched zero cells\n');
    process.exit(2);
  }

  // Unskippable: a regression exits non-zero. No bypass exists.
  process.exit(result.pass ? 0 : 1);
}

main();
