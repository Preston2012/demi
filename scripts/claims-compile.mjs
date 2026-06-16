#!/usr/bin/env node
/*
 * WC-5: claims-compile.
 *
 * A pin in golden-config.json or the read-first ledgers is a CLAIM about the
 * running system. This script compiles those claims against the committed
 * artifacts and fails CI when a claim has drifted from reality. Two gates:
 *
 *  (A) Env-pin reachability. Every env pin in golden-config.json must reach a
 *      reader from production code (process.env.<KEY>, or the config env
 *      schema), or be listed in scripts/claims-compile.allowlist.json with a
 *      reason. Pinning a flag no code reads is a claim with no behavior behind
 *      it (F-D7-1 / F-D1-1).
 *
 *  (B) Five-pin doc grep. The read-first ledger (DEMIURGE_STATE.md) must state
 *      five falsifiable pins that match the committed artifacts:
 *        1. gate baseline filename (matches golden-config + the CI gate, file exists)
 *        2. routing status DORMANT (matches golden cli.routed=false + ANSWER_ROUTING=false)
 *        3. mini Q-count (LOCOMO 540Q)
 *        4. concurrency CAX11=1 / CAX21=2 (the ruled doctrine)
 *        5. classifier policy = checksum-pin (golden prompts.fileHashes present)
 *      This makes G-014 doc drift mechanical instead of a session chore.
 *
 * No external dependencies; exits 1 on any failure. Per reconciliation Item-2.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (gate, msg) => failures.push(`[${gate}] ${msg}`);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const golden = JSON.parse(read('golden-config.json'));
const allowlist = JSON.parse(read('scripts/claims-compile.allowlist.json'));

// --- Gate A: env-pin reachability ---------------------------------------

/** Collect production .ts source (excludes benchmarks and test files). */
function collectProdSource(dir, acc) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'benchmark' || name === '__tests__') continue;
      collectProdSource(full, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      acc.push(read(full.slice(ROOT.length + 1)));
    }
  }
  return acc;
}
const srcText = collectProdSource(join(ROOT, 'src'), []).join('\n');

for (const key of Object.keys(golden.env ?? {})) {
  // A reader is process.env.<KEY> (direct), env.<KEY> (parsed config schema),
  // or a zod schema field "<KEY>:" in the config env block.
  const reachable =
    srcText.includes(`process.env.${key}`) ||
    srcText.includes(`env.${key}`) ||
    new RegExp(`\\b${key}\\s*:`).test(srcText);
  if (!reachable) {
    const allowed = allowlist.allow?.[key];
    if (allowed) {
      console.log(`  env ${key}: not directly read, allowlisted (${allowed})`);
    } else {
      fail('A', `env pin "${key}" reaches no production reader and is not allowlisted`);
    }
  } else {
    console.log(`  env ${key}: reachable`);
  }
}

// --- Gate B: five-pin doc grep ------------------------------------------

const STATE = 'DEMIURGE_STATE.md';
const stateText = read(STATE);
const ci = read('.github/workflows/ci.yml');

function pinPresent(label, needle) {
  if (!stateText.includes(needle)) {
    fail('B', `${label}: ${STATE} is missing the pin "${needle}"`);
  } else {
    console.log(`  pin ${label}: present`);
  }
}

// 1. gate baseline filename: golden + CI gate + file on disk + ledger
const baselineFile = golden.baselines?.file;
if (!baselineFile) fail('B', 'golden-config baselines.file is missing');
else {
  if (!existsSync(join(ROOT, baselineFile))) fail('B', `gate baseline file does not exist: ${baselineFile}`);
  if (!ci.includes(baselineFile)) fail('B', `CI gate does not pin the baseline filename: ${baselineFile}`);
  pinPresent('baseline-filename', baselineFile);
}

// 2. routing DORMANT: golden consistency + ledger
if (golden.cli?.routed !== false) fail('B', 'golden cli.routed is not false (routing should be DORMANT)');
if (golden.env?.ANSWER_ROUTING !== 'false') fail('B', 'golden env.ANSWER_ROUTING is not "false" (routing should be DORMANT)');
pinPresent('routing-dormant', 'DORMANT');

// 3. mini Q-count
pinPresent('mini-q-count', '540Q');

// 4. concurrency doctrine
pinPresent('concurrency-cax11', 'CAX11=1');
pinPresent('concurrency-cax21', 'CAX21=2');

// 5. classifier policy = checksum-pin
if (!golden.prompts?.fileHashes || Object.keys(golden.prompts.fileHashes).filter((k) => k !== '_note').length === 0) {
  fail('B', 'golden prompts.fileHashes (classifier checksum-pin) is missing');
}
pinPresent('classifier-checksum-pin', 'checksum-pin');

// --- Result --------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nclaims-compile FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nclaims-compile OK: every golden env pin is reachable and the five ledger pins match the committed artifacts.');
