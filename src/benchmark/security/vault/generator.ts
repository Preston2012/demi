/**
 * S50 VAULT generator.
 *
 * Different shape from frame-inject/sybil, the "fixture" here is just a list
 * of marker strings to plant. The runner spins up a file-backed SqliteMemoryRepository,
 * writes the markers, closes, then greps the raw file bytes.
 *
 * Markers come in two flavors:
 *   - fixed (per packet): SSN-style, API key, email, payload-marker-{N}
 *   - random per-seed: a unique nonce so repeated runs don't collide
 */

import type { SecurityBenchFixture, SecurityBenchMode } from '../types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fixed markers per the packet, present in seeds, must NOT appear in
 * raw file bytes after close.
 */
const FIXED_MARKERS = ['ssn-123-45-6789', 'API_KEY=sk-test123', 'user@example.com'];

export interface VaultGenerateOptions {
  mode: SecurityBenchMode;
  seed: number;
  /** Total marker memories to seed (mini=10, full=50). */
  markerCount: number;
}

export function generateVault(options: VaultGenerateOptions): SecurityBenchFixture {
  const rng = mulberry32(options.seed);

  const seeds: SecurityBenchFixture['seeds'] = [];
  const queries: SecurityBenchFixture['queries'] = [];

  // Seed memories that contain markers. The runner rewrites these into a
  // file-backed engine; the dispatch shape (user_id etc.) is informational.
  for (let i = 0; i < options.markerCount; i++) {
    const marker =
      i < FIXED_MARKERS.length
        ? FIXED_MARKERS[i % FIXED_MARKERS.length]!
        : `secret-payload-marker-${i.toString().padStart(4, '0')}-${Math.floor(rng() * 1e9).toString(36)}`;
    const scenario_id = `vault-${options.mode}-${i.toString().padStart(4, '0')}`;
    seeds.push({
      user_id: 'vault-user',
      source: 'user',
      content: `Sensitive datum ${i}: ${marker}`,
      attack_pattern: 'plaintext_marker',
      legitimate: true,
      scenario_id,
    });
    // The "queries" array here doubles as the per-marker check list. The
    // VAULT runner doesn't actually call dispatch.search, it greps raw bytes
    //, but using the standard fixture shape lets the report aggregator
    // work without special-casing.
    queries.push({
      qid: `vault-marker-${i.toString().padStart(4, '0')}`,
      user_id: 'vault-user',
      question: marker, // the marker doubles as the "question" for grep
      forbidden_output_patterns: [marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')],
      attack_pattern: 'plaintext_marker',
      scenario_id,
    });
  }

  // Three additional scenarios for the key-isolation checks.
  const keyChecks: Array<{ qid: string; pattern: string }> = [
    { qid: 'vault-readback-correct-key', pattern: 'wrong_key_accepted' },
    { qid: 'vault-wrong-key-rejection', pattern: 'wrong_key_accepted' },
    { qid: 'vault-no-key-prod-rejection', pattern: 'wrong_key_accepted' },
  ];
  for (const kc of keyChecks) {
    const scenario_id = `vault-${options.mode}-${kc.qid}`;
    queries.push({
      qid: kc.qid,
      user_id: 'vault-user',
      question: '(key isolation check)',
      forbidden_output_patterns: [],
      attack_pattern: kc.pattern,
      scenario_id,
    });
  }

  return {
    name: 'vault',
    mode: options.mode,
    seeds,
    queries,
    metadata: {
      generated_at: new Date().toISOString(),
      seed: options.seed,
      pattern_distribution: {
        plaintext_marker: options.markerCount,
        wrong_key_accepted: keyChecks.length,
      },
    },
  };
}
