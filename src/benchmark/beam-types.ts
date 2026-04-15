/**
 * BEAM benchmark data types.
 *
 * Based on Mohammadta/BEAM HuggingFace dataset.
 * 100 conversations x 20 probing questions each.
 * Scales: 128K, 500K, 1M, 10M tokens.
 */

export interface BeamMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BeamProbingQuestion {
  question_id: string;
  question: string;
  answer: string;
  category: string;
  nuggets?: string[]; // atomic facts for partial-credit scoring
}

export interface BeamConversation {
  conversation_id: string;
  messages: BeamMessage[];
  probing_questions: BeamProbingQuestion[];
}

export interface BeamDataset {
  conversations: BeamConversation[];
}

export interface BeamResult {
  conversation_id: string;
  question_id: string;
  category: string;
  question: string;
  reference_answer: string;
  hypothesis: string;
  score: number; // 0.0, 0.5, or 1.0 (nugget-based)
  retrievalTimeMs: number;
  totalTimeMs: number;
}

export interface BeamReport {
  dataset: string;
  scale: string; // '128k', '500k', '1m', '10m'
  timestamp: string;
  totalQuestions: number;
  meanScore: number;
  byCategory: Record<string, { total: number; meanScore: number }>;
  meanRetrievalMs: number;
  meanTotalMs: number;
  results: BeamResult[];
}

export interface BeamExtractedFacts {
  conversation_id: string;
  facts: Array<{
    claim: string;
    subject: string;
    chunk_index: number;
  }>;
}

export interface BeamExtractedFactsCache {
  dataset: string;
  scale: string;
  model: string;
  extracted_at: string;
  conversations: BeamExtractedFacts[];
}
