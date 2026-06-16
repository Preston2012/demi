/**
 * Product scorecard, public surface (S78).
 *
 * The scorecard reads committed benchmark result JSONs and emits a BROAD +
 * DEEP product report, a measured variance layer, and an unskippable
 * anti-regression gate. See docs/internal/SCORECARD_CC_PACKET.md.
 */

export * from './types.js';
export { loadArchive, loadOne } from './loader.js';
export { normalize, normalizeAll, recomputeWrong, type NormalizeOptions } from './normalize.js';
export { fingerprint, groupFilesByFingerprint } from './fingerprint.js';
export {
  classifyAll,
  classifierHash,
  buildDivergenceReport,
  isTemporal,
  isMultiHop,
  isSingleHop,
  temporalSub,
  type ClassifyOptions,
  type ClassifyResult,
} from './taxonomy.js';
export {
  applyAbstention,
  looksLikeDecline,
  loadGateVerdicts,
  type AbstentionApplyOptions,
  type AbstentionApplyResult,
} from './abstention.js';
export {
  cellStats,
  abstentionStats,
  computeReport,
  ABSTENTION_TARGET,
  WRONG_TARGET,
  type ComputeReportOptions,
} from './metrics.js';
export {
  renderMarkdown,
  renderVarianceMarkdown,
  renderCellAnalysisMarkdown,
  renderRegressionScanMarkdown,
} from './render-markdown.js';
export { renderJson, type ScorecardJson } from './render-json.js';
export {
  analyzeCell,
  scanRegressions,
  verdictClass,
  type CellAnalysis,
  type CellRunPoint,
  type SameConfigGroup,
} from './analysis.js';
export { buildRecords, selectLatestRuns, type BuildOptions, type BuildResult } from './pipeline.js';
export {
  computeVariance,
  driftSlope,
  MIN_RUNS_FOR_SIGMA,
  MIN_RUNS_FOR_JUDGE_SIGMA,
  type ComputeVarianceOptions,
} from './variance.js';
export {
  buildBaseline,
  loadBaseline,
  writeBaseline,
  summarizeBaseline,
  type BuildBaselineOptions,
  type BuildBaselineResult,
} from './baseline.js';
export { evaluateGate, formatGateResult, type EvaluateGateOptions } from './gate.js';
