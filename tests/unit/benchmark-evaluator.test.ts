import { describe, it, expect } from 'vitest';
import { evaluateAnswer } from '../../src/benchmark/evaluator.js';
import type { QuestionFixture } from '../../src/benchmark/types.js';

const baseQuestion: QuestionFixture = {
  id: 'q-1',
  conversationId: 'conv-1',
  question: 'What language does the user prefer?',
  expectedAnswer: 'The user prefers TypeScript.',
  requiredFacts: ['TypeScript'],
};

const baseMeta = { memoriesInjected: 5, retrievalTimeMs: 12, totalTimeMs: 80 };

describe('evaluateAnswer', () => {
  it('marks correct when all facts present', () => {
    const result = evaluateAnswer(
      baseQuestion,
      'The user prefers TypeScript for backend work.',
      baseMeta,
    );
    expect(result.correct).toBe(true);
    expect(result.factsHit).toContain('TypeScript');
    expect(result.factsMissed).toHaveLength(0);
  });

  it('marks incorrect when facts missing', () => {
    const result = evaluateAnswer(
      baseQuestion,
      'The user prefers Python.',
      baseMeta,
    );
    expect(result.correct).toBe(false);
    expect(result.factsMissed).toContain('TypeScript');
  });

  it('case-insensitive matching', () => {
    const result = evaluateAnswer(
      baseQuestion,
      'The user likes typescript a lot.',
      baseMeta,
    );
    expect(result.correct).toBe(true);
  });

  it('handles multiple required facts', () => {
    const q: QuestionFixture = {
      ...baseQuestion,
      requiredFacts: ['TypeScript', 'backend'],
    };

    const partial = evaluateAnswer(q, 'Uses TypeScript daily.', baseMeta);
    expect(partial.correct).toBe(false);
    expect(partial.factsHit).toContain('TypeScript');
    expect(partial.factsMissed).toContain('backend');

    const full = evaluateAnswer(q, 'TypeScript for backend services.', baseMeta);
    expect(full.correct).toBe(true);
  });

  it('preserves timing metadata', () => {
    const result = evaluateAnswer(baseQuestion, 'TypeScript', {
      memoriesInjected: 15,
      retrievalTimeMs: 8.5,
      totalTimeMs: 120.3,
    });
    expect(result.memoriesInjected).toBe(15);
    expect(result.retrievalTimeMs).toBe(8.5);
    expect(result.totalTimeMs).toBe(120.3);
  });
});
