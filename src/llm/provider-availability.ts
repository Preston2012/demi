/**
 * W4 Track E: provider-availability layer.
 *
 * Design: docs/internal/WEDGE_4_TRACK_E_PROVIDER_AVAILABILITY_DESIGN.md
 * Packet:  docs/internal/WEDGE_4_TRACK_E_PACKET.md
 *
 * Fixes the single-vendor client-blocker (brain #3019): the hardcoded model
 * chains (TRACK_A_PROVIDER_CHAIN, L3_PROVIDER_CHAIN, FINAL_FALLBACK,
 * FALLBACK_CHAINS) had no awareness of which API keys are actually
 * configured, so a Claude-only deployment broke on every chain that lacked
 * an Anthropic model.
 *
 * This layer detects which providers have keys at runtime and filters every
 * chain down to reachable models. The load-bearing invariant: filtering
 * NEVER yields an empty chain as long as at least one provider key is set
 * (the never-empty invariant). When all keys are present the filter is a
 * strict no-op, so the fully-keyed bench host sees zero behavior change.
 *
 * Runtime health (`isProviderDown` in client.ts) is the orthogonal
 * complement: availability is boot-time key presence, health is in-session
 * failure tracking. Both are kept.
 */

import { getProviderName, type Provider } from './provider-name.js';

export type { Provider } from './provider-name.js';

/** The env var that supplies each provider's API key. */
const PROVIDER_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

/**
 * Default escalation order used as the last-resort fallback when a cell
 * chain filters to empty. Cheapest-first, one model per provider, so a
 * client with any single key still resolves to that provider's model.
 * This is what `FINAL_FALLBACK` resolves to after availability filtering.
 */
export const DEFAULT_ORDER: readonly string[] = [
  'gpt-4.1-mini',
  'claude-haiku-4-5-20251001',
  'gemini-2.5-flash',
  'grok-4-1-fast-non-reasoning',
  'deepseek-chat',
  'mistral-small-latest',
];

let _cache: Set<Provider> | null = null;

/**
 * The set of providers whose API key is configured (non-empty). Memoized:
 * keys do not change within a process. Tests that mutate env must call
 * `resetAvailabilityCache()` first.
 */
export function availableProviders(): Set<Provider> {
  if (_cache) return _cache;
  const s = new Set<Provider>();
  (Object.keys(PROVIDER_ENV) as Provider[]).forEach((p) => {
    const v = process.env[PROVIDER_ENV[p]];
    if (v && v.trim().length > 0) s.add(p);
  });
  _cache = s;
  return s;
}

/** Drop the memoized provider set. For tests only (env changes between cases). */
export function resetAvailabilityCache(): void {
  _cache = null;
}

/** True when the model's provider has a configured key. */
export function isModelAvailable(model: string): boolean {
  return availableProviders().has(getProviderName(model));
}

/**
 * Filter a model chain down to reachable models, preserving order.
 *
 * Never-empty invariant: if filtering removes everything but at least one
 * provider key is configured, fall back to the available members of
 * DEFAULT_ORDER so the caller always has something to call. Returns empty
 * ONLY when zero providers are configured (a hard misconfiguration that
 * boot validation catches separately).
 */
export function filterChain(models: readonly string[]): string[] {
  const filtered = models.filter(isModelAvailable);
  if (filtered.length > 0) return filtered;
  return DEFAULT_ORDER.filter(isModelAvailable);
}
