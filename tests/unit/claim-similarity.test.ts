import { describe, it, expect } from 'vitest';
import {
  tokenize,
  jaccardSimilarity,
  claimsRelated,
} from '../../src/write/claim-similarity.js';

describe('tokenize', () => {
  it('removes stop words', () => {
    const tokens = tokenize('the user is using dark mode');
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('user')).toBe(true);
    expect(tokens.has('dark')).toBe(true);
    expect(tokens.has('mode')).toBe(true);
  });

  it('lowercases tokens', () => {
    const tokens = tokenize('User Prefers DARK Mode');
    expect(tokens.has('user')).toBe(true);
    expect(tokens.has('prefers')).toBe(true);
    expect(tokens.has('dark')).toBe(true);
  });

  it('splits on punctuation', () => {
    const tokens = tokenize('mcp-sdk uses streamable-http');
    expect(tokens.has('mcp')).toBe(true);
    expect(tokens.has('sdk')).toBe(true);
    expect(tokens.has('streamable')).toBe(true);
    expect(tokens.has('http')).toBe(true);
  });

  it('filters short tokens (< 3 chars)', () => {
    const tokens = tokenize('AI is an ok tool');
    expect(tokens.has('ai')).toBe(false);
    expect(tokens.has('is')).toBe(false);
    expect(tokens.has('ok')).toBe(false);
    expect(tokens.has('tool')).toBe(true);
  });

  it('returns empty set for stop-words-only input', () => {
    const tokens = tokenize('the is a an');
    expect(tokens.size).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['dark', 'mode', 'user']);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['dark', 'mode']);
    const b = new Set(['streamable', 'http']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns correct value for partial overlap', () => {
    const a = new Set(['user', 'prefers', 'dark', 'mode']);
    const b = new Set(['user', 'prefers', 'light', 'mode']);
    // intersection: user, prefers, mode = 3
    // union: user, prefers, dark, light, mode = 5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.6);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe('claimsRelated', () => {
  it('returns true for contradictory claims about same topic', () => {
    expect(claimsRelated(
      'User prefers dark mode',
      'User prefers light mode',
    )).toBe(true);
  });

  it('returns false for unrelated claims', () => {
    expect(claimsRelated(
      'Demiurge was verified on 2026-04-08',
      'claude.ai connectors use Streamable HTTP transport',
    )).toBe(false);
  });

  it('returns false for completely different topics', () => {
    expect(claimsRelated(
      'The project uses TypeScript strict mode',
      'User lives in New York City',
    )).toBe(false);
  });

  it('returns true for claims with significant overlap', () => {
    expect(claimsRelated(
      'The deployment server uses Docker containers',
      'The deployment server runs without Docker',
    )).toBe(true);
  });

  it('returns true for very short claims (lenient check)', () => {
    // Short claims about same subject are more likely to conflict
    expect(claimsRelated('dark mode', 'light mode')).toBe(true);
  });

  it('returns true for identical claims', () => {
    expect(claimsRelated(
      'User prefers dark mode',
      'User prefers dark mode',
    )).toBe(true);
  });
});
