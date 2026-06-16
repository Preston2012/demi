#!/usr/bin/env npx tsx
/**
 * Demiurge scorecard, full analysis run (S78, spec §12-§14).
 *
 * Runs the scorecard over the FULL committed archive (both hosts) and writes the
 * §13-§14 deliverables to scorecard/:
 *   - SCORECARD.md            BROAD + DEEP current-state report (latest per bench)
 *   - VARIANCE.md             per-cell sigma, needs-repeats gap list, drift,
 *                             the regression scan, and the CloneMem verdict
 *   - scorecard.json          machine-readable report + variance
 *
 * This is the "run it" half of the task: build the tool, then establish real
 * variance and deliver the measured verdicts. It does NOT need the engine or API
 * keys (archive-only); the judge/engine sigma decomposition is the host harness.
 *
 * Usage: tsx scripts/scorecard/analyze.ts [--results benchmark-archive] [--out-dir scorecard]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRecords,
  selectLatestRuns,
  applyAbstention,
  computeReport,
  computeVariance,
  analyzeCell,
  scanRegressions,
  renderMarkdown,
  renderVarianceMarkdown,
  renderRegressionScanMarkdown,
  renderCellAnalysisMarkdown,
  renderJson,
} from '../../src/benchmark/scorecard/index.js';

function argVal(args: string[], flag: string, dflt: string): string {
  const i = args.indexOf(flag);
  return i !== -1 ? (args[i + 1] ?? dflt) : dflt;
}

function main(): void {
  const args = process.argv.slice(2);
  const results = argVal(args, '--results', 'benchmark-archive');
  const outDir = argVal(args, '--out-dir', 'scorecard');
  mkdirSync(outDir, { recursive: true });

  const built = buildRecords(results, { correctThreshold: 0.5 });
  const abst = applyAbstention(built.records, {});

  // current-state report = latest run per (bench, Q-tier)
  const latest = selectLatestRuns(built.records, built.fingerprints);
  const report = computeReport(latest, {
    correctThreshold: 0.5,
    classifierHash: built.classify.classifier_hash,
    noVerdict: abst.no_verdict,
    skipped: built.skipped,
  });

  // variance = full archive
  const variance = computeVariance(built.records);
  const scan = scanRegressions(built.records);
  const counterfactual = analyzeCell(built.records, 'clonemem', 'cat:counterfactual');

  // ---- SCORECARD.md ----
  const scorecardMd = [
    renderMarkdown(report),
    `\n_archive: ${built.files.length} runs, ${built.records.length} questions (full); report = latest run per bench/tier (${latest.length} questions). abstention source: ${abst.source}._\n`,
  ].join('\n');
  writeFileSync(join(outDir, 'SCORECARD.md'), scorecardMd + '\n');

  // ---- VARIANCE.md ----
  const varianceMd = [
    renderVarianceMarkdown(variance),
    renderRegressionScanMarkdown(scan),
    renderCellAnalysisMarkdown(counterfactual),
  ].join('\n');
  writeFileSync(join(outDir, 'VARIANCE.md'), varianceMd + '\n');

  // ---- scorecard.json ----
  writeFileSync(join(outDir, 'scorecard.json'), renderJson(report, variance) + '\n');

  // ---- console summary ----
  const gatedGroups = variance.groups.length;
  const needs = variance.needs_repeats.length;
  process.stdout.write(
    `wrote ${outDir}/SCORECARD.md, ${outDir}/VARIANCE.md, ${outDir}/scorecard.json\n` +
      `archive: ${built.files.length} runs · ${built.records.length} questions\n` +
      `gated sigma groups (n>=${variance.min_runs_for_sigma}): ${gatedGroups} · needs-repeats groups: ${needs}\n` +
      `CloneMem counterfactual: ${counterfactual.verdict}\n`,
  );
}

main();
