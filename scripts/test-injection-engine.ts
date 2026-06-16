#!/usr/bin/env tsx
/**
 * S53: validate INJECTION_PATTERNS additions catch FRAME-INJECT seeds
 * via the engine's actual detectInjection function (not just regex sandbox).
 */

import { readFileSync } from 'node:fs';
import { detectInjection } from '../src/write/validators.js';

interface Seed {
  content: string;
  attack_pattern: string;
  legitimate?: boolean;
}

const fixture = JSON.parse(readFileSync('/root/demiurge/fixtures/benchmark/security/frame-inject/full.json', 'utf8'));

const attacks: Seed[] = fixture.seeds.filter((s: Seed) => !s.legitimate);
const legit: Seed[] = fixture.seeds.filter((s: Seed) => s.legitimate);

let attackCaught = 0;
const missed: Seed[] = [];
const perPat: Record<string, { total: number; caught: number }> = {};

for (const a of attacks) {
  perPat[a.attack_pattern] = perPat[a.attack_pattern] ?? { total: 0, caught: 0 };
  perPat[a.attack_pattern].total++;
  const r = detectInjection(a.content);
  if (!r.valid) {
    attackCaught++;
    perPat[a.attack_pattern].caught++;
  } else {
    missed.push(a);
  }
}

let legitFP = 0;
const fps: Array<{ content: string; reason: string | null }> = [];
for (const l of legit) {
  const r = detectInjection(l.content);
  if (!r.valid) {
    legitFP++;
    fps.push({ content: l.content, reason: r.reason });
  }
}

console.log(`ATTACKS: ${attackCaught}/${attacks.length} caught`);
console.log(`LEGIT FALSE POSITIVES: ${legitFP}/${legit.length}`);
console.log();
console.log('PER-PATTERN:');
for (const [pat, stats] of Object.entries(perPat).sort()) {
  console.log(`  ${pat.padEnd(28)} ${stats.caught}/${stats.total}`);
}
if (missed.length > 0) {
  console.log();
  console.log('MISSED:');
  for (const m of missed.slice(0, 10)) {
    console.log(`  [${m.attack_pattern}] ${JSON.stringify(m.content.slice(0, 200))}`);
  }
}
if (fps.length > 0) {
  console.log();
  console.log('FALSE POSITIVES:');
  for (const f of fps.slice(0, 10)) {
    console.log(`  [${f.reason}] ${JSON.stringify(f.content.slice(0, 150))}`);
  }
}

const success = attackCaught === attacks.length && legitFP === 0;
process.exit(success ? 0 : 1);
