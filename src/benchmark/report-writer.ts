import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkReport } from './types.js';

/**
 * Write benchmark report to JSON + human-readable summary.
 */
export function writeReport(report: BenchmarkReport, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = report.timestamp.replace(/[:.]/g, '-');
  const baseName = `benchmark-${report.corpus}-${timestamp}`;

  // Full JSON
  const jsonPath = resolve(outputDir, `${baseName}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Human-readable summary
  const summary = formatSummary(report);
  const summaryPath = resolve(outputDir, `${baseName}.txt`);
  writeFileSync(summaryPath, summary);
}

function formatSummary(report: BenchmarkReport): string {
  const status = report.killConditionMet ? 'PASSED' : '** FAILED **';
  const lines = [
    `DEMIURGE BENCHMARK REPORT`,
    `=========================`,
    `Corpus: ${report.corpus}`,
    `Date: ${report.timestamp}`,
    ``,
    `ACCURACY: ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.totalQuestions})`,
    `Kill threshold: ${(report.killThreshold * 100).toFixed(1)}%`,
    `Status: ${status}`,
    ``,
    `LATENCY:`,
    `  Retrieval mean: ${report.meanRetrievalMs.toFixed(1)}ms`,
    `  Retrieval p95:  ${report.p95RetrievalMs.toFixed(1)}ms`,
    `  Total mean:     ${report.meanTotalMs.toFixed(1)}ms`,
    `  Total p95:      ${report.p95TotalMs.toFixed(1)}ms`,
    ``,
    `FAILURES:`,
  ];

  const failures = report.results.filter((r) => !r.correct);
  if (failures.length === 0) {
    lines.push(`  None.`);
  } else {
    for (const f of failures) {
      lines.push(`  [${f.questionId}] ${f.question}`);
      lines.push(`    Missing facts: ${f.factsMissed.join(', ')}`);
    }
  }

  return lines.join('\n');
}
