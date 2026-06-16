/**
 * Product scorecard, JSON emitter (S78, spec §6/§7).
 *
 * Emits the full report as machine-readable JSON (the `--json` flag). The
 * report object is already serializable; this module is the single place that
 * decides the on-the-wire shape, so a baseline consumer has one contract to
 * read.
 */

import type { ScorecardReport, VarianceReport } from './types.js';

export interface ScorecardJson {
  kind: 'demiurge-scorecard';
  schema_version: 1;
  report: ScorecardReport;
  variance?: VarianceReport;
}

export function renderJson(report: ScorecardReport, variance?: VarianceReport): string {
  const out: ScorecardJson = { kind: 'demiurge-scorecard', schema_version: 1, report };
  if (variance) out.variance = variance;
  return JSON.stringify(out, null, 2);
}
