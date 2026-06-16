/**
 * Shared scaffold for public-bench adapters.
 *
 * Each public bench (MemoryAgentBench, CloneMem, DialSim, etc.) reads its
 * fixture in a custom shape, then seeds + queries + judges through this
 * common scaffold so all public-bench scores have the same Demiurge config,
 * the same retrieval-pipeline gate, and the same JSON output layout.
 *
 * Critical: TEST_MODE=true is mandatory for benches. See src/write/index.ts
 * line 108, SKIP_WRITE_VALIDATION is dead, TEST_MODE is the live flag.
 */

export interface PublicBenchFact {
  /** Memory text written to dispatch.addMemory.claim */
  claim: string;
  /** Subject; defaults to 'user' for the partition */
  subject?: string;
  /** Source label; defaults to 'user' */
  source?: string;
  /** ISO timestamp for when the fact entered memory */
  validFrom?: string;
  /** Optional bench-specific metadata that survives end-to-end for the judge */
  meta?: Record<string, unknown>;
}

export interface PublicBenchQuery {
  /** Stable id; used in result JSON */
  qid: string;
  /** Optional category/competency tag (e.g. 'AR' for accurate retrieval) */
  category?: string;
  /** The question text */
  question: string;
  /** The gold answer (string or list-of-aliases) */
  expected: string | string[];
  /** Optional bench-specific metadata for the judge */
  meta?: Record<string, unknown>;
}

export interface PublicBenchScenario {
  /** Stable id used to partition memory between scenarios */
  scenario_id: string;
  /** Facts seeded before queries fire */
  facts: PublicBenchFact[];
  /** Queries asked after seeding */
  queries: PublicBenchQuery[];
  /** Optional scenario-level metadata */
  meta?: Record<string, unknown>;
}

export interface PublicBenchFixture {
  /** Stable id e.g. 'memory-agent-bench', 'clonemem', 'dialsim' */
  bench_id: string;
  /** Version of the upstream fixture release */
  upstream_version: string;
  /** What this bench is actually evaluating */
  description: string;
  /** mini vs full as understood by the upstream bench */
  mode: 'mini' | 'full';
  scenarios: PublicBenchScenario[];
}

export interface PublicBenchQuestionResult {
  qid: string;
  category?: string;
  question: string;
  expected: string | string[];
  predicted: string;
  correct: boolean;
  judge_score?: number;
  retrieved_count: number;
  retrieved_ids: string[];
  context_text_len: number;
  retrieval_ms: number;
  total_ms: number;
  error?: string;
}

export interface PublicBenchReport {
  benchmark: string;
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
  };
  results: PublicBenchQuestionResult[];
}
