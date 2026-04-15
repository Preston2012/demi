import { describe, it, expect, vi } from 'vitest';
import { classifyTrust, type TrustBranchConfig } from '../../src/write/trust-branch.js';
import type { IMemoryRepository } from '../../src/repository/interface.js';
import { TrustClass, MemorySource } from '../../src/schema/memory.js';
import type { AddMemoryInput } from '../../src/schema/memory.js';
import type { ValidationResult } from '../../src/write/validators.js';
import type { DedupResult } from '../../src/write/dedup.js';

const VALID: ValidationResult = { valid: true, reason: null };
const NO_DUP: DedupResult = {
  isDuplicate: false,
  matchType: null,
  existingId: null,
  similarity: null,
};
const CONFIG: TrustBranchConfig = {
  confidenceThreshold: 0.7,
  spotCheckRate: 0, // Disable lottery for deterministic tests
  consensusThreshold: 0.5,
};

function mockRepo(ftsResults: unknown[] = []): IMemoryRepository {
  return {
    searchFTS: vi.fn().mockResolvedValue(ftsResults),
    getByIds: vi.fn().mockResolvedValue([]),
  } as unknown as IMemoryRepository;
}

function input(overrides: Partial<AddMemoryInput> = {}): AddMemoryInput {
  return {
    claim: 'User prefers dark mode',
    subject: 'user',
    source: MemorySource.LLM,
    confidence: 0.8,
    ...overrides,
  } as AddMemoryInput;
}

describe('Trust branching', () => {
  it('Branch 4: rejects on validation failure', async () => {
    const repo = mockRepo();
    const badValidation: ValidationResult = {
      valid: false,
      reason: 'Injection detected',
    };
    const result = await classifyTrust(input(), repo, CONFIG, badValidation, NO_DUP);
    expect(result.action).toBe('rejected');
    expect(result.trustClass).toBe(TrustClass.REJECTED);
  });

  it('Branch 4: rejects on duplicate', async () => {
    const repo = mockRepo();
    const dup: DedupResult = {
      isDuplicate: true,
      matchType: 'exact',
      existingId: 'existing-id',
      similarity: 1.0,
    };
    const result = await classifyTrust(input(), repo, CONFIG, VALID, dup);
    expect(result.action).toBe('rejected');
    expect(result.reason).toContain('Duplicate');
  });

  it('Branch 1: auto-confirms user source with high confidence', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(
      input({ source: MemorySource.USER, confidence: 0.95 }),
      repo,
      CONFIG,
      VALID,
      NO_DUP,
    );
    expect(result.action).toBe('confirmed');
    expect(result.trustClass).toBe(TrustClass.CONFIRMED);
  });

  it('Branch 3: quarantines on conflicts', async () => {
    const conflicting = {
      id: 'conflict-1',
      record: {
        id: 'conflict-1',
        claim: 'User prefers light mode',
        subject: 'user',
        trustClass: TrustClass.AUTO_APPROVED,
      },
    };
    const repo = mockRepo([conflicting]);
    const result = await classifyTrust(input(), repo, CONFIG, VALID, NO_DUP);
    expect(result.action).toBe('quarantined');
    expect(result.conflictsWith).toContain('conflict-1');
    expect(result.needsConsensus).toBe(true);
  });

  it('Branch 3: quarantines low confidence', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(input({ confidence: 0.3 }), repo, CONFIG, VALID, NO_DUP);
    expect(result.action).toBe('quarantined');
    expect(result.reason).toContain('Low confidence');
  });

  it('Branch 3: quarantines imports', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(
      input({ source: MemorySource.IMPORT, confidence: 0.9 }),
      repo,
      CONFIG,
      VALID,
      NO_DUP,
    );
    expect(result.action).toBe('quarantined');
    expect(result.reason).toContain('Imported');
  });

  it('Branch 2: auto-stores confident LLM extraction', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(
      input({ source: MemorySource.LLM, confidence: 0.85 }),
      repo,
      CONFIG,
      VALID,
      NO_DUP,
    );
    expect(result.action).toBe('stored');
    expect(result.trustClass).toBe(TrustClass.AUTO_APPROVED);
  });

  it('Branch 1: user with conflicts goes to quarantine+consensus (C1)', async () => {
    const conflicting = {
      id: 'c-1',
      record: {
        id: 'c-1',
        claim: 'Different claim',
        subject: 'user',
        trustClass: TrustClass.AUTO_APPROVED,
      },
    };
    const repo = mockRepo([conflicting]);
    const result = await classifyTrust(
      input({ source: MemorySource.USER, confidence: 0.95 }),
      repo,
      CONFIG,
      VALID,
      NO_DUP,
    );
    // C1: User source with conflicts now quarantines + triggers consensus
    expect(result.action).toBe('quarantined');
    expect(result.needsConsensus).toBe(true);
    expect(result.conflictsWith).toContain('c-1');
  });

  it('consensus flag set for very low confidence', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(input({ confidence: 0.4 }), repo, CONFIG, VALID, NO_DUP);
    expect(result.needsConsensus).toBe(true);
  });

  it('no consensus needed for above-threshold confidence', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(input({ confidence: 0.85 }), repo, CONFIG, VALID, NO_DUP);
    expect(result.needsConsensus).toBe(false);
  });

  it('handles hyphenated subject without FTS crash', async () => {
    const repo = mockRepo();
    const result = await classifyTrust(input({ subject: 'mcp-sdk', confidence: 0.85 }), repo, CONFIG, VALID, NO_DUP);
    // Should not throw; searchFTS receives sanitized query
    expect(result.action).toBe('stored');
    expect(repo.searchFTS).toHaveBeenCalled();
  });

  it('does not flag unrelated claims as conflicts', async () => {
    const conflicting = {
      id: 'c-1',
      record: {
        id: 'c-1',
        claim: 'claude.ai connectors use Streamable HTTP transport',
        subject: 'demiurge',
        trustClass: TrustClass.AUTO_APPROVED,
      },
    };
    const repo = mockRepo([conflicting]);
    const result = await classifyTrust(
      input({ subject: 'demiurge', claim: 'Demiurge was verified on 2026-04-08' }),
      repo,
      CONFIG,
      VALID,
      NO_DUP,
    );
    // Unrelated claims should NOT be flagged as conflicts
    expect(result.conflictsWith).toHaveLength(0);
  });
});
