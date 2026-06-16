#!/usr/bin/env node
/**
 * S59A: standalone bench-env audit script.
 *
 * Spawns a fresh node process so it doesn't pollute caller's env.
 * Reads the bench profile from the centralized module + checks current
 * process.env state. Exits 0 if clean, 1 if mismatches found.
 *
 * Usage:
 *   tsx scripts/audit-bench-env.ts <bench-name>
 *
 * Examples:
 *   tsx scripts/audit-bench-env.ts locomo
 *   tsx scripts/audit-bench-env.ts frame
 *
 * Used by pre-bench-gate.sh to verify the LAUNCHER's resolved env state
 * matches the bench profile. If a launcher forgets to call
 * ensureBenchEnv() OR a future code change drops a profile var, this
 * gate catches it before any compute is wasted.
 */
import { auditBenchEnv, type BenchName } from '../src/benchmark/lib/bench-env.js';

const VALID_BENCHES = [
  'locomo',
  'beam',
  'lme',
  'clonemem',
  'mab',
  'dialsim',
  'frame',
  'vault',
  'product',
  'paraphrase',
  'ece_brier',
] as const;

const benchArg = process.argv[2];
if (!benchArg) {
  console.error('usage: tsx scripts/audit-bench-env.ts <bench-name>');
  console.error(`valid benches: ${VALID_BENCHES.join(', ')}`);
  process.exit(2);
}

if (!VALID_BENCHES.includes(benchArg as never)) {
  console.error(`unknown bench: ${benchArg}`);
  console.error(`valid benches: ${VALID_BENCHES.join(', ')}`);
  process.exit(2);
}

// auditBenchEnv only checks state, doesn't override. We call it WITHOUT
// running ensureBenchEnv first, that simulates what would happen if a
// launcher forgot to call ensureBenchEnv. Mismatches = real defect.
const mismatches = auditBenchEnv(benchArg as BenchName);
if (mismatches.length === 0) {
  console.log(`OK: bench-env profile '${benchArg}' matches current process.env`);
  process.exit(0);
}
console.error(`FAIL: ${mismatches.length} mismatch(es) for bench '${benchArg}':`);
for (const m of mismatches) {
  console.error(`  ${m}`);
}
console.error('');
console.error("Either the launcher forgot to call ensureBenchEnv('" + benchArg + "'),");
console.error('OR the runner is being invoked outside the launcher (e.g. raw `tsx scripts/x.ts`).');
console.error('Fix: ensure launcher exports the right vars OR uses ensureBenchEnv().');
process.exit(1);
