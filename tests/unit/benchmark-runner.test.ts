import { describe, it, expect, vi } from 'vitest';
import type { BenchmarkCorpus } from '../../src/benchmark/types.js';
import type { CoreDispatch, SearchResult } from '../../src/core/dispatch.js';

const testCorpus: BenchmarkCorpus = {
  name: 'test-corpus',
  conversations: [
    {
      id: 'conv-1',
      messages: [
        { role: 'user', content: 'I use TypeScript.', timestamp: '2026-01-01T00:00:00Z' },
      ],
    },
  ],
  questions: [
    {
      id: 'q-1',
      conversationId: 'conv-1',
      question: 'What language?',
      expectedAnswer: 'TypeScript',
      requiredFacts: ['TypeScript'],
    },
    {
      id: 'q-2',
      conversationId: 'conv-1',
      question: 'What framework?',
      expectedAnswer: 'Express',
      requiredFacts: ['Express'],
    },
  ],
};

describe('Benchmark Runner', () => {
  it('runBenchmark computes accuracy and kill condition', async () => {
    const { runBenchmark } = await import('../../src/benchmark/runner.js');

    const mockSearchResult: SearchResult = {
      payload: {
        memories: [],
        conflicts: [],
        metadata: { queryUsed: 'test', candidatesEvaluated: 0, retrievalTimeMs: 1 },
      },
      contextText: 'User prefers TypeScript.',
      raw: {
        candidates: [],
        metadata: {
          query: 'test', candidatesGenerated: 0,
          candidatesAfterFilter: 0, candidatesReturned: 0,
          timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
        },
      },
    };

    const mockDispatch = {
      search: vi.fn().mockResolvedValue(mockSearchResult),
      addMemory: vi.fn().mockResolvedValue({ action: 'stored' }),
    } as unknown as CoreDispatch;

    const report = await runBenchmark(mockDispatch, testCorpus, {
      maxRules: 15,
      killThreshold: 0.73,
      answerFn: async () => 'The user prefers TypeScript.',
    });

    expect(report.totalQuestions).toBe(2);
    expect(report.correct).toBe(1); // q-1 passes, q-2 fails
    expect(report.accuracy).toBe(0.5);
    expect(report.killConditionMet).toBe(false); // 50% < 73%
  });

  it('seedCorpus stores user messages', async () => {
    const { seedCorpus } = await import('../../src/benchmark/runner.js');

    const mockDispatch = {
      addMemory: vi.fn().mockResolvedValue({ action: 'confirmed' }),
    } as unknown as CoreDispatch;

    const count = await seedCorpus(mockDispatch, testCorpus);
    expect(count).toBe(1); // 1 user message in corpus
    expect(mockDispatch.addMemory).toHaveBeenCalledTimes(1);
  });
});
