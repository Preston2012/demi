#!/usr/bin/env npx tsx
/**
 * Demiurge product scorecard, CLI (S78, spec §7).
 *
 * READ-ONLY reporting + anti-regression overlay over committed benchmark result
 * JSONs. Generalizes scripts/hallucination-scorecard.py to every bench and the
 * unified cross-bench taxonomy, plus the variance layer and the gate.
 *
 * Usage:
 *   tsx scripts/scorecard/scorecard.ts [--results <dir|json>] [flags]
 *
 * Flags (spec §7):
 *   --results <path>          results dir or single json   (default: benchmark-archive)
 *   --bench <name>            restrict to one bench
 *   --commit <sha>            restrict to runs at a (short) commit
 *   --correct-threshold <f>   beam nugget_score >= f is correct (default 0.5)
 *   --gate-log <path>         abstention-gate log for shadow abstention
 *   --all-runs                pool every archived run (default: latest per bench/tier)
 *   --variance                also emit the §13 variance report
 *   --counterfactual          also emit the CloneMem counterfactual cell verdict
 *   --cell <bench:cellKey>    emit a regression verdict for an arbitrary cell
 *   --json                    machine-readable JSON instead of markdown
 *   --compare <baseline.json> run the anti-regression gate; exit non-zero on regress
 *   --no-cache                do not read/write the classifier cache
 *   --help
 *
 * The gate (--compare) is UNSKIPPABLE: there is no SKIP env, no --force, no
 * --no-verify. A regression exits 1 (spec §14.3).
 */

import {
  buildRecords,
  selectLatestRuns,
  applyAbstention,
  computeReport,
  computeVariance,
  analyzeCell,
  loadBaseline,
  evaluateGate,
  formatGateResult,
  renderMarkdown,
  renderVarianceMarkdown,
  renderCellAnalysisMarkdown,
  renderJson,
  classifierHash,
  type BenchId,
} from '../../src/benchmark/scorecard/index.js';

function argVal(args: string[], flag: string, dflt?: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : dflt;
}
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function main(): void {
  const args = process.argv.slice(2);

  if (hasFlag(args, '--help')) {
    // The header comment is the help text; print a compact version.
    process.stdout.write(
      'scorecard --results <dir|json> [--bench b] [--commit sha] [--correct-threshold f]\n' +
        '          [--gate-log log] [--variance] [--counterfactual] [--cell bench:cellKey]\n' +
        '          [--json] [--compare baseline.json] [--no-cache]\n',
    );
    return;
  }

  const results = argVal(args, '--results', 'benchmark-archive')!;
  const bench = argVal(args, '--bench') as BenchId | undefined;
  const commit = argVal(args, '--commit');
  const correctThreshold = parseFloat(argVal(args, '--correct-threshold', '0.5')!);
  const gateLog = argVal(args, '--gate-log');
  const allRuns = hasFlag(args, '--all-runs');
  const noCache = hasFlag(args, '--no-cache');
  const wantVariance = hasFlag(args, '--variance');
  const wantCounterfactual = hasFlag(args, '--counterfactual');
  const cellSpec = argVal(args, '--cell');
  const asJson = hasFlag(args, '--json');
  const comparePath = argVal(args, '--compare');

  // ---- ingest ----
  const built = buildRecords(results, {
    correctThreshold,
    ...(bench ? { bench } : {}),
    ...(commit ? { commit } : {}),
    noCache,
  });
  const abst = applyAbstention(built.records, gateLog ? { gateLog } : {});

  // The report is a "current state" view: latest run per (bench, Q-tier) by
  // default (spec §3). Variance and the time series always read the full
  // archive (spec §12). --all-runs pools every archived run into the report.
  const reportRecords = allRuns ? built.records : selectLatestRuns(built.records, built.fingerprints);

  // ---- gate mode (UNSKIPPABLE) ----
  if (comparePath) {
    const baseline = loadBaseline(comparePath);
    const variance = computeVariance(built.records);
    const result = evaluateGate({
      freshRecords: reportRecords,
      baseline,
      freshClassifierHash: classifierHash(),
      timeseries: variance.timeseries,
    });
    process.stdout.write(formatGateResult(result) + '\n');
    process.exit(result.pass ? 0 : 1);
  }

  // ---- report ----
  const report = computeReport(reportRecords, {
    correctThreshold,
    classifierHash: built.classify.classifier_hash,
    noVerdict: abst.no_verdict,
    skipped: built.skipped,
  });
  const variance = wantVariance || wantCounterfactual || cellSpec ? computeVariance(built.records) : undefined;

  if (asJson) {
    process.stdout.write(renderJson(report, variance) + '\n');
    return;
  }

  // ---- markdown ----
  const sections: string[] = [renderMarkdown(report)];
  sections.push(
    `\n_abstention source: ${abst.source}${abst.no_verdict ? ` (no gate verdict matched for ${abst.no_verdict} questions)` : ''}; classifier cache: ${built.classify.cache_hits} hits / ${built.classify.cache_misses} misses_\n`,
  );
  if (variance) sections.push(renderVarianceMarkdown(variance));
  if (wantCounterfactual) {
    sections.push(renderCellAnalysisMarkdown(analyzeCell(built.records, 'clonemem', 'cat:counterfactual')));
  }
  if (cellSpec) {
    const [b, ...rest] = cellSpec.split(':');
    const cellKey = rest.join(':');
    sections.push(renderCellAnalysisMarkdown(analyzeCell(built.records, b as BenchId, cellKey)));
  }
  process.stdout.write(sections.join('\n') + '\n');
}

main();
