/**
 * Product scorecard, shared types (S78).
 *
 * The scorecard is a READ-ONLY reporting + anti-regression overlay over the
 * committed benchmark result JSONs in `benchmark-archive/`. It never changes
 * how a bench scores or what the engine does (spec §8). These interfaces are
 * the contract every module reads.
 *
 * Spec: docs/internal/SCORECARD_CC_PACKET.md (§1-14).
 *
 * Design rule carried through every type: a field a given bench does not
 * produce is explicitly `null`, never `undefined` or a fabricated default.
 * Rates and percentiles exclude nulls. This is the anti-hand-wave discipline
 * (spec §13, "IK rules"): the absence of a measurement is itself reported, not
 * papered over.
 */

/** Per-question benches the scorecard normalizes. amb (aggregate-only) and
 *  recall (cluster-shaped) have no `results` array and are out of v1 scope. */
export type BenchId =
  | 'beam'
  | 'clonemem'
  | 'locomo'
  | 'longmemeval'
  | 'mab'
  | 'dialsim'
  | 'ece-brier'
  | 'security-frame-inject';

/** The full set of bench filename prefixes we recognise, including the two
 *  (amb, recall) we deliberately skip. Used by the loader to classify files. */
export type KnownBenchPrefix = BenchId | 'amb' | 'recall';

/** Q-tier label: 'mini' | 'full' | '500k' | a custom scope string. Free-form
 *  because runners stamp it inconsistently (config.mini / config.size /
 *  manifest.scope_label); the loader resolves it to one canonical string. */
export type QTier = string;

/** Which bench host a run came from. Top-level archive files are CAX11; files
 *  under cax21/ are CAX21. Recorded for provenance only, sigma grouping uses
 *  the config fingerprint, not the host (spec §13.4). */
export type BenchHost = 'cax11' | 'cax21';

/**
 * The subset of a bench-result manifest the scorecard reads. Mirrors
 * `src/benchmark/lib/manifest.ts` `ResultManifest` but kept structurally
 * independent (deserialized JSON, not the live type) so a manifest shape
 * change can't silently break parsing. Only beam/locomo/longmemeval emit one.
 */
export interface ManifestBlock {
  commit_sha?: string;
  fixture_version?: string;
  scorer_version?: string;
  scope_label?: string;
  sample_size?: number;
  /** sha256 over the tracked flag set, a ready-made config fingerprint. */
  env_config_hash?: string;
  env_config_inputs?: Record<string, unknown>;
  model_pins?: { answer?: string; judge?: string; embed?: string };
}

/** A raw per-question record as it appears in a bench JSON `results` array.
 *  Untyped on purpose, each normalizer reads the fields it knows. */
export type RawRecord = Record<string, unknown>;

/**
 * One loaded bench result file, post-parse, pre-normalize. Carries everything
 * the downstream modules need without re-reading the file: provenance, the
 * config + manifest blocks (for fingerprinting), and the raw rows.
 */
export interface BenchFile {
  /** Absolute or repo-relative path as globbed. */
  path: string;
  /** Basename, for compact trace output. */
  filename: string;
  bench: BenchId;
  host: BenchHost;
  /** Resolved 40-char commit (manifest.commit_sha | top-level commit | ''). */
  commit: string;
  /** First 7 chars of `commit`, or the short SHA parsed from the filename. */
  shortCommit: string;
  /** Canonical Q-tier (mini | full | 500k | ...). */
  qtier: QTier;
  /** ISO 8601 run timestamp from the top-level `timestamp` field. */
  timestamp: string;
  /** The bench's top-level `config` block (shape varies per bench). */
  config: Record<string, unknown>;
  /** The manifest block when present (beam/locomo/lme), else null. */
  manifest: ManifestBlock | null;
  /** Top-level `upstream` (clonemem/mab/dialsim), a fixture/dataset version
   *  analog for benches with no manifest. null when absent. */
  upstream: string | null;
  /** The top-level `summary` block when present (for cross-checks). */
  summary: Record<string, unknown> | null;
  /** The per-question rows. */
  rawResults: RawRecord[];
}

/** A file the loader saw but intentionally did not normalize, with the reason.
 *  Surfaced in output so a skipped bench is visible, never silent (spec §8). */
export interface SkippedFile {
  path: string;
  filename: string;
  prefix: string;
  reason: string;
}

export interface LoadResult {
  files: BenchFile[];
  skipped: SkippedFile[];
}

/**
 * The unified per-question record. Every per-question bench normalizes into
 * this single shape so the cross-bench DEEP views (spec §5) can pool by one
 * taxonomy. See `normalize.ts` for the per-bench derivation table.
 */
export interface NormalizedRecord {
  // ---- provenance ----
  bench: BenchId;
  source_file: string;
  host: BenchHost;
  /** Resolved 40-char commit. */
  commit: string;
  qtier: QTier;
  /** Config-fingerprint hash; '' until fingerprint.ts fills it. */
  fingerprint: string;
  /** ISO 8601 run timestamp (for the §12/§14.4 time series). */
  run_timestamp: string;

  // ---- identity / taxonomy ----
  question: string;
  /** sha256(question), stable key for the classifier cache + judge freeze. */
  question_hash: string;
  /**
   * The bench's NATIVE category label, normalized to a string:
   *  beam=ability, clonemem/lme=question_type, locomo=category(int→label),
   *  mab=competency, dialsim=null.
   */
  native_category: string | null;
  /** Recorded engine query_type where the run stored it (sparse: see the
   *  archive reality note in the plan). null when the run didn't record it. */
  query_type_recorded: string | null;
  /** ALWAYS set: classifyQuery(question) from the in-tree classifier. The
   *  single consistent cross-bench taxonomy column (spec §2, §11). */
  query_type_unified: string;
  /** recorded !== unified, only meaningful where recorded !== null. */
  query_type_diverged: boolean;
  /** clonemem (causal..unanswerable) + lme (knowledge-update..); else null. */
  question_type: string | null;
  /** beam only (clear/easy/medium/hard); else null. */
  difficulty: string | null;

  // ---- scoring ----
  /** beam nugget_score (0-1); locomo f1_score; else null. Raw, pre-threshold. */
  score: number | null;
  /** Canonical correctness (see per-bench derivation in normalize.ts). */
  correct: boolean;
  /** Gold-decline question: abstaining is the CORRECT behavior here. */
  should_abstain: boolean;
  /** Engine declined (from gate-log shadow verdict or canonical decline
   *  string). Defaults false when no gate log is supplied. */
  abstained: boolean;
  /** Hallucination: answered AND wrong AND the question was answerable. */
  wrong: boolean;

  // ---- payload (drills / debugging) ----
  predicted: string | null;
  expected: string | null;

  // ---- latency (canonicalized; locomo *_time_ms renamed) ----
  retrieval_ms: number | null;
  total_ms: number | null;
}

// =====================================================================
// Config fingerprint (spec §13.4)
// =====================================================================

/**
 * The inputs that define "same config" for variance grouping. Two runs may be
 * pooled for sigma ONLY when these match (spec §13.4), group-by-commit alone
 * is explicitly wrong because golden-config was not always enforced.
 */
export interface ConfigFingerprint {
  bench: BenchId;
  answer_model: string | null;
  judge_model: string | null;
  /** manifest.env_config_hash when present, else a hash of the available
   *  config-block flag fields. The flag-set identity. */
  flag_hash: string;
  fixture_version: string | null;
  commit: string;
  qtier: QTier;
  /** True when this run is the golden production config (default answer/judge
   *  models, routing and reranker both off). Only golden configs feed the
   *  product scorecard report. Derived, so it is NOT part of the identity hash. */
  is_golden: boolean;
  /** Stable hash over all of the above (the group key). */
  hash: string;
}

// =====================================================================
// Metrics / report (spec §5)
// =====================================================================

/** Core metric bundle for any slice of records. */
export interface CellStats {
  n: number;
  /** answered-and-correct / n. */
  accuracy: number;
  /** abstained / n. */
  abstention_rate: number;
  /** answered-and-wrong-and-answerable / n. */
  wrong_rate: number;
  /** Latency percentiles over non-null values; null when none present. */
  retrieval_ms_p50: number | null;
  retrieval_ms_p95: number | null;
  retrieval_ms_mean: number | null;
  total_ms_p50: number | null;
  total_ms_p95: number | null;
  total_ms_mean: number | null;
}

/** A named cell (a labelled slice) plus its stats. */
export interface NamedCell {
  label: string;
  stats: CellStats;
}

/** Abstention drill counts (spec §5 view 7), generalizing the prototype. */
export interface AbstentionStats {
  /** should_abstain questions in this slice. */
  should_abstain_n: number;
  /** abstained on a should_abstain question (correct decline). */
  abstained_on_decline: number;
  /** abstain_rate over should_abstain questions. */
  decline_recall: number;
  /** abstained a WRONG answer (win). */
  good_catch: number;
  /** abstained a CORRECT answer (cost), over should_abstain + answerable. */
  over_refuse: number;
  /** questions with no gate verdict matched. */
  no_verdict: number;
}

export interface ScorecardReport {
  generated_at: string;
  /** Content hash of the classifier that produced query_type_unified. */
  classifier_hash: string;
  correct_threshold: number;
  total_records: number;
  benches: BenchId[];
  /** BROAD view 1: per-bench overall stats. */
  per_bench: NamedCell[];
  /** BROAD view 2: per (bench × native_category). */
  per_bench_category: NamedCell[];
  /** DEEP view 3: pooled by unified query_type, plus per-bench split. */
  by_query_type: NamedCell[];
  by_query_type_bench: NamedCell[];
  /** DEEP drills 4-6. */
  temporal_drill: NamedCell[];
  multihop_drill: NamedCell[];
  singlehop_drill: NamedCell[];
  /** DEEP view 8: hallucinations by query_type × bench. */
  hallucination_drill: NamedCell[];
  /** DEEP view 9: clonemem question_type. */
  clonemem_question_type: NamedCell[];
  /** DEEP view 7: abstention, overall + per bench. */
  abstention: { overall: AbstentionStats; per_bench: Array<{ bench: BenchId; stats: AbstentionStats }> };
  /** Product targets evaluation (spec §5 TARGETS). */
  targets: TargetEval[];
  /** Taxonomy divergence (recorded vs unified). */
  divergence: DivergenceReport;
  /** Files the loader skipped, surfaced for honesty. */
  skipped: SkippedFile[];
}

export interface TargetEval {
  metric: 'abstention_rate' | 'wrong_rate';
  scope: string;
  value: number;
  threshold: number;
  /** true when within target. Adversarial benches read high, report per-bench
   *  so an adversarial bench never masks the real-distribution read (spec §5). */
  pass: boolean;
}

export interface DivergenceReport {
  /** Per-bench divergence rate among rows that recorded a query_type. */
  per_bench: Array<{
    bench: BenchId;
    n_with_recorded: number;
    n_diverged: number;
    divergence_rate: number;
    /** recorded → unified confusion counts. */
    confusion: Array<{ recorded: string; unified: string; n: number }>;
  }>;
}

// =====================================================================
// Variance (spec §13)
// =====================================================================

/** Per-cell sigma within one config-fingerprint group. */
export interface CellSigma {
  cell: string;
  mean: number;
  sigma: number;
  /** number of same-config runs feeding mean/sigma. */
  n: number;
  /** mean questions in this cell per run. */
  questions_per_run: number;
  /** false when n < MIN_RUNS_FOR_SIGMA, sigma unknown, do not gate. */
  gated: boolean;
}

/** Variance for one (bench, fingerprint, qtier) group. */
export interface FingerprintVariance {
  bench: BenchId;
  fingerprint: string;
  qtier: QTier;
  /** runs in this group. */
  n_runs: number;
  /** overall accuracy mean across the runs. */
  mean_overall: number;
  sigma_overall: number;
  /** mean total questions per run (for the gate's binomial-SE floor). */
  questions_per_run: number;
  gated_overall: boolean;
  per_cell: CellSigma[];
  /** the commits/timestamps that fed this group, for trace. */
  run_refs: Array<{ commit: string; timestamp: string; n: number; accuracy: number }>;
}

/** A (bench, fingerprint, qtier) with too few runs to measure sigma (§13.3). */
export interface NeedsRepeats {
  bench: BenchId;
  fingerprint: string;
  qtier: QTier;
  n_have: number;
  n_needed: number;
  reason: string;
}

/** One point in a per-cell time series (spec §12, §14.4). */
export interface TimeseriesPoint {
  timestamp: string;
  commit: string;
  fingerprint: string;
  n: number;
  accuracy: number;
}

export interface CellTimeseries {
  bench: BenchId;
  cell: string;
  points: TimeseriesPoint[];
  /** Drift slope over the series (pp per run-index); null if too few points. */
  slope: number | null;
  /** A simple significance proxy for the slope (see variance.ts). */
  slope_significant: boolean;
}

export interface VarianceReport {
  generated_at: string;
  classifier_hash: string;
  min_runs_for_sigma: number;
  min_runs_for_judge_sigma: number;
  groups: FingerprintVariance[];
  needs_repeats: NeedsRepeats[];
  timeseries: CellTimeseries[];
}

// =====================================================================
// Baseline + gate (spec §14)
// =====================================================================

export interface BaselineCell {
  mean: number;
  sigma: number;
  n: number;
  /** mean questions per run, feeds the gate's binomial-SE floor. Optional for
   *  back-compat with baselines cut before it was recorded. */
  q_per_run?: number;
  /** false → excluded from gating (n too small). */
  gated: boolean;
}

export interface BaselineEntry {
  bench: BenchId;
  qtier: QTier;
  config_fingerprint: string;
  n_runs: number;
  mean: number;
  sigma_overall: number;
  /** mean total questions per run, feeds the gate's binomial-SE floor. */
  questions_per_run?: number;
  per_cell: Record<string, BaselineCell>;
  last_rebaselined_commit: string;
}

export interface Baseline {
  schema_version: 1;
  generated_at: string;
  /** Which taxonomy this baseline is expressed in. A classifier change
   *  invalidates cross-comparison; the gate warns when hashes differ. */
  classifier_hash: string;
  /** K for the overall mean - K*sigma rule (spec §14.1). */
  K_overall: number;
  /** K for per-cell gating (looser than overall). */
  K_cell: number;
  entries: BaselineEntry[];
}

export interface GateFailure {
  bench: BenchId;
  qtier: QTier;
  cell: string;
  baseline_mean: number;
  sigma: number;
  K: number;
  threshold: number;
  observed: number;
  kind: 'overall' | 'cell';
}

export interface DriftWarning {
  bench: BenchId;
  cell: string;
  slope: number;
  n_points: number;
}

export interface GateResult {
  pass: boolean;
  failures: GateFailure[];
  driftWarnings: DriftWarning[];
  /** cells skipped because their baseline sigma is ungated (n too small). */
  skippedCells: Array<{ bench: BenchId; qtier: QTier; cell: string; reason: string }>;
  /** true when the fresh run's classifier hash differs from the baseline's. */
  classifierMismatch: boolean;
  /**
   * Count of baseline cells actually compared against a fresh record: the
   * overall comparison for each matched (bench, qtier) entry plus each gated
   * per-cell comparison that found a fresh observation. Zero means the baseline
   * matched nothing in the fresh archive, a stale or mismatched baseline (the
   * R29-N1 failure mode), and the caller must hard-fail rather than pass green.
   */
  matchedCells: number;
}

/** Structured error base so callers can distinguish tool errors from bugs. */
export class ScorecardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorecardError';
  }
}
