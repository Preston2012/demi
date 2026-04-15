import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runConsensus,
  runPromotionConsensus,
  type ConsensusInput,
  type PromotionInput,
  type EvaluatorConfig,
} from '../../src/write/consensus.js';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeEvaluators(count: number = 3): EvaluatorConfig[] {
  const providers = ['anthropic', 'google', 'openai'];
  const models = ['claude-haiku-4-5-20251001', 'gemini-2.5-flash', 'gpt-4o-mini'];
  return Array.from({ length: count }, (_, i) => ({
    provider: providers[i % providers.length]!,
    model: models[i % models.length]!,
    apiKeys: {
      anthropic: 'test-anthropic-key',
      google: 'test-google-key',
      openai: 'test-openai-key',
    },
  }));
}

const consensusInput: ConsensusInput = {
  claim: 'User prefers dark mode',
  subject: 'user',
  confidence: 0.8,
  source: 'llm',
  existingConflicts: [],
};

const promotionInput: PromotionInput = {
  claim: 'User prefers dark mode',
  subject: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  accessCount: 10,
  lastAccessed: '2026-04-01T00:00:00.000Z',
  trustClass: 'confirmed',
  conflicts: [],
};

function mockAnthropicResponse(vote: string, reasoning: string = 'Test') {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ vote, reasoning }) }],
    }),
  };
}

function mockOpenAIResponse(vote: string, reasoning: string = 'Test') {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ vote, reasoning }) } }],
    }),
  };
}

function mockGoogleResponse(vote: string, reasoning: string = 'Test') {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ vote, reasoning }) }] } }],
    }),
  };
}

function _mockResponseForProvider(provider: string, vote: string) {
  switch (provider) {
    case 'anthropic':
      return mockAnthropicResponse(vote);
    case 'google':
      return mockGoogleResponse(vote);
    case 'openai':
      return mockOpenAIResponse(vote);
    default:
      return mockAnthropicResponse(vote);
  }
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runConsensus', () => {
  it('3 evaluators agree → correct decision', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('store');
      if (url.includes('generativelanguage')) return mockGoogleResponse('store');
      return mockOpenAIResponse('store');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    expect(result.decision).toBe('store');
    expect(result.unanimous).toBe(true);
    expect(result.votes).toHaveLength(3);
  });

  it('2 accept + 1 reject → accept (meets threshold)', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('openai')) return mockOpenAIResponse('reject');
      if (url.includes('generativelanguage')) return mockGoogleResponse('store');
      return mockAnthropicResponse('store');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    expect(result.decision).toBe('store');
    expect(result.unanimous).toBe(false);
  });

  it('1 each → quarantine (no agreement)', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('store');
      if (url.includes('generativelanguage')) return mockGoogleResponse('reject');
      return mockOpenAIResponse('quarantine');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    expect(result.decision).toBe('quarantine');
  });

  it('1 evaluator timeout + 2 agreeing → use the 2', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('store');
      if (url.includes('generativelanguage')) {
        // Simulate error (timeout is caught internally and returns quarantine vote)
        throw new Error('Timeout');
      }
      return mockOpenAIResponse('store');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    expect(result.decision).toBe('store');
    expect(result.votes).toHaveLength(3); // 2 real + 1 error fallback
  });

  it('2 evaluators fail → quarantine fallback (error votes are quarantine)', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('store');
      // Both others fail
      throw new Error('API Error');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    // 1 store + 2 quarantine (error fallback) → quarantine wins
    expect(result.decision).toBe('quarantine');
  });

  it('reject consensus when 2+ reject', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('reject');
      if (url.includes('generativelanguage')) return mockGoogleResponse('reject');
      return mockOpenAIResponse('store');
    });

    const result = await runConsensus(consensusInput, evaluators, 2);
    expect(result.decision).toBe('reject');
  });
});

describe('runPromotionConsensus', () => {
  it('promotes when majority agrees', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('promote');
      if (url.includes('generativelanguage')) return mockGoogleResponse('promote');
      return mockOpenAIResponse('keep_provisional');
    });

    const result = await runPromotionConsensus(promotionInput, evaluators, 2);
    expect(result.decision).toBe('promote');
  });

  it('keeps provisional when no majority', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('anthropic')) return mockAnthropicResponse('promote');
      if (url.includes('generativelanguage')) return mockGoogleResponse('reject');
      return mockOpenAIResponse('keep_provisional');
    });

    const result = await runPromotionConsensus(promotionInput, evaluators, 2);
    expect(result.decision).toBe('keep_provisional');
  });

  it('rejects when majority rejects', async () => {
    const evaluators = makeEvaluators(3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('openai')) return mockOpenAIResponse('promote');
      if (url.includes('generativelanguage')) return mockGoogleResponse('reject');
      return mockAnthropicResponse('reject');
    });

    const result = await runPromotionConsensus(promotionInput, evaluators, 2);
    expect(result.decision).toBe('reject');
  });
});

describe('parseEvaluators (via config)', () => {
  // Import and test the config parser
  it('parses valid evaluator string', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    const result = parseEvaluators('anthropic:claude-haiku-4-5-20251001,google:gemini-2.5-flash,openai:gpt-4o-mini', {
      anthropic: 'key1',
      google: 'key2',
      openai: 'key3',
    });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(result[1]).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
    expect(result[2]).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('skips entries with missing API keys', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    const result = parseEvaluators(
      'anthropic:claude-haiku-4-5-20251001,google:gemini-2.5-flash',
      { anthropic: 'key1' }, // no google key
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.provider).toBe('anthropic');
  });

  it('skips malformed entries', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    const result = parseEvaluators('anthropic:claude-haiku-4-5-20251001,bad-entry,google:gemini-2.5-flash', {
      anthropic: 'key1',
      google: 'key2',
    });
    expect(result).toHaveLength(2);
  });

  it('returns empty array for undefined input', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    expect(parseEvaluators(undefined, {})).toHaveLength(0);
  });

  it('returns empty array for empty string', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    expect(parseEvaluators('', {})).toHaveLength(0);
  });

  it('skips unknown providers', async () => {
    const { parseEvaluators } = await import('../../src/config.js');
    const result = parseEvaluators('anthropic:model1,azure:model2', { anthropic: 'key1' });
    expect(result).toHaveLength(1);
  });
});
