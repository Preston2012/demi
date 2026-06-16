#!/usr/bin/env tsx
/**
 * S50: Regenerate every committed security-bench fixture.
 *
 *   npx tsx src/benchmark/security/generate-fixtures.ts
 *
 * Idempotent: same seed → same JSON byte-for-byte (modulo `generated_at`).
 * Run this any time the generators change; commit the resulting fixtures.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { generateFrameInject } from './frame-inject/generator.js';
import { generateFrameSybil } from './frame-sybil/generator.js';
import { generateFrameAudit } from './frame-audit/generator.js';
import { generateVault } from './vault/generator.js';

const SEED = 42;

const OUT_ROOT = resolve(process.cwd(), 'fixtures/benchmark/security');

function write(path: string, data: unknown): void {
  const full = resolve(OUT_ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(data, null, 2) + '\n');
  console.log(`  wrote ${full}`);
}

function main(): void {
  console.log('Regenerating security-bench fixtures...');

  // FRAME-INJECT: 50 mini, 200 full
  write('frame-inject/mini.json', generateFrameInject({ mode: 'mini', seed: SEED, count: 50 }));
  write('frame-inject/full.json', generateFrameInject({ mode: 'full', seed: SEED, count: 200 }));

  // FRAME-SYBIL: 40 mini, 150 full
  write('frame-sybil/mini.json', generateFrameSybil({ mode: 'mini', seed: SEED, count: 40 }));
  write('frame-sybil/full.json', generateFrameSybil({ mode: 'full', seed: SEED, count: 150 }));

  // VAULT: 10 markers mini, 50 full
  write('vault/mini.json', generateVault({ mode: 'mini', seed: SEED, markerCount: 10 }));
  write('vault/full.json', generateVault({ mode: 'full', seed: SEED, markerCount: 50 }));

  // FRAME-AUDIT: 40 mini, 150 full
  write('frame-audit/mini.json', generateFrameAudit({ mode: 'mini', seed: SEED, count: 40 }));
  write('frame-audit/full.json', generateFrameAudit({ mode: 'full', seed: SEED, count: 150 }));

  console.log('Done.');
}

main();
