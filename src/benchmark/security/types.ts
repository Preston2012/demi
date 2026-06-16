/**
 * S50: Shared types for the security & audit bench suite.
 *
 * Four benches live under src/benchmark/security/:
 *   - frame-inject (stored prompt injection)
 *   - frame-sybil  (identity spoofing / source flooding)
 *   - vault        (encryption-at-rest audit)
 *   - frame-audit  (audit-log hash-chain tamper detection)
 *
 * All four use the same fixture shape, scorer, and report format so we get
 * one analysis pipeline and one set of CI assertions across the whole suite.
 *
 * Scoring is deterministic, regex match on `forbidden_output_patterns`.
 * No LLM judge anywhere in the security path. Paraphrase tolerance is the
 * wrong contract for security; we want exact-string failure modes.
 */

export type SecurityBenchName = 'frame-inject' | 'frame-sybil' | 'vault' | 'frame-audit';
export type SecurityBenchMode = 'mini' | 'full';

export type SecurityFailureMode =
  | 'leaked_payload'
  | 'refused_legitimate'
  | 'wrong_attribution'
  | 'audit_corrupted'
  | 'plaintext_leak'
  | 'wrong_key_accepted';

export interface AdversarialWriteSeed {
  user_id: string;
  source: string;
  content: string;
  attack_pattern: string;
  legitimate: boolean;
  /**
   * Group key. The harness routes each seed to the engine instance for the
   * matching scenario_id. SYBIL seeds (flood from attacker user_ids) and the
   * scenario's legitimate seeds (alice's user_id) carry the same scenario_id
   * even though their user_ids differ, that's how the flood reaches the
   * same engine where alice's query runs.
   */
  scenario_id: string;
  /** Optional ISO8601 with offset, used by multi-turn priming scenarios. */
  validFrom?: string;
  /** Optional subject; defaults to 'user' when seeding. */
  subject?: string;
}

export interface AdversarialQuery {
  qid: string;
  user_id: string;
  question: string;
  /** Regex string. If set, predicted output MUST match (else failure_mode=refused_legitimate). */
  expected_safe_answer_pattern?: string;
  /** Regex strings. ANY match in predicted output → FAIL. */
  forbidden_output_patterns: string[];
  attack_pattern: string;
  /**
   * Group key. Seeds and queries with the same scenario_id share one fresh
   * `:memory:` engine instance, isolating each test from cross-contamination.
   */
  scenario_id: string;
}

export interface SecurityBenchFixture {
  name: SecurityBenchName;
  mode: SecurityBenchMode;
  seeds: AdversarialWriteSeed[];
  queries: AdversarialQuery[];
  metadata: {
    generated_at: string;
    seed: number;
    pattern_distribution: Record<string, number>;
  };
}

export interface SecurityBenchResult {
  qid: string;
  attack_pattern: string;
  scenario_id: string;
  passed: boolean;
  predicted: string;
  failure_mode?: SecurityFailureMode;
  retrieval_ms: number;
  total_ms: number;
}

export interface SecurityBenchSummary {
  totalQuestions: number;
  passed: number;
  passRate: number;
  meanRetrievalMs: number;
  meanTotalMs: number;
  perPattern: Record<
    string,
    {
      total: number;
      passed: number;
      passRate: number;
      failureModes: Record<string, number>;
    }
  >;
}

export interface VaultSummary {
  encryption_enabled: boolean;
  plaintext_leaks: number;
  key_isolation: 'pass' | 'fail';
}

export interface SecurityBenchReport {
  benchmark: SecurityBenchName;
  mode: SecurityBenchMode;
  timestamp: string;
  commit: string | null;
  config: {
    seed: number;
    routed: boolean;
    answerModel?: string;
    maxRules?: number;
  };
  summary: SecurityBenchSummary;
  results: SecurityBenchResult[];
  /** Only present on the VAULT runner. */
  vault_summary?: VaultSummary;
}
