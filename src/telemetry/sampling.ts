/**
 * Wedge 1.5 Phase 1: per-event-type sampling configuration.
 *
 * Each event type has a default sample rate in [0, 1]. Operators override
 * per type via TELEMETRY_SAMPLING_<EVENT>=<rate> env vars.
 *
 * TELEMETRY_FULL=true overrides all rates to 1.0 (full capture, slow,
 * intended for debugging only).
 *
 * Slow operations (>10ms SQL, >2s LLM, >5s end-to-end) get sampled at
 * rate 1.0 regardless of the type-level rate. The shouldSample function
 * handles this override via an explicit `force` flag.
 */

import type { SamplingDecision } from './types.js';

/** Default sampling rates per event type. */
export const DEFAULT_SAMPLING: Record<string, number> = {
  // Always-record events (low volume, high signal)
  trace: 1.0,
  span: 1.0,
  llm_call: 1.0,
  decision: 1.0,
  refusal: 1.0,
  conflict: 1.0,
  auth_event: 1.0,
  rate_limit_event: 1.0,
  error: 1.0,
  deprecation: 1.0,
  sql_write: 1.0,
  slow_query: 1.0,
  // B1a: retrieval/injection events feed the weight tuner. Default to
  // full capture because the analyzer needs per-conversation joins;
  // downsampling here would force a much longer accrual window.
  retrieval: 1.0,
  injection: 1.0,

  // Sampled events (high volume)
  embedding_call: 0.1,
  sql_select: 0.01,
  cache_event: 0.01,
  body_capture: 0.01,
};

/** Names of event kinds whose slow paths always sample at 1.0. */
const SLOW_PATH_OVERRIDES = new Set(['sql_select', 'sql_write', 'embedding_call', 'llm_call']);

/**
 * Read an env override for a specific event type. Returns null if no
 * override is set, otherwise the parsed rate in [0, 1].
 */
function readEnvOverride(eventType: string): number | null {
  const envKey = `TELEMETRY_SAMPLING_${eventType.toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw === undefined) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

/** Is TELEMETRY_FULL set? Forces all rates to 1.0. */
function isFullCapture(): boolean {
  const raw = process.env.TELEMETRY_FULL;
  return raw === 'true' || raw === '1';
}

/**
 * Determine the effective sample rate for an event type.
 *
 * Priority order:
 *   1. TELEMETRY_FULL=true → 1.0
 *   2. TELEMETRY_SAMPLING_<EVENT>=<rate> → override
 *   3. DEFAULT_SAMPLING[eventType] → default
 *   4. 1.0 (record by default if unknown)
 */
export function getSampleRate(eventType: string): number {
  if (isFullCapture()) return 1.0;
  const envOverride = readEnvOverride(eventType);
  if (envOverride !== null) return envOverride;
  return DEFAULT_SAMPLING[eventType] ?? 1.0;
}

/**
 * Decide whether to sample a given event.
 *
 * @param eventType - the event kind (e.g. 'sql_select', 'llm_call')
 * @param opts.force - if true, sample at 1.0 regardless of type rate
 *   (used for slow-path overrides)
 * @param opts.isSlow - if true and eventType is in SLOW_PATH_OVERRIDES,
 *   sample at 1.0
 */
export function shouldSample(eventType: string, opts: { force?: boolean; isSlow?: boolean } = {}): SamplingDecision {
  if (opts.force) {
    return { sampled: true, rate: 1.0, reason: 'forced' };
  }
  if (opts.isSlow && SLOW_PATH_OVERRIDES.has(eventType)) {
    return { sampled: true, rate: 1.0, reason: 'slow-path-override' };
  }
  const rate = getSampleRate(eventType);
  if (rate >= 1.0) {
    return { sampled: true, rate, reason: 'always-sample' };
  }
  if (rate <= 0) {
    return { sampled: false, rate, reason: 'never-sample' };
  }
  // Deterministic pseudo-random based on per-call Math.random.
  // Acceptable for sampling: we don't need cryptographic randomness.
  const sampled = Math.random() < rate;
  return { sampled, rate, reason: sampled ? 'sampled' : 'not-sampled' };
}
