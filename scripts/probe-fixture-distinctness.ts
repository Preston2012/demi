#!/usr/bin/env npx tsx
/**
 * Fixture distinctness probe (S68).
 *
 * For each tier-3 generator, runs the generator and computes pairwise
 * cosine similarity over BGE-small embeddings of every claim. Reports:
 *   - total facts
 *   - max pairwise cosine
 *   - count of pairs >= 0.95 (production dedup threshold)
 *   - count of pairs >= 0.90
 *   - within-trace dedup risk (per-trace fresh repo benches)
 */

import { generate as crossSessionGenerate } from '../src/benchmark/cross-session-temporal/generator.js';
import { generate as correctionGenerate } from '../src/benchmark/correction-propagation/generator.js';
import { generate as skinPersonaGenerate } from '../src/benchmark/skin-persona/generator.js';
import { generate as coldWarmGenerate } from '../src/benchmark/cold-warm/generator.js';
import { initialize, encode, isInitialized } from '../src/embeddings/index.js';
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __probeDir = dirname(fileURLToPath(import.meta.url));

interface Group {
  bench: string;
  groupKey: string;
  claims: string[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function probeGroup(g: Group): Promise<{ pairs95: number; pairs90: number; max: number }> {
  const claims = g.claims;
  if (claims.length < 2) {
    console.log(`  [${g.bench}] ${g.groupKey}: ${claims.length} claim(s), no pair to score`);
    return { pairs95: 0, pairs90: 0, max: 0 };
  }
  const vecs = await Promise.all(claims.map((c) => encode(c)));
  let maxSim = 0;
  let pairs95 = 0;
  let pairs90 = 0;
  let topPair: [string, string, number] = ['', '', 0];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const s = cosine(vecs[i]!, vecs[j]!);
      if (s > maxSim) {
        maxSim = s;
        topPair = [claims[i]!, claims[j]!, s];
      }
      if (s >= 0.95) pairs95++;
      if (s >= 0.9) pairs90++;
    }
  }
  const totalPairs = (claims.length * (claims.length - 1)) / 2;
  const status = pairs95 > 0 ? '🔴 DEDUP HITS' : pairs90 > 0 ? '🟡 borderline' : '🟢 distinct';
  console.log(
    `  [${g.bench}] ${g.groupKey}: ${claims.length} claims, ${totalPairs} pairs, ` +
      `max=${maxSim.toFixed(3)}, ≥0.95=${pairs95}, ≥0.90=${pairs90} ${status}`,
  );
  if (pairs95 > 0) {
    console.log(`    top collision: max=${topPair[2].toFixed(3)}`);
    console.log(`      A: ${topPair[0]}`);
    console.log(`      B: ${topPair[1]}`);
  }
  return { pairs95, pairs90, max: maxSim };
}

async function main(): Promise<void> {
  const config = loadConfig();
  await initialize(config.modelPath);
  if (!isInitialized()) {
    console.error('FATAL: embeddings not initialized');
    process.exit(1);
  }

  const groups: Group[] = [];

  console.log('\n=== cross-session-temporal (one repo for entire fixture) ===');
  const cst = crossSessionGenerate(42, 'mini');
  const cstClaims: string[] = cst.sessions.flatMap((s) => s.facts.map((f) => f.claim));
  groups.push({ bench: 'cross-session-temporal', groupKey: 'mini all-sessions', claims: cstClaims });

  console.log('\n=== correction-propagation (per-trace fresh repo, 2 facts each) ===');
  const cp = correctionGenerate(42, 'mini');
  for (const trace of cp.traces) {
    groups.push({
      bench: 'correction-propagation',
      groupKey: `trace ${trace.trace_id}`,
      claims: trace.facts.map((f) => f.claim),
    });
  }

  console.log('\n=== skin-persona (per-trace fresh repo) ===');
  const sp = skinPersonaGenerate(42, 'mini');
  for (const trace of sp.traces) {
    groups.push({
      bench: 'skin-persona',
      groupKey: `persona ${trace.persona}`,
      claims: trace.facts,
    });
  }

  console.log('\n=== cold-warm (per-scenario fresh repo) ===');
  const cw = coldWarmGenerate(42, 'mini');
  for (const scenario of cw.scenarios) {
    groups.push({
      bench: 'cold-warm',
      groupKey: `scenario ${scenario.topic}`,
      claims: scenario.facts.map((f) => f.claim),
    });
  }

  console.log('\n=== intent-ambiguity (per-scenario fresh repo, LLM-generated) ===');
  try {
    const iaPath = resolve(__probeDir, '../src/benchmark/intent-ambiguity/fixtures/scenarios.json');
    const ia = JSON.parse(readFileSync(iaPath, 'utf-8')) as {
      scenarios: Array<{ scenario_id: string; facts: Array<{ text: string }> }>;
    };
    for (const sc of ia.scenarios) {
      groups.push({
        bench: 'intent-ambiguity',
        groupKey: `scenario ${sc.scenario_id}`,
        claims: sc.facts.map((f) => f.text),
      });
    }
    console.log(`  loaded ${ia.scenarios.length} scenarios from fixture`);
  } catch (e) {
    console.log(`  SKIP: intent-ambiguity fixture not loadable (${e instanceof Error ? e.message : String(e)})`);
  }

  console.log('\n=== multi-hop-chain (per-scenario fresh repo, LLM-generated) ===');
  try {
    const mhPath = resolve(__probeDir, '../src/benchmark/multi-hop-chain/fixtures/scenarios.json');
    const mh = JSON.parse(readFileSync(mhPath, 'utf-8')) as {
      scenarios: Array<{ scenario_id: string; facts: Array<{ text: string }> }>;
    };
    for (const sc of mh.scenarios) {
      groups.push({
        bench: 'multi-hop-chain',
        groupKey: `scenario ${sc.scenario_id}`,
        claims: sc.facts.map((f) => f.text),
      });
    }
    console.log(`  loaded ${mh.scenarios.length} scenarios from fixture`);
  } catch (e) {
    console.log(`  SKIP: multi-hop-chain fixture not loadable (${e instanceof Error ? e.message : String(e)})`);
  }

  console.log('\n=== PROBE RESULTS ===');
  const totals = new Map<string, { groups: number; total95: number; total90: number; totalClaims: number }>();
  for (const g of groups) {
    const r = await probeGroup(g);
    const e = totals.get(g.bench) ?? { groups: 0, total95: 0, total90: 0, totalClaims: 0 };
    e.groups++;
    e.total95 += r.pairs95;
    e.total90 += r.pairs90;
    e.totalClaims += g.claims.length;
    totals.set(g.bench, e);
  }

  console.log('\n=== SUMMARY ===');
  for (const [bench, info] of totals) {
    const verdict = info.total95 > 0 ? '🔴 NEEDS REBUILD' : info.total90 > 0 ? '🟡 borderline' : '🟢 distinct';
    console.log(
      `  ${bench}: ${info.groups} groups, ${info.totalClaims} claims, ≥0.95 pairs=${info.total95}, ≥0.90 pairs=${info.total90} ${verdict}`,
    );
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
