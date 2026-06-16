/**
 * S50 FRAME-AUDIT generator.
 *
 * Six tamper patterns. Each scenario:
 *   1. Build a clean chain of 20 audit entries with valid hashes.
 *   2. Apply one tamper pattern.
 *   3. Run verifyChain() against the corrupted array → must detect.
 *
 * The audit-log infrastructure (computeEntryHash, verifyChain) already
 * exists at src/repository/audit-log.ts. We reuse it directly so this bench
 * tracks the actual production validator, not a parallel implementation.
 *
 * Fixtures here carry the tampered chain inline as JSON. The runner just
 * loads and validates, no DB, no engine bootstrap.
 */

import { v4 as uuid } from 'uuid';
import { computeEntryHash } from '../../../repository/audit-log.js';
import type { AuditEntry, AuditAction } from '../../../schema/audit.js';

const TAMPER_PATTERNS = ['insertion', 'deletion', 'replay', 'replacement', 'reordering', 'hash_forgery'] as const;
type TamperPattern = (typeof TAMPER_PATTERNS)[number];

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

function uuidFromRng(rng: () => number): string {
  // Mulberry32-derived UUID for deterministic fixtures (vs uuid() which uses crypto.randomUUID).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(rng() * 256);
  // Set version (4) and variant per RFC 4122
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ACTIONS: AuditAction[] = ['created', 'updated', 'confirmed', 'accessed'];

function buildCleanChain(rng: () => number, length: number, baseTime: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < length; i++) {
    const timestamp = new Date(baseTime + i * 1000).toISOString();
    const action = ACTIONS[i % ACTIONS.length]!;
    const memoryId = i % 3 === 0 ? null : uuidFromRng(rng);
    const details = `event-${i}-${action}`;
    const hash = computeEntryHash({ memoryId, action, details, timestamp }, prevHash);
    entries.push({
      id: uuidFromRng(rng),
      memoryId,
      action,
      details,
      previousHash: prevHash,
      hash,
      timestamp,
    });
    prevHash = hash;
  }
  return entries;
}

function applyInsertion(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 1));
  const ts = new Date(Date.parse(entries[idx]!.timestamp) - 250).toISOString();
  // Inject a fabricated entry with a hash that "looks valid" against its own
  // claimed previousHash, but breaks the linkage (the next entry's
  // previousHash still points at the original predecessor).
  const fake: AuditEntry = {
    id: uuidFromRng(rng),
    memoryId: uuidFromRng(rng),
    action: 'updated',
    details: 'forged-insertion',
    previousHash: entries[idx - 1]!.hash,
    hash: computeEntryHash(
      {
        memoryId: null,
        action: 'updated',
        details: 'forged-insertion',
        timestamp: ts,
      },
      entries[idx - 1]!.hash,
    ),
    timestamp: ts,
  };
  const out = [...entries];
  out.splice(idx, 0, fake);
  return out;
}

function applyDeletion(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 2));
  const out = [...entries];
  out.splice(idx, 1);
  return out;
}

function applyReplay(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 2));
  const orig = entries[idx]!;
  const dup: AuditEntry = {
    ...orig,
    id: uuidFromRng(rng),
    timestamp: new Date(Date.parse(orig.timestamp) + 1).toISOString(),
  };
  const out = [...entries];
  out.splice(idx + 1, 0, dup);
  return out;
}

function applyReplacement(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 2));
  const out = entries.map((e, i) => {
    if (i !== idx) return e;
    return { ...e, details: `mutated-${e.details}` };
  });
  return out;
}

function applyReordering(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 2));
  const out = [...entries];
  const tmp = out[idx]!;
  out[idx] = out[idx + 1]!;
  out[idx + 1] = tmp;
  return out;
}

function applyHashForgery(entries: AuditEntry[], rng: () => number): AuditEntry[] {
  const idx = 1 + Math.floor(rng() * (entries.length - 2));
  const out = entries.map((e, i) => {
    if (i !== idx) return e;
    const newDetails = `tampered-${e.details}`;
    const newHash = computeEntryHash(
      {
        memoryId: e.memoryId,
        action: e.action,
        details: newDetails,
        timestamp: e.timestamp,
      },
      e.previousHash,
    );
    return { ...e, details: newDetails, hash: newHash };
  });
  return out;
}

const TAMPERERS: Record<TamperPattern, (e: AuditEntry[], r: () => number) => AuditEntry[]> = {
  insertion: applyInsertion,
  deletion: applyDeletion,
  replay: applyReplay,
  replacement: applyReplacement,
  reordering: applyReordering,
  hash_forgery: applyHashForgery,
};

export interface FrameAuditScenario {
  qid: string;
  scenario_id: string;
  attack_pattern: TamperPattern;
  /** The tampered chain. The runner calls verifyChain(entries) and asserts valid===false. */
  entries: AuditEntry[];
}

export interface FrameAuditFixture {
  name: 'frame-audit';
  mode: 'mini' | 'full';
  scenarios: FrameAuditScenario[];
  metadata: {
    generated_at: string;
    seed: number;
    pattern_distribution: Record<string, number>;
  };
}

export interface FrameAuditGenerateOptions {
  mode: 'mini' | 'full';
  seed: number;
  count: number;
  /** Length of the clean chain before tampering (default 20). */
  chainLength?: number;
}

export function generateFrameAudit(options: FrameAuditGenerateOptions): FrameAuditFixture {
  const rng = mulberry32(options.seed);
  const chainLength = options.chainLength ?? 20;
  const baseTime = Date.UTC(2024, 0, 1, 0, 0, 0);

  const scenarios: FrameAuditScenario[] = [];
  const distribution: Record<string, number> = {};

  for (let i = 0; i < options.count; i++) {
    const pattern = TAMPER_PATTERNS[i % TAMPER_PATTERNS.length]!;
    const clean = buildCleanChain(rng, chainLength, baseTime + i * chainLength * 1000);
    const tampered = TAMPERERS[pattern](clean, rng);
    scenarios.push({
      qid: `audit-${pattern}-${i.toString().padStart(4, '0')}`,
      scenario_id: `frame-audit-${options.mode}-${i.toString().padStart(4, '0')}`,
      attack_pattern: pattern,
      entries: tampered,
    });
    distribution[pattern] = (distribution[pattern] ?? 0) + 1;
  }

  return {
    name: 'frame-audit',
    mode: options.mode,
    scenarios,
    metadata: {
      generated_at: new Date().toISOString(),
      seed: options.seed,
      pattern_distribution: distribution,
    },
  };
}

// Avoid unused import warning when the file is analyzed in isolation.
void uuid;
