import { join } from 'node:path';

import type { FinalScoredCandidate } from './scorer.js';
import { createLogger } from '../config.js';

const log = createLogger('thompson-shadow');

/**
 * Thompson Sampling shadow mode.
 *
 * V1 behavior:
 * - Every retrieval, sample from Beta(alpha, beta) per candidate
 * - Re-rank by sampled values
 * - Log both rankings (deterministic vs Thompson) to JSONL file
 * - Does NOT affect production output
 *
 * V1 priors: all candidates start at Beta(1, 1) = uniform
 * Once real usage data exists (which memories were useful), priors update.
 * Thompson production promotion trigger: replay evidence shows Thompson
 * beats deterministic across 1K+ retrievals.
 *
 * Shadow log format (JSONL):
 * {
 *   timestamp: string,
 *   query: string,
 *   deterministicRanking: [{ id, score }],
 *   thompsonRanking: [{ id, sampledScore }],
 *   betaParams: { [memoryId]: { alpha, beta } }
 * }
 */

export interface ThompsonShadowEntry {
  timestamp: string;
  query: string;
  deterministicRanking: { id: string; score: number }[];
  thompsonRanking: { id: string; sampledScore: number }[];
  betaParams: Record<string, { alpha: number; beta: number }>;
}

// In-memory beta params (reset on restart, that's fine for shadow mode)
const betaParams = new Map<string, { alpha: number; beta: number }>();

function getBetaParams(memoryId: string): { alpha: number; beta: number } {
  let params = betaParams.get(memoryId);
  if (!params) {
    params = { alpha: 1, beta: 1 };
    betaParams.set(memoryId, params);
  }
  return params;
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia and Tsang's method.
 * Works for shape >= 1. For shape < 1, uses Ahrens-Dieter boost.
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const boost = Math.pow(Math.random(), 1 / shape);
    return boost * sampleGamma(shape + 1);
  }

  // Marsaglia and Tsang's method for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;

    do {
      // Standard normal via Box-Muller
      const u1 = Math.random();
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    // Squeeze test
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Sample from Beta(alpha, beta) via gamma variates.
 * X ~ Gamma(alpha, 1), Y ~ Gamma(beta, 1), then X/(X+Y) ~ Beta(alpha, beta).
 * No iteration limit needed. Gamma sampler converges in all parameter regimes.
 */
function sampleBeta(alpha: number, beta: number): number {
  if (alpha === 1 && beta === 1) return Math.random();

  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;

  if (sum === 0) return alpha / (alpha + beta); // Degenerate case
  return x / sum;
}

/**
 * Generate Thompson Sampling ranking for comparison with deterministic.
 * Returns the Thompson-ranked list (does not affect production).
 */
export function generateThompsonRanking(
  candidates: FinalScoredCandidate[],
): { id: string; sampledScore: number }[] {
  const sampled = candidates.map((c) => {
    const params = getBetaParams(c.id);
    return {
      id: c.id,
      sampledScore: sampleBeta(params.alpha, params.beta),
    };
  });

  sampled.sort((a, b) => b.sampledScore - a.sampledScore);
  return sampled;
}

/**
 * In-memory ring buffer for shadow log entries.
 * Flushes to disk asynchronously. Never blocks the read hot path.
 */
const SHADOW_BUFFER_MAX = 100;
const SHADOW_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB cap
const shadowBuffer: string[] = [];
let flushScheduled = false;
let logDirInitialized = false;

async function flushShadowBuffer(logDir: string): Promise<void> {
  if (shadowBuffer.length === 0) return;

  const lines = shadowBuffer.splice(0, shadowBuffer.length);
  const logPath = join(logDir, 'thompson-shadow.jsonl');

  try {
    if (!logDirInitialized) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(logDir, { recursive: true });
      logDirInitialized = true;
    }

    const { appendFile, stat } = await import('node:fs/promises');

    // Check file size before writing
    try {
      const stats = await stat(logPath);
      if (stats.size >= SHADOW_FILE_MAX_BYTES) {
        // Rotate: rename current to .bak, start fresh
        const { rename } = await import('node:fs/promises');
        await rename(logPath, logPath + '.bak');
      }
    } catch {
      // File doesn't exist yet, fine
    }

    await appendFile(logPath, lines.join('\n') + '\n', 'utf-8');
  } catch (err) {
    log.warn({ err }, 'Thompson shadow flush failed');
  } finally {
    flushScheduled = false;
  }
}

function scheduleFlush(logDir: string): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // Flush on next tick, outside the retrieval hot path
  setImmediate(() => flushShadowBuffer(logDir));
}

export function logShadowComparison(
  query: string,
  deterministicRanking: FinalScoredCandidate[],
  logDir: string,
): void {
  try {
    const thompsonRanking = generateThompsonRanking(deterministicRanking);

    const params: Record<string, { alpha: number; beta: number }> = {};
    for (const c of deterministicRanking) {
      params[c.id] = getBetaParams(c.id);
    }

    const entry: ThompsonShadowEntry = {
      timestamp: new Date().toISOString(),
      query,
      deterministicRanking: deterministicRanking.map((c) => ({
        id: c.id,
        score: c.finalScore,
      })),
      thompsonRanking,
      betaParams: params,
    };

    shadowBuffer.push(JSON.stringify(entry));

    // Flush when buffer is full or schedule deferred flush
    if (shadowBuffer.length >= SHADOW_BUFFER_MAX) {
      setImmediate(() => flushShadowBuffer(logDir));
    } else {
      scheduleFlush(logDir);
    }
  } catch (err) {
    log.warn({ err }, 'Thompson shadow logging failed');
  }
}

/**
 * Force flush remaining buffer. Call during graceful shutdown.
 */
export async function flushShadowLog(logDir: string): Promise<void> {
  await flushShadowBuffer(logDir);
}

/**
 * Update beta params based on feedback signal.
 * Positive: user confirmed/used the memory → increment alpha.
 * Negative: user rejected/ignored → increment beta.
 *
 * V1: This function exists but is not called automatically.
 * Learn layer v1.1 will wire feedback signals to this.
 */
export function updateBetaParams(
  memoryId: string,
  positive: boolean,
): void {
  const params = getBetaParams(memoryId);
  if (positive) {
    params.alpha += 1;
  } else {
    params.beta += 1;
  }
  betaParams.set(memoryId, params);
}

/**
 * Reset all beta params. For testing only.
 */
export function resetBetaParams(): void {
  betaParams.clear();
}
