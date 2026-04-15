/**
 * LongMemEval data types.
 *
 * Based on the xiaowu0162/longmemeval-cleaned HuggingFace dataset.
 * Each entry has its own set of chat sessions (per-question isolation).
 */

export interface LongMemEvalSession {
  session_id: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

export interface LongMemEvalEntry {
  question_id: string;
  question: string;
  answer: string;
  question_type: string;
  question_date?: string;
  haystack_session_ids?: number[];
  haystack_dates?: string[];
  sessions: LongMemEvalSession[];
}

export interface LongMemEvalDataset {
  entries: LongMemEvalEntry[];
}

export interface LongMemEvalResult {
  question_id: string;
  question_type: string;
  question: string;
  reference_answer: string;
  hypothesis: string;
  correct: boolean;
  retrievalTimeMs: number;
  totalTimeMs: number;
}

export interface LongMemEvalReport {
  dataset: string;
  timestamp: string;
  totalQuestions: number;
  correct: number;
  accuracy: number;
  byCategory: Record<string, { total: number; correct: number; accuracy: number }>;
  meanRetrievalMs: number;
  meanTotalMs: number;
  results: LongMemEvalResult[];
}

/**
 * Cached extracted facts for a question's sessions.
 */
export interface ExtractedFacts {
  question_id: string;
  facts: Array<{
    claim: string;
    subject: string;
    session_id: number;
  }>;
}

export interface ExtractedFactsCache {
  dataset: string;
  model: string;
  extracted_at: string;
  entries: ExtractedFacts[];
}
