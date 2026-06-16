/**
 * Centralized bench-mode detection.
 *
 * A2 (S71): canonical name is BENCH_MODE. TEST_MODE remains as a deprecated
 * alias for back-compat; setting either is accepted, but BENCH_MODE is the
 * documented primitive going forward. Rationale: TEST_MODE was historically
 * overloaded ("am I in a test environment?" vs "am I running a benchmark?").
 * BENCH_MODE makes intent explicit and matches the controlled bench-config
 * primitive naming (BENCH_SKIP_CIRCUIT_BREAKER).
 *
 * BENCH_MODE is bench-mode: replaces SKIP_WRITE_VALIDATION (legacy),
 * skips consensus, and bypasses non-temporal-conflict quarantine for
 * USER-source writes during benchmark seeding.
 *
 * Dedup is NEVER skipped. Period. S75 lock (brain #2594): the
 * BENCH_SKIP_DEDUP primitive is REMOVED. Every bench, every fixture,
 * every commit runs dedup the same way production does. If a bench
 * fixture collides at cosine 0.95, the FIXTURE is wrong - rebuild it
 * with rejection sampling (see src/benchmark/cross-session-temporal/bake.ts
 * for the canonical pattern). The runtime escape made bench scores lie
 * for multiple months (brain #2123 dedup truth table) and re-introduced
 * the same cheat shape after the S65 council reconciliation. The flag
 * is gone. No per-bench tuning. One config. One doctrine.
 *
 * Production-blocked: write/index.ts:109 throws if BENCH_MODE=true OR
 * TEST_MODE=true while NODE_ENV=production.
 *
 * Background: TEST_MODE bypasses were originally scattered across
 * multiple call sites (trust-branch.ts:200, trust-branch.ts:231,
 * write/index.ts:118, write/index.ts:165) which led to S59A bug:
 * a new slow path (consensus on LLM-source-with-conflicts) silently
 * fired during benches because no one remembered to add a TEST_MODE
 * guard. Centralizing here means the next slow-path addition is one
 * call to isBenchMode() and the lesson is encoded in the helper name.
 *
 * BENCH_KEEP_DEDUP was REMOVED in S65 council reconciliation.
 * BENCH_SKIP_DEDUP is REMOVED in S75 (this lock). Dedup is unconditional.
 */

/**
 * True if benchmark mode is enabled.
 *
 * Accepts BENCH_MODE (canonical) or TEST_MODE (deprecated alias).
 * Used to bypass slow paths (consensus, etc.) during benchmarks.
 * Production-blocked separately at write/index.ts boot.
 *
 * @returns true if either BENCH_MODE='true' or TEST_MODE='true' is set.
 */
export function isBenchMode(): boolean {
  return process.env.BENCH_MODE === 'true' || process.env.TEST_MODE === 'true';
}

/**
 * Deprecated alias for {@link isBenchMode}.
 *
 * @deprecated Use {@link isBenchMode} instead. Kept for back-compat with
 * existing callers in trust-branch.ts and elsewhere. Will be removed
 * once all internal callers migrate. External code (scripts, tests)
 * may continue to set the TEST_MODE env var indefinitely.
 */
export function isTestMode(): boolean {
  return isBenchMode();
}

/**
 * Returns which env var(s) triggered bench-mode, for logging/diagnostics.
 *
 * @returns Array of env var names that are set to 'true'. Empty if neither.
 */
export function benchModeSources(): string[] {
  const out: string[] = [];
  if (process.env.BENCH_MODE === 'true') out.push('BENCH_MODE');
  if (process.env.TEST_MODE === 'true') out.push('TEST_MODE');
  return out;
}

/**
 * S75: BENCH_SKIP_DEDUP is REMOVED. This function is retained as a
 * compile-time guard that throws if anything still calls it - this catches
 * stale callers in PRs before they merge. Delete the function entirely
 * once no callers remain anywhere in the tree.
 *
 * Detection at boot: src/write/index.ts also throws if BENCH_SKIP_DEDUP
 * is set in process.env, which catches shell invocations.
 */
export function isBenchSkipDedup(): boolean {
  throw new Error(
    'isBenchSkipDedup() was REMOVED in S75. Dedup is unconditional on every bench. ' +
      'If a bench fixture collides at cosine 0.95, rebuild it with rejection sampling. ' +
      'See src/benchmark/cross-session-temporal/bake.ts for the canonical pattern.',
  );
}
