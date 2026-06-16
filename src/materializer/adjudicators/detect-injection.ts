/**
 * Wedge 3 default adjudicator: thin adapter around the existing
 * src/write/validators.ts detectInjection. Preserves zero behavior change
 * for the accept path; the win is observability + versioning, so W4 can
 * swap in a calibrated model without a migration.
 *
 * Policy label is `v1.detectInjection`. W4 will publish `v2.calibrated`
 * (or similar) and populate AdjudicationResult.score with a 0..1 value.
 * The materializations.adjudication_state column carries both shapes
 * without a column change.
 */

import { detectInjection } from '../../write/validators.js';

import type { AdjudicatorFn, AdjudicationResult } from '../types.js';

export const DEFAULT_POLICY_VERSION = 'v1.detectInjection';

export const detectInjectionAdjudicator: AdjudicatorFn = async (input) => {
  const result = detectInjection(input.rawText);
  if (result.valid) {
    const ok: AdjudicationResult = {
      decision: 'accept',
      policy: DEFAULT_POLICY_VERSION,
      score: null,
      reason_codes: [],
      rule_hits: [],
    };
    return ok;
  }
  const reason = result.reason ?? 'unknown';
  const rej: AdjudicationResult = {
    decision: 'reject',
    policy: DEFAULT_POLICY_VERSION,
    score: null,
    reason_codes: ['prompt_injection'],
    rule_hits: [reason],
  };
  return rej;
};
