#!/usr/bin/env node
/**
 * R29-WA-4: em-dash guard. Fails if a U+2014 appears in the authored
 * surfaces (src, scripts, docs, README, *.yml). Fixtures and benchmark-archive
 * are excluded: those carry upstream dataset text we do not rewrite.
 *
 * Usage: node scripts/check-no-em-dash.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const EM_DASH = String.fromCodePoint(0x2014);
const ROOTS = ['src', 'scripts', 'docs', '.github'];
const TOP_LEVEL_FILES = ['README.md'];
const EXCLUDE_DIRS = new Set(['node_modules', 'fixtures', 'benchmark-archive', '.git']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

const targets = [];
for (const root of ROOTS) for (const p of walk(root)) targets.push(p);
// top-level *.yml / *.yaml
for (const name of readdirSync('.')) {
  if (extname(name) === '.yml' || extname(name) === '.yaml') targets.push(name);
}
targets.push(...TOP_LEVEL_FILES);

// .github should only contribute yml/yaml (workflows); skip other binary-ish files
const scoped = targets.filter((p) => {
  if (p.startsWith('.github')) return p.endsWith('.yml') || p.endsWith('.yaml');
  return true;
});

const hits = [];
for (const p of scoped) {
  let s;
  try {
    s = readFileSync(p, 'utf-8');
  } catch {
    continue;
  }
  if (s.includes(EM_DASH)) {
    const lines = s.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(EM_DASH)) hits.push(`${p}:${i + 1}`);
    });
  }
}

if (hits.length > 0) {
  console.error(`em-dash guard FAILED: U+2014 found in ${hits.length} location(s):`);
  for (const h of hits) console.error('  ' + h);
  console.error('Replace em-dashes with context-appropriate punctuation (colon, comma, period).');
  process.exit(1);
}
console.log('em-dash guard OK: no U+2014 in authored surfaces.');
