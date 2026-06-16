/**
 * S75: bench-side telemetry init helper.
 *
 * Bench runners bypass src/boot.ts (where initStorage normally runs in
 * production). This helper centralizes the init pattern so every bench
 * runner wires telemetry the same way.
 *
 * Pattern locked in S72 Wedge 1.5 Phase 2 fix-up for LOCOMO; S75 extracts
 * it to a shared helper and wires every bench runner (LME, BEAM, DialSim,
 * CloneMem, MAB, FRAME, security, product, calibration) so spans actually
 * persist instead of being dropped from the in-memory ring buffer at
 * process exit.
 *
 * Reads env directly (not config.ts) to avoid the TDZ cycle through
 * dispatch -> retrieval -> embeddings -> config that fires during the
 * benchmark script's top-level import phase.
 *
 * Idempotent: safe to call repeatedly; initStorage handles re-init.
 *
 * Brain #2596 doctrine: TELEMETRY is ALWAYS ON in benches. The 'if'
 * check below guards explicit off-path measurements only.
 */

import { initStorage } from '../../telemetry/index.js';

export function initBenchTelemetry(): void {
  // S75: TELEMETRY_ENABLED defaults true at the config layer, but bench
  // launchers may explicitly set it false for off-path latency probes.
  // Respect explicit off; default everything else to on.
  if (process.env.TELEMETRY_ENABLED === 'false') {
    return;
  }
  const dbPath = process.env.TELEMETRY_DB_PATH || './data/telemetry.db';
  const flushIntervalMs = Number(process.env.TELEMETRY_FLUSH_INTERVAL_MS) || 5000;
  const ringBufferSize = Number(process.env.TELEMETRY_RING_BUFFER_SIZE) || 10000;
  initStorage({
    dbPath,
    enabled: true,
    flushIntervalMs,
    ringBufferSize,
  });
  // stderr so it never contaminates stdout-piped bench output
  console.error(
    `[bench-telemetry] storage initialized: dbPath=${dbPath} flushMs=${flushIntervalMs} ring=${ringBufferSize}`,
  );
}
