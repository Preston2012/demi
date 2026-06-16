export interface MemoryFixture {
  claim: string;
  subject: string;
  conversationId: string;
}

export interface BenchmarkCorpus {
  name: string;
  conversations: ConversationFixture[];
  memories?: MemoryFixture[];
  questions: QuestionFixture[];
}

export interface ConversationFixture {
  id: string;
  messages: ConversationMessage[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface QuestionFixture {
  id: string;
  conversationId: string;
  question: string;
  expectedAnswer: string;
  requiredFacts: string[];
  category?: string;
}

export interface BenchmarkResult {
  questionId: string;
  question: string;
  expectedAnswer: string;
  actualAnswer: string;
  memoriesInjected: number;
  correct: boolean;
  factsHit: string[];
  factsMissed: string[];
  retrievalTimeMs: number;
  totalTimeMs: number;
  injectedContext?: string;
}

export interface BenchmarkReport {
  corpus: string;
  timestamp: string;
  totalQuestions: number;
  correct: number;
  accuracy: number;
  meanRetrievalMs: number;
  p95RetrievalMs: number;
  meanTotalMs: number;
  p95TotalMs: number;
  killConditionMet: boolean;
  killThreshold: number;
  results: BenchmarkResult[];
  categoryBreakdown: Record<string, { total: number; correct: number; accuracy: number }>;
}
