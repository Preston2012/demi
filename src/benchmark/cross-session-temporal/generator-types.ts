/**
 * Cross-session-temporal generator types, extracted so templates.ts and
 * bake.ts can both consume the Theme type without circular imports.
 */

export type Theme = 'work' | 'hobby' | 'travel' | 'family' | 'health' | 'food' | 'books' | 'music' | 'weather' | 'news';

export interface Fact {
  fact_id: string;
  session_idx: number;
  fact_idx: number;
  theme: Theme;
  claim: string;
  distinctive: string[];
  valid_from: string;
}

export interface Session {
  session_idx: number;
  date: string;
  theme: Theme;
  facts: Fact[];
}

export type CSTQuestionType = 'recent' | 'mid' | 'distant' | 'time-anchored' | 'order-aware';

export interface CSTQuestion {
  qid: string;
  type: CSTQuestionType;
  question: string;
  /** Distinctive nouns (lowercased substrings) judge requires for recall types. */
  distinctive: string[];
  /** Reference fact for recall and time-anchored. */
  ref_session_idx: number;
  /** For order-aware: second fact's session_idx. */
  ref2_session_idx?: number;
  /** For order-aware: 'before' or 'after' literal. */
  expected_order?: 'before' | 'after';
}

export interface CSTFixture {
  version: string;
  seed: number;
  mode: 'mini' | 'full';
  sessions: Session[];
  questions: CSTQuestion[];
}

export interface FixtureManifest {
  fixtureVersion: string;
  bakedAt: string;
  embeddingModel: string;
  seed: number;
  mode: 'mini' | 'full';
  factCount: number;
  questionCount: number;
  pairwise: {
    /** Maximum cosine similarity observed between any two distinct facts. */
    max: number;
    /** Mean cosine similarity across all distinct pairs. */
    mean: number;
    /** 99th-percentile pairwise cosine. */
    p99: number;
    /** Threshold the bake job enforced (every pair was below this). */
    enforcedMaxCosine: number;
  };
  perTheme: Record<Theme, { facts: number; templateShapes: number; pool: { name: string; size: number }[] }>;
  generationStats: {
    candidatesGenerated: number;
    candidatesRejected: number;
    rejectRate: number;
    bakeWallSeconds: number;
  };
}
