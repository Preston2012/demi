/**
 * S74 SHELVED FEATURES GUARD
 *
 * Four feature flags were benchmarked stacked on the S74 merge and found
 * to be net-negative or feature-specific wins masked by feature-specific
 * losses (instruction_following collapse -25 to -33pp on stacked combos).
 *
 * Decision: SHELVE until Wedge 4 (calibrated Adjudicator) introduces
 * per-query-type gating. The flags are not bugs - they are features that
 * need routing, not global on/off switches.
 *
 * Empirical evidence: docs/internal/SHELVED_FEATURES_S74.md
 *
 * Shipping baseline: BS1 stacked defaults (all 4 flags OFF).
 *   - BEAM 100K mini: 50.3 pct (+2.45pp over locked baseline)
 *   - LOCOMO mini: 55.7 pct (+8.4pp over locked baseline)
 *
 * Activating any of these flags in production WITHOUT explicit override
 * via DEMIURGE_ALLOW_SHELVED_FEATURES=true causes a fatal startup error.
 * This is intentional. Another assistant session forgetting the shelf
 * decision and re-enabling one of these flags would silently regress
 * the benchmarks we just locked. The guard makes that impossible without
 * a deliberate override action.
 */

import { createLogger } from './config.js';

const log = createLogger('shelf-guard');

export const SHELVED_FLAGS = [
  'RERANKER_ENABLED',
  'PLAN_EXECUTOR_ENABLED',
  'BINARY_VECTOR_RECALL',
  'QUERY_REWRITE_ENABLED',
] as const;

export type ShelvedFlag = (typeof SHELVED_FLAGS)[number];

/**
 * Check if any shelved feature flag is set to 'true' without the explicit
 * override. Returns the list of violating flags (empty if all clean).
 *
 * Bench harnesses set DEMIURGE_ALLOW_SHELVED_FEATURES=true to opt out
 * (they intentionally toggle these for measurement). Production code path
 * MUST NOT set the override.
 */
export function detectShelvedFlagsEnabled(): ShelvedFlag[] {
  const override = process.env.DEMIURGE_ALLOW_SHELVED_FEATURES === 'true';
  if (override) return [];

  const violations: ShelvedFlag[] = [];
  for (const flag of SHELVED_FLAGS) {
    if (process.env[flag] === 'true') {
      violations.push(flag);
    }
  }
  return violations;
}

/**
 * Throw if any shelved flag is on without the override. Call once at
 * dispatch boot or first request handling. Idempotent.
 */
export function assertShelvedFlagsDisabled(): void {
  const violations = detectShelvedFlagsEnabled();
  if (violations.length === 0) return;

  const list = violations.join(', ');
  const msg =
    'SHELVED FEATURE FLAGS ENABLED: ' +
    list +
    '. ' +
    'These features were shelved S74 pending Wedge 4 per-query-type gating ' +
    '(see docs/internal/SHELVED_FEATURES_S74.md). ' +
    'Enabling them in production silently regresses the locked baseline. ' +
    'If this is a benchmark or experiment that intentionally toggles them, ' +
    'set DEMIURGE_ALLOW_SHELVED_FEATURES=true. Otherwise, unset the flag.';
  log.error({ violations }, msg);
  throw new Error(msg);
}

/**
 * Soft warning version - for surfaces where throwing would break callers
 * unrelated to the flag (e.g. a single retrieval call). Logs ERROR-level
 * but does not abort.
 */
export function warnShelvedFlagsEnabled(): ShelvedFlag[] {
  const violations = detectShelvedFlagsEnabled();
  if (violations.length === 0) return violations;
  log.error(
    { violations, hint: 'set DEMIURGE_ALLOW_SHELVED_FEATURES=true for benches' },
    'SHELVED FEATURE FLAG ENABLED (shelved S74, see docs/internal/SHELVED_FEATURES_S74.md)',
  );
  return violations;
}
