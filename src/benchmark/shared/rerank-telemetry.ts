/**
 * S59 / TEMPR, shared bench harness assertion + helpers for the reranker
 * degraded-rate gate.
 *
 * Bench runners call `assertRerankDegradedBelow(threshold, label)` at the
 * end of main(). The assertion fires when degraded >= threshold * total -
 * i.e. the reranker timed out or failed to load on >= 1% of queries.
 * Threshold defaults to 0.01 per S59 promotion gate.
 *
 * S59A adds the `gated` counter (RERANK_QUERY_TYPE_GATING). Gated calls are
 * deliberate skips, they do NOT count against the degraded gate. The
 * summary helper prints all three numbers (total / degraded / gated /
 * active) so a multi-axis view is available.
 *
 * The harness should NOT auto-reset before each bench, that hides cumulative
 * issues across multi-bench runs. Call resetRerankCounters() explicitly if
 * isolation between benches is desired.
 */

import { getRerankDegradedCount, getRerankGatedCount, getRerankTotalCount } from '../../retrieval/reranker.js';

export const DEFAULT_DEGRADED_THRESHOLD = 0.01;

export interface DegradedReport {
  total: number;
  degraded: number;
  gated: number;
  active: number;
  degradedRate: number;
  gatedRate: number;
  threshold: number;
  passed: boolean;
}

export function getRerankDegradedReport(threshold: number = DEFAULT_DEGRADED_THRESHOLD): DegradedReport {
  const total = getRerankTotalCount();
  const degraded = getRerankDegradedCount();
  const gated = getRerankGatedCount();
  const active = Math.max(0, total - degraded - gated);
  const degradedRate = total === 0 ? 0 : degraded / total;
  const gatedRate = total === 0 ? 0 : gated / total;
  return { total, degraded, gated, active, degradedRate, gatedRate, threshold, passed: degradedRate < threshold };
}

/** Print a multi-axis summary suitable for end-of-bench logs. */
export function printRerankSummary(label: string = 'rerank'): void {
  const r = getRerankDegradedReport();
  if (r.total === 0) {
    console.log(`${label}: rerank not invoked (RERANKER_ENABLED=false?)`);
    return;
  }
  console.log(
    `${label} rerank summary:\n` +
      `  total calls:         ${r.total}\n` +
      `  degraded (fallback): ${r.degraded} (${(r.degradedRate * 100).toFixed(2)}%)   [target < ${(r.threshold * 100).toFixed(0)}%]\n` +
      `  gated (skipped):     ${r.gated} (${(r.gatedRate * 100).toFixed(2)}%)   [info, not a target]\n` +
      `  active (ran):        ${r.active} (${((r.active / r.total) * 100).toFixed(2)}%)`,
  );
}

/**
 * Throws an Error if the degraded-rate gate is breached. Suitable for
 * the end of bench main(): the throw aborts the runner with a non-zero
 * exit code, which CI / pre-bench-gate.sh treat as a hard fail.
 *
 * No-op when total === 0 (RERANKER_ENABLED=false → no rerank calls).
 * Gated calls do NOT count against this gate, gating is by design.
 */
export function assertRerankDegradedBelow(
  threshold: number = DEFAULT_DEGRADED_THRESHOLD,
  label: string = 'rerank',
): void {
  const r = getRerankDegradedReport(threshold);
  if (r.total === 0) return;
  printRerankSummary(label);
  if (r.passed) return;
  throw new Error(
    `${label}: rerank degraded rate ${(r.degradedRate * 100).toFixed(2)}% >= ${(threshold * 100).toFixed(0)}% ` +
      `(${r.degraded}/${r.total}), engine.rerank.degraded gate breached`,
  );
}
