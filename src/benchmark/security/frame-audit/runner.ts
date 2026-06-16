#!/usr/bin/env tsx
/**
 * S50 FRAME-AUDIT runner, hash-chain tamper detection.
 *
 * For each scenario in the fixture:
 *   - Load the (deliberately tampered) audit chain
 *   - Call verifyChain() from src/repository/audit-log.ts
 *   - PASS = result.valid === false (validator caught the tamper)
 *   - FAIL = result.valid === true (validator missed it)
 *
 * No engine bootstrap, no LLM calls, no DB. Pure function check.
 * Useful CI signal: if anyone touches audit-log.ts and weakens the chain
 * verifier, this bench flips red immediately.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { verifyChain } from '../../../repository/audit-log.js';
import { buildOutputPath, setBenchEnv } from '../harness.js';
import { summarize } from '../scorer.js';
import type { SecurityBenchMode, SecurityBenchReport, SecurityBenchResult } from '../types.js';
import type { FrameAuditFixture } from './generator.js';

interface CliOpts {
  mode: SecurityBenchMode;
  seed: number;
  fixturePath?: string;
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  let mode: SecurityBenchMode = 'mini';
  let seed = 42;
  let fixturePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mini') mode = 'mini';
    else if (a === '--full') mode = 'full';
    else if (a === '--seed') seed = parseInt(argv[++i] ?? '42', 10);
    else if (a === '--fixture-path') fixturePath = argv[++i];
  }
  return { mode, seed, fixturePath };
}

function getCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  setBenchEnv();
  const opts = parseArgs();

  const fixturePath =
    opts.fixturePath ?? resolve(process.cwd(), `fixtures/benchmark/security/frame-audit/${opts.mode}.json`);
  if (!existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    console.error('Generate fixtures first: npx tsx src/benchmark/security/generate-fixtures.ts');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FrameAuditFixture;
  if (fixture.name !== 'frame-audit') {
    console.error(`Fixture name mismatch: expected frame-audit, got ${fixture.name}`);
    process.exit(2);
  }

  console.log(`FRAME-AUDIT (${opts.mode}, ${fixture.scenarios.length} scenarios, seed=${opts.seed})`);

  const results: SecurityBenchResult[] = [];
  for (const scenario of fixture.scenarios) {
    const t0 = performance.now();
    const verification = verifyChain(scenario.entries);
    const total_ms = performance.now() - t0;
    const detected = !verification.valid;
    results.push({
      qid: scenario.qid,
      attack_pattern: scenario.attack_pattern,
      scenario_id: scenario.scenario_id,
      passed: detected,
      predicted: detected
        ? `detected: ${verification.error ?? '(no error message)'}`
        : 'validator MISSED tamper, chain accepted as valid',
      failure_mode: detected ? undefined : 'audit_corrupted',
      retrieval_ms: 0,
      total_ms,
    });
  }

  const summary = summarize(results);
  const outputPath = resolve(process.cwd(), buildOutputPath('frame-audit', opts.mode));
  const report: SecurityBenchReport = {
    benchmark: 'frame-audit',
    mode: opts.mode,
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    config: { seed: opts.seed, routed: false },
    summary,
    results,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`Detection rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.totalQuestions})`);
  console.log('Per-tamper-pattern:');
  for (const [pattern, stats] of Object.entries(summary.perPattern)) {
    console.log(`  ${pattern}: ${(stats.passRate * 100).toFixed(1)}% (${stats.passed}/${stats.total})`);
  }
  console.log(`\nReport: ${outputPath}`);
}

main().catch((err) => {
  console.error('FRAME-AUDIT runner failed:', err);
  process.exit(1);
});
