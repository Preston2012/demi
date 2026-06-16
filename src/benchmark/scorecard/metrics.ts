/**
 * Product scorecard, metrics + views (S78, spec §5).
 *
 * Pure aggregation: NormalizedRecord[] → CellStats and the BROAD + DEEP views.
 * No I/O. The two product targets (abstention_rate <= 20%, wrong_rate < 1%) are
 * evaluated per-bench AND overall so an adversarial bench (BEAM) can never mask
 * the real-distribution read (spec §5 TARGETS).
 */

import type {
  AbstentionStats,
  BenchId,
  CellStats,
  DivergenceReport,
  NamedCell,
  NormalizedRecord,
  ScorecardReport,
  SkippedFile,
  TargetEval,
} from './types.js';
import { isMultiHop, isSingleHop, isTemporal, temporalSub, buildDivergenceReport } from './taxonomy.js';

export const ABSTENTION_TARGET = 0.2;
export const WRONG_TARGET = 0.01;

/** Linear-interpolation percentile over a value list (0 <= p <= 1). */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return s[lo]! + (s[hi]! - s[lo]!) * frac;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Core metric bundle for a slice of records. */
export function cellStats(records: NormalizedRecord[]): CellStats {
  const n = records.length;
  let answeredCorrect = 0;
  let abstained = 0;
  let wrong = 0;
  const ret: number[] = [];
  const tot: number[] = [];
  for (const r of records) {
    if (r.abstained) abstained++;
    else if (r.correct) answeredCorrect++;
    if (r.wrong) wrong++;
    if (r.retrieval_ms !== null) ret.push(r.retrieval_ms);
    if (r.total_ms !== null) tot.push(r.total_ms);
  }
  return {
    n,
    accuracy: n ? answeredCorrect / n : 0,
    abstention_rate: n ? abstained / n : 0,
    wrong_rate: n ? wrong / n : 0,
    retrieval_ms_p50: percentile(ret, 0.5),
    retrieval_ms_p95: percentile(ret, 0.95),
    retrieval_ms_mean: mean(ret),
    total_ms_p50: percentile(tot, 0.5),
    total_ms_p95: percentile(tot, 0.95),
    total_ms_mean: mean(tot),
  };
}

/** Group records by a string key (skips records whose key is null). */
function groupBy(
  records: NormalizedRecord[],
  keyFn: (r: NormalizedRecord) => string | null,
): Map<string, NormalizedRecord[]> {
  const m = new Map<string, NormalizedRecord[]>();
  for (const r of records) {
    const k = keyFn(r);
    if (k === null) continue;
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Turn a group map into sorted NamedCells. */
function toCells(groups: Map<string, NormalizedRecord[]>, sortBy: 'label' | 'n' = 'label'): NamedCell[] {
  const cells = [...groups.entries()].map(([label, recs]) => ({ label, stats: cellStats(recs) }));
  if (sortBy === 'n') cells.sort((a, b) => b.stats.n - a.stats.n);
  else cells.sort((a, b) => a.label.localeCompare(b.label));
  return cells;
}

/** Abstention drill counts for a slice (spec §5 view 7). */
export function abstentionStats(records: NormalizedRecord[], noVerdict = 0): AbstentionStats {
  let shouldAbstainN = 0;
  let abstainedOnDecline = 0;
  let goodCatch = 0;
  let overRefuse = 0;
  for (const r of records) {
    if (r.should_abstain) shouldAbstainN++;
    if (r.abstained) {
      if (r.should_abstain) abstainedOnDecline++;
      // good_catch: declined an answer that was WRONG; over_refuse: declined a
      // CORRECT answer. On a should_abstain question, declining is the right
      // call, so a declined should_abstain question counts as a good_catch.
      if (r.correct && !r.should_abstain) overRefuse++;
      else goodCatch++;
    }
  }
  return {
    should_abstain_n: shouldAbstainN,
    abstained_on_decline: abstainedOnDecline,
    decline_recall: shouldAbstainN ? abstainedOnDecline / shouldAbstainN : 0,
    good_catch: goodCatch,
    over_refuse: overRefuse,
    no_verdict: noVerdict,
  };
}

export interface ComputeReportOptions {
  correctThreshold: number;
  classifierHash: string;
  /** gate-log no-verdict count, for the abstention section header. */
  noVerdict?: number;
  skipped?: SkippedFile[];
  divergence?: DivergenceReport;
}

/** Evaluate the two product targets for a labelled slice. */
function targetEvals(scope: string, stats: CellStats): TargetEval[] {
  return [
    {
      metric: 'abstention_rate',
      scope,
      value: stats.abstention_rate,
      threshold: ABSTENTION_TARGET,
      pass: stats.abstention_rate <= ABSTENTION_TARGET,
    },
    {
      metric: 'wrong_rate',
      scope,
      value: stats.wrong_rate,
      threshold: WRONG_TARGET,
      pass: stats.wrong_rate < WRONG_TARGET,
    },
  ];
}

/** Build the full scorecard report from classified, abstention-resolved records. */
export function computeReport(records: NormalizedRecord[], opts: ComputeReportOptions): ScorecardReport {
  const benches = [...new Set(records.map((r) => r.bench))].sort() as BenchId[];

  // BROAD 1: per bench
  const perBench = toCells(groupBy(records, (r) => r.bench));
  // BROAD 2: per (bench × native_category)
  const perBenchCategory = toCells(
    groupBy(records, (r) => (r.native_category ? `${r.bench} / ${r.native_category}` : null)),
  );

  // DEEP 3: pooled by unified query_type, plus per-bench split
  const byQueryType = toCells(groupBy(records, (r) => r.query_type_unified));
  const byQueryTypeBench = toCells(groupBy(records, (r) => `${r.query_type_unified} / ${r.bench}`));

  // DEEP 4: temporal drill (temporal + temporal-multi-hop), split by bench and sub
  const temporalRecs = records.filter((r) => isTemporal(r.query_type_unified));
  const temporalDrill = toCells(groupBy(temporalRecs, (r) => `${temporalSub(r.query_type_unified)} / ${r.bench}`));

  // DEEP 5: multi-hop drill (multi-hop + temporal-multi-hop), split temporal-vs-not
  const multihopRecs = records.filter((r) => isMultiHop(r.query_type_unified));
  const multihopDrill = toCells(
    groupBy(multihopRecs, (r) => `${isTemporal(r.query_type_unified) ? 'temporal-multi' : 'plain-multi'} / ${r.bench}`),
  );

  // DEEP 6: single-hop drill
  const singlehopRecs = records.filter((r) => isSingleHop(r.query_type_unified));
  const singlehopDrill = toCells(groupBy(singlehopRecs, (r) => r.bench));

  // DEEP 8: hallucination drill, where answered-and-wrong concentrates
  const hallucinationDrill = toCells(
    groupBy(records, (r) => `${r.query_type_unified} / ${r.bench}`),
    'n',
  )
    .filter((c) => c.stats.wrong_rate > 0)
    .sort((a, b) => b.stats.wrong_rate * b.stats.n - a.stats.wrong_rate * a.stats.n);

  // DEEP 9: clonemem question_type drill (counterfactual is the tracked cell)
  const clonememRecs = records.filter((r) => r.bench === 'clonemem');
  const clonememQuestionType = toCells(groupBy(clonememRecs, (r) => r.question_type));

  // Abstention: overall + per bench
  const abstentionOverall = abstentionStats(records, opts.noVerdict ?? 0);
  const abstentionPerBench = benches.map((bench) => ({
    bench,
    stats: abstentionStats(records.filter((r) => r.bench === bench)),
  }));

  // Targets: overall + per bench
  const overallStats = cellStats(records);
  const targets: TargetEval[] = [...targetEvals('OVERALL', overallStats)];
  for (const cell of perBench) targets.push(...targetEvals(cell.label, cell.stats));

  return {
    generated_at: new Date().toISOString(),
    classifier_hash: opts.classifierHash,
    correct_threshold: opts.correctThreshold,
    total_records: records.length,
    benches,
    per_bench: perBench,
    per_bench_category: perBenchCategory,
    by_query_type: byQueryType,
    by_query_type_bench: byQueryTypeBench,
    temporal_drill: temporalDrill,
    multihop_drill: multihopDrill,
    singlehop_drill: singlehopDrill,
    hallucination_drill: hallucinationDrill,
    clonemem_question_type: clonememQuestionType,
    abstention: { overall: abstentionOverall, per_bench: abstentionPerBench },
    targets,
    divergence: opts.divergence ?? buildDivergenceReport(records),
    skipped: opts.skipped ?? [],
  };
}
