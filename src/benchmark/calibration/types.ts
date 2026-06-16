/**
 * Shared types for the S51 calibration bench suite (ECE/Brier, Recall@K).
 *
 * Calibration benches measure a different question than product benches:
 * not "is the answer correct?" but "does the engine know how confident it
 * should be?" (ECE/Brier) and "what fraction of all relevant memories did
 * the engine actually retrieve?" (Recall@K with held-out labels).
 */

export type CalibrationBenchId = 'ece-brier' | 'recall';

// ----- ECE / Brier -----

export interface CalibrationFact {
  claim: string;
  subject?: string;
  source?: string;
  validFrom?: string;
  meta?: Record<string, unknown>;
}

export interface CalibrationQuery {
  qid: string;
  question: string;
  /** Gold answer(s). Empty array means "engine should refuse", hard-negative. */
  expected: string[];
  /** Source slice tag (e.g. 'clonemem', 'mab', 'locomo', 'lme', 'hard-negative'). */
  source?: string;
  /** When true, correctness is "engine refused or said 'I don't know'". */
  expectRefusal?: boolean;
}

export interface CalibrationScenario {
  scenario_id: string;
  facts: CalibrationFact[];
  queries: CalibrationQuery[];
}

export interface CalibrationFixture {
  bench_id: CalibrationBenchId;
  mode: 'mini' | 'full';
  description: string;
  scenarios: CalibrationScenario[];
}

export interface ReliabilityBucket {
  /** Bucket lower bound (e.g. 0.0, 0.1, ...). */
  lo: number;
  /** Bucket upper bound (e.g. 0.1, 0.2, ...). */
  hi: number;
  /** Number of predictions in this bucket. */
  count: number;
  /** Mean predicted confidence within the bucket. */
  meanConfidence: number;
  /** Empirical accuracy within the bucket (fraction correct). */
  accuracy: number;
}

export interface CalibrationResult {
  qid: string;
  scenario_id: string;
  question: string;
  expected: string[];
  predicted: string;
  confidence: number;
  confidenceSource: string;
  correct: boolean;
  expectRefusal: boolean;
  source?: string;
  retrieved_count: number;
  retrieval_ms: number;
  total_ms: number;
  error?: string;
}

export interface CalibrationReport {
  benchmark: 'ece-brier';
  timestamp: string;
  commit: string;
  config: {
    mode: 'mini' | 'full';
    answerModel: string;
    judgeModel: string;
    maxRules: number;
    seed?: number;
    numBuckets: number;
  };
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    /** Expected Calibration Error: weighted gap between confidence and accuracy across buckets. */
    ece: number;
    /** Brier score: mean squared error between confidence and outcome. */
    brier: number;
    /** Mean confidence (sanity check vs. accuracy). */
    meanConfidence: number;
    /** Per-source slice (e.g. clonemem, mab, hard-negative). */
    perSource: Record<
      string,
      { total: number; correct: number; accuracy: number; meanConfidence: number; ece: number }
    >;
    /** Calibration target band (excellent / acceptable / miscalibrated). */
    band: 'excellent' | 'acceptable' | 'miscalibrated';
  };
  reliabilityDiagram: ReliabilityBucket[];
  results: CalibrationResult[];
}

// ----- Recall@K -----

export interface RecallMemory {
  /** Stable id within the cluster, runner uses it to map ground truth onto retrieved ids. */
  memory_id: string;
  claim: string;
  /** Ground-truth relevance label. */
  relevant: boolean;
  validFrom?: string;
}

export interface RecallCluster {
  cluster_id: string;
  question: string;
  memories: RecallMemory[];
}

export interface RecallFixture {
  bench_id: 'recall';
  mode: 'mini' | 'full';
  description: string;
  clusters: RecallCluster[];
}

export interface RecallClusterResult {
  cluster_id: string;
  question: string;
  /** Number of relevant memories in the cluster (ground truth). */
  numRelevant: number;
  /** Number of memories in the cluster (denominator for precision/recall). */
  numTotal: number;
  /** Per-K metrics. */
  metrics: Array<{
    k: number;
    retrieved: number;
    truePositives: number;
    precision: number;
    recall: number;
    f1: number;
  }>;
  /** AUPRC for this cluster (precision-recall area sweeping K from 1..N). */
  auprc: number;
  retrieval_ms: number;
  /** Mapping retrieved-id → was-relevant. Useful for debugging. */
  retrievedRelevance: Array<{ memoryId: string; relevant: boolean; rankedScore?: number }>;
}

export interface RecallReport {
  benchmark: 'recall';
  timestamp: string;
  commit: string;
  config: {
    mode: 'mini' | 'full';
    seed?: number;
    kValues: number[];
  };
  summary: {
    totalClusters: number;
    perK: Record<string, { precision: number; recall: number; f1: number }>;
    meanAuprc: number;
  };
  clusters: RecallClusterResult[];
}
