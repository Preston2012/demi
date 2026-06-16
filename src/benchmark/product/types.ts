/**
 * Shared types for the S51 product-correctness bench suite (stale-memory,
 * attribution, paraphrase, difficulty-injection).
 *
 * Modeled on src/benchmark/public/shared/runner-base.ts so a normalized
 * fixture shape flows through the harness regardless of which generator
 * produced it (Python SPARQL fetcher, deterministic TS generator, or LLM-
 * generated paraphrases).
 */

export type ProductBenchId = 'stale-memory' | 'attribution' | 'paraphrase' | 'difficulty';

export interface ProductFact {
  /** Memory text seeded into dispatch.addMemory.claim. */
  claim: string;
  /** Subject; defaults 'user'. */
  subject?: string;
  /** Source label; defaults 'user'. */
  source?: string;
  /** ISO timestamp for when the fact entered memory. */
  validFrom?: string;
  /** Stable id used by attribution-style judges to verify retrieval picked the right record. */
  expectedMemoryId?: string;
  /** Bench-specific metadata that must survive end-to-end (e.g. mode, predicate). */
  meta?: Record<string, unknown>;
}

export interface ProductQuery {
  /** Stable id; appears in result JSON. */
  qid: string;
  /** Optional category/pattern tag for slicing (e.g. 'P39', 'source-collision'). */
  category?: string;
  /** The question text. */
  question: string;
  /**
   * Gold answer(s). For paraphrase tolerance the judge accepts any of the
   * aliases. For stale-memory bench a query may have separate `oldValue` and
   * `newValue` strings in `meta`.
   */
  expected: string | string[];
  /** Bench-specific metadata for the judge (e.g. `asked_at`, `mode`, `oldValue`, `newValue`). */
  meta?: Record<string, unknown>;
}

export interface ProductScenario {
  scenario_id: string;
  facts: ProductFact[];
  queries: ProductQuery[];
  meta?: Record<string, unknown>;
}

export interface ProductFixture {
  bench_id: ProductBenchId;
  upstream_version: string;
  description: string;
  mode: 'mini' | 'full';
  scenarios: ProductScenario[];
}

export interface ProductQuestionResult {
  qid: string;
  scenario_id: string;
  category?: string;
  question: string;
  expected: string | string[];
  predicted: string;
  /** Pass/fail. Definition is bench-specific (see scorer). */
  correct: boolean;
  /** Bench-specific outcome label (e.g. 'correct' | 'partial' | 'wrong' | 'refusal'). */
  outcome?: string;
  /** Optional confidence captured when bench uses dispatch.answer(). */
  confidence?: number;
  /** Optional source label for that confidence. */
  confidenceSource?: string;
  retrieved_count: number;
  retrieved_ids: string[];
  retrieved_claims: string[];
  retrieval_ms: number;
  total_ms: number;
  error?: string;
  /** Bench-specific extra fields (provenance counts, source-string match, etc.). */
  extra?: Record<string, unknown>;
}

export interface ProductReport {
  benchmark: ProductBenchId;
  upstream_version: string;
  timestamp: string;
  commit: string;
  config: {
    mode: 'mini' | 'full';
    answerModel: string;
    judgeModel: string;
    maxRules: number;
    seed?: number;
  };
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    perCategory: Record<string, { total: number; correct: number; accuracy: number; meanRetrievalMs: number }>;
    /** Bench-specific aggregate metrics (e.g. partialRate, refusalRate, hallucinationRate). */
    extra?: Record<string, number>;
  };
  results: ProductQuestionResult[];
}
