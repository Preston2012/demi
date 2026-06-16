/**
 * W4 Track D: cache-warming policy.
 *
 * Design: docs/internal/WEDGE_4_TRACK_D_WARMING_DESIGN.md
 * Packet:  docs/internal/WEDGE_4_TRACK_D_PACKET.md
 * Depends on: Wedge 3 warmCacheForRecentWindow (src/materializer/warm.ts).
 *
 * This is the policy layer that decides *when* and *which* windows to warm,
 * on top of the W3 warm primitive. The materializer makes cold reads pay an
 * extraction LLM call (165ms p95 cold vs 109ms warm, #2580); warming pre-pays
 * that cost for windows likely to be read so the user-facing read is warm.
 *
 * No new LLM call, no new retrieval path, no schema change: this is a ranking
 * heuristic over access signals plus a scheduler. The brain (selectWindowsToWarm)
 * is pure; the candidate SOURCE is injected (WarmingDeps.gatherCandidates) so
 * the DB-coupling stays out of the unit-testable core. Recency-dominant
 * composite + a hard budget is enough for v1; production telemetry tunes the
 * weights later (Q-D1). Deliberately no eviction-aware logic, no ML ranking.
 *
 * Double-gated: warming is inert unless BOTH WARMING_POLICY_ENABLED and
 * MATERIALIZER_ENABLED are true (warming the materializer cache only matters
 * when the materializer is the read path). Flag-off is byte-identical to today.
 */

import { warmCacheForRecentWindow } from './warm.js';
import type { MaterializeOpts } from './types.js';
import { recordDecision } from '../telemetry/index.js';

export interface WarmingPolicyConfig {
  enabled: boolean;
  trigger: 'on-ingest' | 'periodic' | 'both';
  /** Budget: never warm more than this many windows per cycle (cost control). */
  maxWindowsPerCycle: number;
  /** Only consider windows touched within this span. */
  recencyWindowHours: number;
  /** Frequency floor to qualify a window (a recent miss bypasses this). */
  minAccessCount: number;
  /** For 'periodic' / 'both'. */
  periodicIntervalMs?: number;
}

/**
 * A window the policy may warm, plus the access signals used to rank it.
 * `opts` is the exact MaterializeOpts the warm primitive will run.
 */
export interface WindowCandidate {
  opts: MaterializeOpts;
  /** Epoch ms of the most recent touch (ingest/read) of this window. */
  lastTouchTs: number;
  /** How many times this window has been touched (recency buffer count). */
  touchCount: number;
  /** True when this window recently cold-missed the cache (high-value to warm). */
  recentMiss?: boolean;
}

/**
 * Dependencies the cycle reads from. Injected so warming-policy stays pure and
 * unit-testable; dispatch supplies the real candidate source (its in-memory
 * recent-windows buffer).
 */
export interface WarmingDeps {
  gatherCandidates: () => Promise<WindowCandidate[]> | WindowCandidate[];
}

export interface WarmingCycleResult {
  warmed: number;
  selected?: number;
  skipped?: 'policy-disabled' | 'materializer-disabled' | 'no-candidates';
}

export function loadWarmingConfig(): WarmingPolicyConfig {
  const trigger = (process.env.WARMING_TRIGGER as WarmingPolicyConfig['trigger']) || 'on-ingest';
  return {
    enabled: process.env.WARMING_POLICY_ENABLED === 'true',
    trigger,
    maxWindowsPerCycle: parsePositiveInt(process.env.WARMING_MAX_WINDOWS, 5),
    recencyWindowHours: parsePositiveInt(process.env.WARMING_RECENCY_HOURS, 24),
    minAccessCount: parsePositiveInt(process.env.WARMING_MIN_ACCESS, 2),
    ...(process.env.WARMING_PERIODIC_MS
      ? { periodicIntervalMs: parsePositiveInt(process.env.WARMING_PERIODIC_MS, 300_000) }
      : {}),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when both gates are open. The single source of the double-gate truth. */
function warmingActive(cfg: WarmingPolicyConfig): boolean {
  return cfg.enabled && process.env.MATERIALIZER_ENABLED === 'true';
}

/**
 * Composite score for ranking candidates. Recency-dominant (a user active now
 * reads their recent windows), with a frequency contribution and a strong
 * recent-miss boost (a window being read cold is the highest-value warm target).
 * Higher is warmed first.
 */
function scoreCandidate(c: WindowCandidate, now: number, cfg: WarmingPolicyConfig): number {
  const ageHours = Math.max(0, (now - c.lastTouchTs) / 3_600_000);
  // Linear recency decay across the recency window: 1.0 at now, 0.0 at the edge.
  const recency = Math.max(0, 1 - ageHours / cfg.recencyWindowHours);
  // Frequency, saturating so a single hot window can't dominate the budget.
  const frequency = Math.min(c.touchCount, 10) / 10;
  const missBoost = c.recentMiss ? 1 : 0;
  // Recency dominates; frequency and miss are secondary signals.
  return recency * 1.0 + frequency * 0.5 + missBoost * 0.75;
}

/**
 * Decide which windows to warm right now. Pure ranking over access signals;
 * no LLM, no DB. Filters to the recency window and the min-access floor (a
 * recent miss bypasses the floor), ranks by the composite score, and returns
 * the top `maxWindowsPerCycle` windows' MaterializeOpts. Never returns more
 * than the budget regardless of candidate count.
 */
export function selectWindowsToWarm(
  candidates: WindowCandidate[],
  cfg: WarmingPolicyConfig,
  now: number = Date.now(),
): MaterializeOpts[] {
  const cutoff = now - cfg.recencyWindowHours * 3_600_000;
  const qualified = candidates.filter((c) => {
    if (c.lastTouchTs < cutoff) return false; // outside the recency window
    if (c.recentMiss) return true; // a cold-missed window qualifies regardless
    return c.touchCount >= cfg.minAccessCount;
  });
  qualified.sort((a, b) => scoreCandidate(b, now, cfg) - scoreCandidate(a, now, cfg));
  return qualified.slice(0, cfg.maxWindowsPerCycle).map((c) => c.opts);
}

/**
 * Run one warming cycle (the periodic / batch path). Double-gated. Gathers
 * candidates, selects within budget, makes ONE batched warm call, and records
 * `warming_cycle` telemetry. Fire-and-forget at the call site.
 */
export async function runWarmingCycle(
  deps: WarmingDeps,
  cfg: WarmingPolicyConfig = loadWarmingConfig(),
): Promise<WarmingCycleResult> {
  if (!cfg.enabled) return { warmed: 0, skipped: 'policy-disabled' };
  if (process.env.MATERIALIZER_ENABLED !== 'true') return { warmed: 0, skipped: 'materializer-disabled' };

  const candidates = await deps.gatherCandidates();
  const batch = selectWindowsToWarm(candidates, cfg);
  if (batch.length === 0) return { warmed: 0, skipped: 'no-candidates' };

  const results = await warmCacheForRecentWindow(batch, { concurrency: 2 });
  const warmed = results.filter((r) => r.ok).length;
  recordDecision({
    decision_type: 'warming_cycle',
    branch_taken: 'warmed',
    inputs: { selected: batch.length, warmed, trigger: cfg.trigger },
  });
  return { warmed, selected: batch.length };
}

/**
 * Warm exactly the window that was just ingested (the highest-precision
 * trigger, #2576). Double-gated; inert in 'periodic'-only mode. One batched
 * warm call of size 1. Idempotent: if the ingest already materialized this
 * window the warm is a cache hit (cheap, no re-extract).
 */
export async function warmIngestedWindow(
  window: MaterializeOpts,
  cfg: WarmingPolicyConfig = loadWarmingConfig(),
): Promise<WarmingCycleResult> {
  if (!warmingActive(cfg)) return { warmed: 0, skipped: cfg.enabled ? 'materializer-disabled' : 'policy-disabled' };
  if (cfg.trigger === 'periodic') return { warmed: 0, skipped: 'policy-disabled' };

  const results = await warmCacheForRecentWindow([window], { concurrency: 1 });
  const warmed = results.filter((r) => r.ok).length;
  recordDecision({
    decision_type: 'warming_cycle',
    branch_taken: 'warmed-ingest',
    inputs: { warmed, trigger: 'on-ingest' },
  });
  return { warmed, selected: 1 };
}

/**
 * Start the periodic warming timer when both gates are open and the trigger
 * includes periodic. Returns a cancellable handle (clear it on shutdown), or
 * null when no timer should run. The interval is unref'd so it never keeps the
 * process alive on its own.
 */
export function startPeriodicWarming(
  deps: WarmingDeps,
  cfg: WarmingPolicyConfig = loadWarmingConfig(),
): ReturnType<typeof setInterval> | null {
  if (!warmingActive(cfg)) return null;
  if (cfg.trigger === 'on-ingest') return null;
  const intervalMs = cfg.periodicIntervalMs ?? 300_000;
  const handle = setInterval(() => {
    runWarmingCycle(deps, cfg).catch(() => {
      // Background cycle; errors are captured per-window by the warm primitive.
      // A thrown cycle is swallowed here so the timer keeps running.
    });
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
