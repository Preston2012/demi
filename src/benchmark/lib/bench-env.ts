/**
 * Bench env preamble.
 *
 * Why this exists: LOCOMO/BEAM/LME runners read state from process.env.
 * .env on CAX11 sets ANSWER_ROUTING=true, BI_TEMPORAL_ENABLED=true,
 * STONE_*=true.
 * If a runner doesn't override, it inherits whatever .env wants, which
 * silently changes per-bench behavior and breaks comparability.
 *
 * History of bugs this prevents (S59A):
 *   PR #36: TEST_MODE missing → consensus fired 1300 times → ~$10 + 75min wasted
 *   PR #38: maxRules/answer-model defaulted wrong → would have run with haiku
 *   PR #40: ANSWER_ROUTING=true leaked from .env → Grok hit on every multi-hop
 *           query → 5x wall + extra ~$3 in API spend per run
 *
 * This module sets a DETERMINISTIC default env for each bench. Runners
 * call ensureBenchEnv(benchName) at top of main(). Per-bench overrides
 * via CLI flags (--routed, --no-rerank, etc.) flip the locked defaults
 * AFTER they've been set, so the user can opt in. The default state is
 * always honest.
 *
 * Brain memory references:
 *   #2015: LOCOMO unrouted iteration mode (S58 lock)
 *   #1559: BEAM mini iteration profile
 *   #464:  LME routed = +18pts vs unrouted
 *   #2030: TEST_MODE missing burn
 *   #2032: pre-flight checklist (this module is the structural fix)
 */

export type BenchName =
  | 'locomo'
  | 'beam'
  | 'lme'
  | 'clonemem'
  | 'mab'
  | 'dialsim'
  | 'frame'
  | 'vault'
  | 'product'
  | 'paraphrase'
  | 'ece_brier'
  // S68 tier-3 customs (per-failure-mode regression tests for Sprint 2 work)
  | 'correction-propagation'
  | 'cross-session-temporal'
  | 'intent-ambiguity'
  | 'multi-hop-chain'
  | 'skin-persona'
  | 'cold-warm';

interface BenchEnvDefaults {
  /** Always required for every bench. Skips consensus + write validation. */
  TEST_MODE: 'true';
  /** Disable STONE for benches, it's a write-path log, not retrieval. */
  STONE_ENABLED: 'false'; /** Routing default. LOCOMO=off (iter-mode), LME=on (+18pts), BEAM=off (mini). */
  ANSWER_ROUTING: 'true' | 'false';
  /** Bi-temporal supersede. Per #1860 has known historical-query over-filter
   *  bug. Currently safe ON for current-state queries; LOCOMO mostly affected
   *  via temporal-multi-hop. Keep ON for consistency with May 6 baseline. */
  BI_TEMPORAL_ENABLED: 'true' | 'false';
  // S75 (brain #2594): BENCH_SKIP_DEDUP REMOVED. Dedup is unconditional on
  // every bench. Synthetic-collision fixtures must be rebuilt with rejection
  // sampling. See src/benchmark/cross-session-temporal/bake.ts for the pattern.
  /** Skip activity-tracking circuit breaker. Required for any bench that
   *  simulates historical timestamps (DialSim asked_at=1995, stale-memory
   *  Wikidata revision dates). Default 'true' for all benches; production
   *  guard in src/core/dispatch.ts:255 blocks NODE_ENV=production. Brain
   *  #1926, #1928, #2035: this was missing from DialSim profile and caused
   *  S59A unrouted batch to score 0/51 (circuit-breaker LOCKED, no work). */
  BENCH_SKIP_CIRCUIT_BREAKER: 'true' | 'false';
  /** Telemetry: ALWAYS ON in S75+. Wedge 4 needs labeled run data
   *  (per-cell decisions, calibration outcomes) and tonight's LME
   *  bisect would have been one telemetry query if we had history.
   *  Storage growth handled via /opt/demiurge-telemetry-archive
   *  daily cron: snapshot+scp to Baseline, R2 push, prune live DB
   *  rows >7d. Brain #2596 doctrine lock. */
  TELEMETRY_ENABLED: 'true';
  /** Wedge 3 Materializer (S76+). Default OFF on every bench profile so the
   *  W3 PR lands without bench behavior change. Flipping to 'true' is a
   *  follow-up step that gates on the §7 lock criteria (cold-read p95 ≤
   *  165ms, cache-hit p95 < 5ms, no >1pp overall regression, no >3pp
   *  category regression, ≥2 of 6 wins). */
  MATERIALIZER_ENABLED: 'true' | 'false';
  /** W4 Track A: pair-gate that lets a bench opt STONE in only for the
   *  purpose of running the materializer. Without this gate, the brain
   *  #2090 doctrine ("STONE off by default in benches") would force every
   *  materializer-aware bench to also opt every other STONE-dependent
   *  feature in. Bench runners construct StoneStore iff both this and
   *  MATERIALIZER_ENABLED are 'true'. Default 'false' on every profile. */
  STONE_ENABLED_FOR_MATERIALIZER: 'true' | 'false';
  /** W4 Track A calibrated adjudicator (S76+). Default OFF; flipping to
   *  'true' selects the Stage 1 LLM teacher in place of the W3 default
   *  detectInjection wrapper. Lock criteria for the flip live in the
   *  W4 Track A design doc §8. */
  CALIBRATED_ADJUDICATOR_ENABLED: 'true' | 'false';
  /** W4.5 Vault master switch. All four other vault flags require this
   *  AND a bound provider; bench profiles default OFF so the wedge ships
   *  dark. See docs/internal/WEDGE_4_5_VAULT_DESIGN.md §9. */
  VAULT_ENABLED: 'true' | 'false';
  /** W4.5 SQLCipher DB-level encryption (memory + telemetry + cache). */
  VAULT_DB_ENCRYPTION_ENABLED: 'true' | 'false';
  /** W4.5 Position 1: materializer-side secret detection + encrypt. */
  VAULT_EXTRACTION_DETECTION_ENABLED: 'true' | 'false';
  /** W4.5 Position 2: inject-side second-pass scan + on-the-fly redact. */
  VAULT_INJECTION_DETECTION_ENABLED: 'true' | 'false';
  /** W4.5 key-material source: file (default), env, or kms (stub). */
  VAULT_KEY_SOURCE: 'file' | 'env' | 'kms';
}

const PROFILES: Record<BenchName, BenchEnvDefaults> = {
  locomo: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false', // S58 #2015: unrouted is iteration default. Routed delta is -1.4pp
    // (within 5.4% Wilson noise on 296Q) but adds ~16min wall + Grok bill.
    // Override via launcher flag --routed for publish-time runs only.
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  beam: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false', // Mini iteration #1559: simple model. Full BEAM 400Q has historically
    // run routed for the published numbers; override via --routed.
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  lme: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false', // S59A: routing OFF for iteration mode (consistent with all other
    // benches). Routing earns +12pp on LME (#464: 72% routed vs 54%
    // unrouted), opt back IN with --routed for publish-time runs.
    // Production (MyKonos) keeps routing ON via runtime config, not
    // bench profile. Bench-env is for iteration only.
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  // Default profile for benches without specific tuning. Conservative:
  // routing off (cheaper iteration), TEST_MODE on. Override per-bench
  // when iteration patterns are documented in brain.
  clonemem: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  mab: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  dialsim: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  frame: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  vault: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  product: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  // QA-style product benches. Routing-OFF iteration default per S59A.
  // R31 batch ran with --routed but the flag was a no-op for paraphrase
  // and ece_brier (parsed but never set process.env.ANSWER_ROUTING). The
  // routed numbers in brain therefore reflect whatever .env had at runtime
  // (true), not the explicit flag. Pinning routing-OFF here for honest
  // iteration; --routed CLI flag opts in for publish-time runs.
  paraphrase: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  ece_brier: {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  // ===========================================================================
  // S68 tier-3 customs. Class-2 datasets (pre-shaped facts via direct addMemory
  // or repo.insert per CHEAT_LOG.md). These benches are isolation tests for
  // specific Sprint 2 failure modes:
  //   correction-propagation -> Plan 2.5b regression test (current/historical/change/list)
  //   cross-session-temporal -> aggregation, event ordering, temporal arithmetic
  //   intent-ambiguity       -> abstention failures, missing-coverage refusals
  //   multi-hop-chain        -> multi-hop counting, evidence-chain coverage
  //   skin-persona           -> attribution confusion (persona keyword leak)
  //   cold-warm              -> import-mode write path + warm vs cold provenance
  // All routing-OFF for iteration consistency.
  // ===========================================================================
  'correction-propagation': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  'cross-session-temporal': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    // S68 v2 doctrine: dedup ON, matching production. The previous v1
    // generator used 10 themes x 1 sentence template ("I had a meeting with
    // X about Y") with small word pools (10 PEOPLE x 6 TOPICS = 60 unique
    // work claims). At full scale 350+ facts collided at cosine >=0.95
    // requiring BENCH_SKIP_DEDUP=true (brain #2186). v2: bake.ts produces a
    // committed fixture with embedding-aware rejection sampling (cosine
    // < 0.92, 0.03 margin under engine dedup 0.95). Re-bake on template or
    // BGE model changes: npx tsx src/benchmark/cross-session-temporal/bake.ts
    // --mode {mini,full}.
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  'intent-ambiguity': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  'multi-hop-chain': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  'skin-persona': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
  'cold-warm': {
    TEST_MODE: 'true',
    STONE_ENABLED: 'false',
    ANSWER_ROUTING: 'false',
    BI_TEMPORAL_ENABLED: 'true',
    BENCH_SKIP_CIRCUIT_BREAKER: 'true',
    TELEMETRY_ENABLED: 'true',
    MATERIALIZER_ENABLED: 'false',
    STONE_ENABLED_FOR_MATERIALIZER: 'false',
    CALIBRATED_ADJUDICATOR_ENABLED: 'false',
    VAULT_ENABLED: 'false',
    VAULT_DB_ENCRYPTION_ENABLED: 'false',
    VAULT_EXTRACTION_DETECTION_ENABLED: 'false',
    VAULT_INJECTION_DETECTION_ENABLED: 'false',
    VAULT_KEY_SOURCE: 'file',
  },
};

/**
 * Set deterministic bench-mode defaults on process.env. Logs every override
 * to stderr so the user can see what was actually applied.
 *
 * IMPORTANT: This OVERRIDES whatever .env or shell sets for these vars.
 * That is intentional, .env is for production runtime; benches need an
 * isolated, deterministic env. To opt out of a specific override, pass
 * the env var on the command line AFTER the runner starts (e.g. via
 * `--routed` flag in the runner, which sets process.env.ANSWER_ROUTING
 * = 'true' explicitly after this function runs).
 *
 * @param bench identifier matching a profile in PROFILES
 * @returns the profile that was applied (for the runner's banner output)
 */
export function ensureBenchEnv(bench: BenchName): BenchEnvDefaults {
  const profile = PROFILES[bench];
  if (!profile) throw new Error(`No bench profile for: ${bench}. Add one to scripts/lib/bench-env.ts`);
  const overrides: string[] = [];
  for (const [k, v] of Object.entries(profile)) {
    const prior = process.env[k];
    if (prior !== v) {
      overrides.push(`  ${k}: ${prior ?? '(unset)'} -> ${v}`);
    }
    process.env[k] = v;
  }
  if (overrides.length > 0) {
    console.error(`[bench-env] applied ${bench} profile (overrides from .env or shell):`);
    for (const o of overrides) console.error(o);
  } else {
    console.error(`[bench-env] applied ${bench} profile (no overrides needed)`);
  }
  // S78: routing force-disabled in ALL benches, no override (Preston).
  process.env.ANSWER_ROUTING = 'false';
  return profile;
}

/**
 * Verify that effective env matches the bench profile.
 * Returns list of mismatches. Empty list = clean.
 *
 * Used by tests + pre-bench-gate to audit launcher state.
 */
export function auditBenchEnv(bench: BenchName): string[] {
  const profile = PROFILES[bench];
  if (!profile) return [`No profile for bench: ${bench}`];
  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(profile)) {
    const actual = process.env[k];
    if (actual !== v) {
      mismatches.push(`${k}: expected '${v}' got '${actual ?? '(unset)'}'`);
    }
  }
  return mismatches;
}

/**
 * Public read-only access to the profile for a given bench (for tests + tooling).
 */
export function getBenchProfile(bench: BenchName): BenchEnvDefaults {
  const p = PROFILES[bench];
  if (!p) throw new Error(`No bench profile for: ${bench}`);
  return { ...p };
}
