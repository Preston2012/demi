#!/usr/bin/env npx tsx
/**
 * compare-manifests.ts, refuse to print a delta across mismatched manifests.
 *
 * Usage:
 *   npx tsx src/benchmark/lib/compare-manifests.ts \
 *     --baseline benchmark-results/beam-100k-mini-9050914-2026-05-08T04-56-35-414Z.json \
 *     --candidate benchmark-results/beam-100k-mini-AAAAAAA-2026-05-09T00-00-00-000Z.json
 *
 * Exits 0 if manifests are comparable AND prints overall + per-bucket deltas.
 * Exits 1 if manifest mismatch detected, prints structured diff and STOPS.
 *
 * This is the answer to S62 council R33's phantom-regression class. No bench
 * delta gets cited internally without going through this gate.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertComparableManifests, BenchManifestMismatchError, type ResultManifest } from './manifest.js';

interface BenchReport {
  benchmark: string;
  manifest: ResultManifest;
  summary?: Record<string, unknown>;
  byAbility?: Record<string, { total: number; scoreSum: number }>;
  byConv?: Record<string, { total: number; scoreSum: number }>;
  results?: Array<Record<string, unknown>>;
}

function parseArgs(argv: string[]): { baseline: string; candidate: string } {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };
  const baseline = get('--baseline');
  const candidate = get('--candidate');
  if (!baseline || !candidate) {
    console.error('Usage: compare-manifests.ts --baseline <path> --candidate <path>');
    process.exit(2);
  }
  return { baseline, candidate };
}

function loadReport(path: string): BenchReport {
  const raw = readFileSync(resolve(path), 'utf-8');
  const parsed = JSON.parse(raw) as BenchReport;
  if (!parsed.manifest) {
    throw new Error(`${path} has no .manifest field, produced before S63 Tier 0.4 BRAVO-MANIFEST. Cannot compare.`);
  }
  return parsed;
}

function pct(x: number): string {
  return (x * 100).toFixed(2) + '%';
}

function deltaPct(a: number, b: number): string {
  const d = (b - a) * 100;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(2)}pp`;
}

function printBeamDelta(a: BenchReport, b: BenchReport): void {
  const aOverall =
    a.summary && typeof (a.summary as { overallScore?: unknown }).overallScore === 'number'
      ? (a.summary as { overallScore: number }).overallScore
      : 0;
  const bOverall =
    b.summary && typeof (b.summary as { overallScore?: unknown }).overallScore === 'number'
      ? (b.summary as { overallScore: number }).overallScore
      : 0;
  console.log(`\nOverall:  ${pct(aOverall)} → ${pct(bOverall)}  (${deltaPct(aOverall, bOverall)})`);

  if (a.byAbility && b.byAbility) {
    console.log('\nBy ability:');
    const keys = Array.from(new Set([...Object.keys(a.byAbility), ...Object.keys(b.byAbility)])).sort();
    for (const k of keys) {
      const av = a.byAbility[k];
      const bv = b.byAbility[k];
      const aScore = av && av.total > 0 ? av.scoreSum / av.total : 0;
      const bScore = bv && bv.total > 0 ? bv.scoreSum / bv.total : 0;
      console.log(`  ${k.padEnd(28)} ${pct(aScore)} → ${pct(bScore)}  (${deltaPct(aScore, bScore)})`);
    }
  }

  if (a.byConv && b.byConv) {
    console.log('\nBy conversation:');
    const keys = Array.from(new Set([...Object.keys(a.byConv), ...Object.keys(b.byConv)])).sort(
      (x, y) => parseInt(x) - parseInt(y),
    );
    for (const k of keys) {
      const av = a.byConv[k];
      const bv = b.byConv[k];
      const aScore = av && av.total > 0 ? av.scoreSum / av.total : 0;
      const bScore = bv && bv.total > 0 ? bv.scoreSum / bv.total : 0;
      console.log(`  Conv ${k.padEnd(8)} ${pct(aScore)} → ${pct(bScore)}  (${deltaPct(aScore, bScore)})`);
    }
  }
}

function printLocomoDelta(a: BenchReport, b: BenchReport): void {
  const aJ = (a.summary as { jScore?: number } | undefined)?.jScore ?? 0;
  const bJ = (b.summary as { jScore?: number } | undefined)?.jScore ?? 0;
  console.log(`\nJ-score:  ${pct(aJ)} → ${pct(bJ)}  (${deltaPct(aJ, bJ)})`);

  const aF1 = (a.summary as { meanF1?: number } | undefined)?.meanF1 ?? 0;
  const bF1 = (b.summary as { meanF1?: number } | undefined)?.meanF1 ?? 0;
  console.log(`Mean F1:  ${pct(aF1)} → ${pct(bF1)}  (${deltaPct(aF1, bF1)})`);

  if (a.results && b.results) {
    console.log('\nBy category:');
    for (let cat = 1; cat <= 5; cat++) {
      const aCat = a.results.filter((r) => (r as { category?: number }).category === cat);
      const bCat = b.results.filter((r) => (r as { category?: number }).category === cat);
      if (aCat.length === 0 && bCat.length === 0) continue;
      const aCorrect = aCat.filter((r) => (r as { llm_judge_correct?: boolean }).llm_judge_correct).length;
      const bCorrect = bCat.filter((r) => (r as { llm_judge_correct?: boolean }).llm_judge_correct).length;
      const aScore = aCat.length > 0 ? aCorrect / aCat.length : 0;
      const bScore = bCat.length > 0 ? bCorrect / bCat.length : 0;
      console.log(
        `  Cat ${cat}  ${pct(aScore)} (${aCorrect}/${aCat.length}) → ${pct(bScore)} (${bCorrect}/${bCat.length})  (${deltaPct(aScore, bScore)})`,
      );
    }
  }
}

function main(): void {
  const { baseline, candidate } = parseArgs(process.argv.slice(2));
  const a = loadReport(baseline);
  const b = loadReport(candidate);

  try {
    assertComparableManifests(a.manifest, b.manifest);
  } catch (err) {
    if (err instanceof BenchManifestMismatchError) {
      console.error('REFUSING to print delta, manifests are not comparable:\n');
      for (const d of err.differences) {
        console.error(`  ${d.field}:`);
        console.error(`    baseline:  ${JSON.stringify(d.a)}`);
        console.error(`    candidate: ${JSON.stringify(d.b)}`);
      }
      console.error(
        '\nThis is the S62 R33 phantom-regression gate. Investigate the mismatch above before citing any score.',
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(`Manifests comparable. Comparing:`);
  console.log(`  baseline:  ${baseline}`);
  console.log(`  candidate: ${candidate}`);
  console.log(
    `  commit=${a.manifest.commit_sha.slice(0, 7)}  scope=${a.manifest.scope_label}  adapter=${a.manifest.adapter_mode}`,
  );

  if (a.benchmark.startsWith('beam-')) {
    printBeamDelta(a, b);
  } else if (a.benchmark.startsWith('locomo-')) {
    printLocomoDelta(a, b);
  } else {
    console.log(`\n(no per-bucket formatter for benchmark='${a.benchmark}'; manifests match.)`);
  }
}

main();
