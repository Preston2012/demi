/**
 * Product scorecard, markdown renderer (S78, spec §7).
 *
 * Report → markdown tables, BROAD section then DEEP section, with the product
 * targets flagged. Pure string output; the CLI owns stdout.
 */

import type { AbstentionStats, CellStats, NamedCell, ScorecardReport, VarianceReport } from './types.js';
import type { CellAnalysis } from './analysis.js';
import { verdictClass } from './analysis.js';

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
function ms(x: number | null): string {
  return x === null ? '-' : `${Math.round(x)}`;
}
function flag(pass: boolean): string {
  return pass ? '✅' : '❌';
}

const STAT_HEADER = '| cell | n | acc | abstain | wrong | ret p50 | ret p95 | tot p50 | tot p95 |';
const STAT_SEP = '|---|--:|--:|--:|--:|--:|--:|--:|--:|';

function statRow(label: string, s: CellStats): string {
  return `| ${label} | ${s.n} | ${pct(s.accuracy)} | ${pct(s.abstention_rate)} | ${pct(s.wrong_rate)} | ${ms(
    s.retrieval_ms_p50,
  )} | ${ms(s.retrieval_ms_p95)} | ${ms(s.total_ms_p50)} | ${ms(s.total_ms_p95)} |`;
}

function table(title: string, cells: NamedCell[]): string {
  if (cells.length === 0) return `### ${title}\n\n_(no rows)_\n`;
  const rows = cells.map((c) => statRow(c.label, c.stats)).join('\n');
  return `### ${title}\n\n${STAT_HEADER}\n${STAT_SEP}\n${rows}\n`;
}

function abstentionTable(title: string, rows: Array<{ label: string; s: AbstentionStats }>): string {
  const header = '| scope | should-abstain n | decline-recall | good-catch | over-refuse | no-verdict |';
  const sep = '|---|--:|--:|--:|--:|--:|';
  const body = rows
    .map(
      ({ label, s }) =>
        `| ${label} | ${s.should_abstain_n} | ${pct(s.decline_recall)} | ${s.good_catch} | ${s.over_refuse} | ${s.no_verdict} |`,
    )
    .join('\n');
  return `### ${title}\n\n${header}\n${sep}\n${body}\n`;
}

export function renderMarkdown(report: ScorecardReport): string {
  const out: string[] = [];
  out.push('# Demiurge Product Scorecard');
  out.push('');
  out.push(
    `generated: ${report.generated_at}  |  records: ${report.total_records}  |  benches: ${report.benches.join(', ')}`,
  );
  out.push(
    `classifier: \`${report.classifier_hash.slice(0, 12)}\` (unified taxonomy stamped; may differ from the recorded \`5acffcf\` labels)  |  correct-threshold: ${report.correct_threshold}`,
  );
  out.push('');
  out.push(
    '> READ-ONLY reporting overlay. LOCOMO numeric category → label mapping is asserted from the runner methodology block. Adversarial benches (BEAM) read high on abstention/wrong by design, every target is reported per-bench so no adversarial bench masks the real-distribution read.',
  );
  out.push('');

  // ---- TARGETS ----
  out.push('## Product targets (spec §5)');
  out.push('');
  out.push('| metric | scope | value | threshold | pass |');
  out.push('|---|---|--:|--:|:--:|');
  for (const t of report.targets) {
    const thr = t.metric === 'abstention_rate' ? '≤ 20%' : '< 1%';
    out.push(`| ${t.metric} | ${t.scope} | ${pct(t.value)} | ${thr} | ${flag(t.pass)} |`);
  }
  out.push('');

  // ---- BROAD ----
  out.push('## BROAD');
  out.push('');
  out.push(table('Per bench', report.per_bench));
  out.push(table('Per bench × native category', report.per_bench_category));

  // ---- DEEP ----
  out.push('## DEEP (unified cross-bench taxonomy)');
  out.push('');
  out.push(table('By query_type (pooled across benches)', report.by_query_type));
  out.push(table('By query_type × bench', report.by_query_type_bench));
  out.push(table('Temporal drill (temporal + temporal-multi-hop)', report.temporal_drill));
  out.push(table('Multi-hop drill (multi-hop + temporal-multi-hop)', report.multihop_drill));
  out.push(table('Single-hop drill', report.singlehop_drill));
  out.push(table('Hallucination drill (answered-and-wrong concentration)', report.hallucination_drill));
  out.push(table('CloneMem question_type drill (counterfactual = tracked regression)', report.clonemem_question_type));

  // ---- ABSTENTION ----
  out.push('## Abstention (spec §5 view 7)');
  out.push('');
  out.push(
    abstentionTable('Abstention by scope', [
      { label: 'OVERALL', s: report.abstention.overall },
      ...report.abstention.per_bench.map((b) => ({ label: b.bench, s: b.stats })),
    ]),
  );

  // ---- DIVERGENCE ----
  out.push('## Taxonomy divergence (recorded query_type vs unified)');
  out.push('');
  if (report.divergence.per_bench.length === 0) {
    out.push('_(no bench in this run recorded a query_type to cross-check)_');
  } else {
    out.push('| bench | n with recorded | diverged | divergence rate |');
    out.push('|---|--:|--:|--:|');
    for (const d of report.divergence.per_bench) {
      out.push(`| ${d.bench} | ${d.n_with_recorded} | ${d.n_diverged} | ${pct(d.divergence_rate)} |`);
    }
  }
  out.push('');

  // ---- SKIPPED ----
  if (report.skipped.length > 0) {
    out.push('## Skipped files (surfaced, not silent, spec §8)');
    out.push('');
    const byReason = new Map<string, number>();
    for (const s of report.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    out.push('| reason | count |');
    out.push('|---|--:|');
    for (const [reason, count] of byReason) out.push(`| ${reason} | ${count} |`);
    out.push('');
  }

  return out.join('\n');
}

function ppFromAcc(x: number): string {
  return `${(100 * x).toFixed(1)}pp`;
}

/**
 * Variance report → markdown (spec §13): the per-cell sigma table for every
 * gated fingerprint group, the "needs repeats" gap list (n<3), and the drift
 * slopes. Every sigma here is measured; ungated cells say so explicitly.
 */
export function renderVarianceMarkdown(variance: VarianceReport): string {
  const out: string[] = [];
  out.push('# Variance establishment (spec §13)');
  out.push('');
  out.push(
    `generated: ${variance.generated_at}  |  classifier: \`${variance.classifier_hash.slice(0, 12)}\`  |  min runs for sigma: ${variance.min_runs_for_sigma} (judge-sigma: ${variance.min_runs_for_judge_sigma}, host-only)`,
  );
  out.push('');
  out.push(
    '> Every number is measured from same-config repeats in the archive. Sample stdev (n-1). Judge-only and engine-only decomposition (§13.1) need the host harness and are NOT in this archive-only report.',
  );
  out.push('');

  // ---- gated groups: per-cell sigma ----
  out.push('## Per-cell sigma (groups with n>=min same-config runs)');
  out.push('');
  if (variance.groups.length === 0) {
    out.push(
      '_(no (bench, config, Q-tier) group has enough same-config runs to measure sigma, see the gap list below)_',
    );
  } else {
    for (const g of variance.groups) {
      out.push(
        `### ${g.bench} · ${g.qtier} · \`${g.fingerprint.slice(0, 10)}\`, n=${g.n_runs} runs, overall ${(
          100 * g.mean_overall
        ).toFixed(1)}% ± ${ppFromAcc(g.sigma_overall)}`,
      );
      out.push('');
      out.push(
        'runs: ' +
          g.run_refs
            .map((r) => `${r.commit.slice(0, 7)}@${r.timestamp.slice(0, 10)}=${(100 * r.accuracy).toFixed(1)}%`)
            .join(', '),
      );
      out.push('');
      out.push('| cell | mean | sigma | n | q/run | gated |');
      out.push('|---|--:|--:|--:|--:|:--:|');
      for (const c of g.per_cell) {
        out.push(
          `| ${c.cell} | ${(100 * c.mean).toFixed(1)}% | ${ppFromAcc(c.sigma)} | ${c.n} | ${c.questions_per_run.toFixed(
            1,
          )} | ${c.gated ? '✅' : '-'} |`,
        );
      }
      out.push('');
    }
  }

  // ---- needs repeats ----
  out.push('## Needs repeats (sigma unknown, gate disabled, spec §13.3)');
  out.push('');
  if (variance.needs_repeats.length === 0) {
    out.push('_(every group has enough repeats)_');
  } else {
    out.push(
      `${variance.needs_repeats.length} (bench, config, Q-tier) group(s) lack enough same-config runs to measure sigma:`,
    );
    out.push('');
    out.push('| bench | qtier | fingerprint | have | need |');
    out.push('|---|---|---|--:|--:|');
    for (const nr of variance.needs_repeats) {
      out.push(`| ${nr.bench} | ${nr.qtier} | \`${nr.fingerprint.slice(0, 10)}\` | ${nr.n_have} | ${nr.n_needed} |`);
    }
  }
  out.push('');

  // ---- drift ----
  const drifting = variance.timeseries.filter((t) => t.slope_significant && t.slope !== null && t.slope < 0);
  out.push('## Drift trend (significant downward slope, spec §14.4)');
  out.push('');
  if (drifting.length === 0) {
    out.push('_(no cell shows a statistically-significant downward slope across the window)_');
  } else {
    out.push('| bench | cell | slope (pp/run) | points |');
    out.push('|---|---|--:|--:|');
    for (const t of drifting) {
      out.push(`| ${t.bench} | ${t.cell} | ${(100 * (t.slope as number)).toFixed(2)} | ${t.points.length} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

const VERDICT_LABEL: Record<string, string> = {
  noise: 'NOISE (head inside measured 2σ)',
  residual: 'RESIDUAL > noise (bisect at head)',
  'sigma-unknown': 'SIGMA UNKNOWN (needs repeats)',
  'high-noise': 'NOISE FLOOR TOO HIGH (unstable; investigate)',
  flat: 'flat (<1pp swing)',
};

/**
 * Regression scan → a compact verdict table: every native-category cell that
 * varies across the archive, its swing, its measured same-config sigma, and the
 * real-or-noise verdict. Answers "for every cell anyone called a regression:
 * real, or noise?".
 */
export function renderRegressionScanMarkdown(analyses: CellAnalysis[]): string {
  const out: string[] = [];
  out.push('## Regression scan, real or noise, per cell (spec §13.2)');
  out.push('');
  out.push(
    'Every native-category cell that moved across the archive, with its measured same-config noise floor and a verdict. No cell is called a regression OR noise without a measured sigma behind it.',
  );
  out.push('');
  out.push('| bench | cell | swing | measured σ (n) | recent | verdict |');
  out.push('|---|---|--:|--:|--:|---|');
  for (const a of analyses) {
    const swing = a.claimed_move_pp !== null ? `${a.claimed_move_pp.toFixed(1)}pp` : '-';
    const g = a.best_gated_group;
    const sigma = g ? `${(100 * g.sigma).toFixed(1)}pp (n=${g.n_runs})` : '- (n<3)';
    const recent = a.points.length ? `${(100 * a.points[a.points.length - 1]!.accuracy).toFixed(1)}%` : '-';
    out.push(
      `| ${a.bench} | ${a.cell.replace(/^cat:/, '')} | ${swing} | ${sigma} | ${recent} | ${VERDICT_LABEL[verdictClass(a)]} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/** Cell regression analysis → markdown (the CloneMem-counterfactual verdict). */
export function renderCellAnalysisMarkdown(analysis: CellAnalysis): string {
  const out: string[] = [];
  out.push(`## Cell verdict: ${analysis.bench} · ${analysis.cell}`);
  out.push('');
  out.push(`**${analysis.verdict}**`);
  out.push('');
  if (analysis.points.length > 0) {
    out.push('per-run history (one row per result file):');
    out.push('');
    out.push('| timestamp | commit | host | n | correct | accuracy | fingerprint |');
    out.push('|---|---|---|--:|--:|--:|---|');
    for (const p of analysis.points) {
      out.push(
        `| ${p.timestamp.slice(0, 19)} | ${p.commit.slice(0, 7)} | ${p.host} | ${p.n} | ${p.correct} | ${(
          100 * p.accuracy
        ).toFixed(1)}% | \`${p.fingerprint.slice(0, 10)}\` |`,
      );
    }
    out.push('');
  }
  if (analysis.same_config_groups.length > 0) {
    out.push('same-config groups:');
    out.push('');
    out.push('| fingerprint | runs | mean | sigma | gated |');
    out.push('|---|--:|--:|--:|:--:|');
    for (const g of analysis.same_config_groups) {
      out.push(
        `| \`${g.fingerprint.slice(0, 10)}\` | ${g.n_runs} | ${(100 * g.mean).toFixed(1)}% | ${(100 * g.sigma).toFixed(
          1,
        )}pp | ${g.gated ? '✅' : '-'} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}
