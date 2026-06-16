#!/usr/bin/env tsx
/**
 * S50 VAULT runner, encryption-at-rest audit.
 *
 * This bench has a different shape from frame-inject/sybil. We don't query
 * the engine; we audit the on-disk file:
 *
 *   1. Spin up SqliteMemoryRepository against a tmp file with a random key
 *   2. Write N memories containing distinctive markers
 *   3. Close (flushes WAL to main file)
 *   4. fs.readFileSync the .db raw bytes, grep for each marker
 *      → PASS = marker absent. FAIL = marker found in plaintext.
 *   5. Reopen with correct key → can read every memory back
 *   6. Reopen with WRONG key → must throw on first query
 *   7. Spawn child node process with NODE_ENV=production and no key →
 *      child must exit non-zero with the expected fatal message
 *
 * No LLM calls. ~5 min mini, ~15 min full (mostly disk I/O).
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

import { SqliteMemoryRepository } from '../../../repository/sqlite/index.js';
import { createCoreDispatch } from '../../../core/dispatch.js';
import { loadConfig, type Config } from '../../../config.js';
import { setBenchEnv, buildOutputPath } from '../harness.js';
import type {
  SecurityBenchFixture,
  SecurityBenchMode,
  SecurityBenchReport,
  SecurityBenchResult,
  VaultSummary,
} from '../types.js';
import { summarize } from '../scorer.js';

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

function tmpDbPath(suffix: string): string {
  return `/tmp/vault-${process.pid}-${Date.now()}-${suffix}.db`;
}

function cleanupDb(path: string): void {
  for (const sfx of ['', '-wal', '-shm', '-journal']) {
    try {
      unlinkSync(path + sfx);
    } catch {
      /* best-effort */
    }
  }
}

async function seedAndCloseEncrypted(
  baseConfig: Config,
  dbPath: string,
  key: string,
  markerSeeds: SecurityBenchFixture['seeds'],
): Promise<void> {
  const repo = new SqliteMemoryRepository({ ...baseConfig, dbPath, dbEncryptionKey: key });
  await repo.initialize();
  const dispatch = createCoreDispatch(repo, { ...baseConfig, dbPath, dbEncryptionKey: key });
  try {
    for (const seed of markerSeeds) {
      await dispatch.addMemory({
        claim: seed.content,
        subject: seed.subject ?? 'user',
        source: seed.source as 'user' | 'llm' | 'import',
        confidence: 0.95,
        user_id: seed.user_id,
      });
    }
  } finally {
    await repo.close();
  }
}

async function runPlaintextLeakChecks(
  baseConfig: Config,
  fixture: SecurityBenchFixture,
  results: SecurityBenchResult[],
): Promise<{ dbPath: string; key: string }> {
  const dbPath = tmpDbPath('markers');
  const key = randomBytes(32).toString('hex');
  const markerSeeds = fixture.seeds.filter((s) => s.attack_pattern === 'plaintext_marker');

  await seedAndCloseEncrypted(baseConfig, dbPath, key, markerSeeds);

  if (!existsSync(dbPath)) {
    throw new Error(`Encrypted DB file not created at ${dbPath}`);
  }
  const buf = readFileSync(dbPath);

  for (const query of fixture.queries) {
    if (query.attack_pattern !== 'plaintext_marker') continue;
    const t0 = performance.now();
    const marker = query.question; // generator put marker in the question field
    const present = buf.indexOf(Buffer.from(marker)) >= 0;
    const total_ms = performance.now() - t0;
    results.push({
      qid: query.qid,
      attack_pattern: query.attack_pattern,
      scenario_id: query.scenario_id,
      passed: !present,
      predicted: present ? `LEAK: marker "${marker}" found in raw bytes` : 'no leak',
      failure_mode: present ? 'plaintext_leak' : undefined,
      retrieval_ms: 0,
      total_ms,
    });
  }

  return { dbPath, key };
}

async function checkCorrectKeyReadback(
  baseConfig: Config,
  dbPath: string,
  key: string,
  fixture: SecurityBenchFixture,
  results: SecurityBenchResult[],
): Promise<void> {
  const query = fixture.queries.find((q) => q.qid === 'vault-readback-correct-key');
  if (!query) return;

  const t0 = performance.now();
  let passed = false;
  let predicted: string;
  try {
    const repo = new SqliteMemoryRepository({ ...baseConfig, dbPath, dbEncryptionKey: key });
    await repo.initialize();
    try {
      const stats = await repo.getStats('vault-user');
      const total = stats?.totalMemories ?? 0;
      passed = total > 0;
      predicted = `readback ok, ${total} memories`;
    } finally {
      await repo.close();
    }
  } catch (err) {
    predicted = `[unexpected throw] ${err instanceof Error ? err.message : String(err)}`;
  }
  results.push({
    qid: query.qid,
    attack_pattern: query.attack_pattern,
    scenario_id: query.scenario_id,
    passed,
    predicted,
    failure_mode: passed ? undefined : 'wrong_key_accepted',
    retrieval_ms: 0,
    total_ms: performance.now() - t0,
  });
}

async function checkWrongKeyRejection(
  baseConfig: Config,
  dbPath: string,
  fixture: SecurityBenchFixture,
  results: SecurityBenchResult[],
): Promise<void> {
  const query = fixture.queries.find((q) => q.qid === 'vault-wrong-key-rejection');
  if (!query) return;

  const t0 = performance.now();
  const wrongKey = 'a'.repeat(64);
  let threw = false;
  let predicted: string;
  try {
    const repo = new SqliteMemoryRepository({
      ...baseConfig,
      dbPath,
      dbEncryptionKey: wrongKey,
    });
    await repo.initialize();
    try {
      // If init succeeded with wrong key, a query must fail.
      await repo.getStats('vault-user');
      predicted = 'WRONG KEY ACCEPTED, encryption broken';
    } catch (err) {
      threw = true;
      predicted = `query threw as expected: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`;
    }
    await repo.close();
  } catch (err) {
    threw = true;
    predicted = `init threw as expected: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`;
  }
  results.push({
    qid: query.qid,
    attack_pattern: query.attack_pattern,
    scenario_id: query.scenario_id,
    passed: threw,
    predicted,
    failure_mode: threw ? undefined : 'wrong_key_accepted',
    retrieval_ms: 0,
    total_ms: performance.now() - t0,
  });
}

function checkProductionMissingKey(fixture: SecurityBenchFixture, results: SecurityBenchResult[]): void {
  const query = fixture.queries.find((q) => q.qid === 'vault-no-key-prod-rejection');
  if (!query) return;

  const t0 = performance.now();
  // Spawn a child process so production env doesn't poison the parent.
  // The child imports config.js, which calls process.exit(1) when
  // NODE_ENV=production and no DEMIURGE_DB_KEY is set.
  // Strip DEMIURGE_DB_KEY from the inherited env so the child sees it as unset
  // (rather than empty string, which would fail the regex first).
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'DEMIURGE_DB_KEY') continue;
    if (typeof v === 'string') childEnv[k] = v;
  }
  childEnv.NODE_ENV = 'production';
  childEnv.DEMIURGE_API_KEY = 'x'.repeat(40);
  childEnv.DB_PATH = './vault-prod-test.db';
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      '-e',
      `import('./src/config.js').then(m => { try { m.loadConfig(); console.log('CONFIG-LOADED'); } catch (e) { console.error('THREW:', e.message); process.exit(1); } });`,
    ],
    { env: childEnv, encoding: 'utf-8', stdio: 'pipe' },
  );
  const combined = `${child.stderr}\n${child.stdout}`;
  const threw = child.status !== 0 && combined.includes('DEMIURGE_DB_KEY is required when NODE_ENV=production');
  const predicted = threw
    ? 'production config refused to load without key'
    : `unexpected: status=${child.status}, output=${combined.slice(0, 200)}`;

  results.push({
    qid: query.qid,
    attack_pattern: query.attack_pattern,
    scenario_id: query.scenario_id,
    passed: threw,
    predicted,
    failure_mode: threw ? undefined : 'wrong_key_accepted',
    retrieval_ms: 0,
    total_ms: performance.now() - t0,
  });
}

async function main(): Promise<void> {
  setBenchEnv();
  // VAULT runs file-backed by design; explicit DB_PATH is set per-scenario.
  delete process.env.DB_PATH;
  // For the parent's loadConfig() we need SOME path; use a throwaway that
  // never gets created (we never initialize a repo using the parent config
  // directly, every call spreads {dbPath, dbEncryptionKey} overrides).
  process.env.DB_PATH = '/tmp/vault-parent-base.db';

  const opts = parseArgs();

  const fixturePath = opts.fixturePath ?? resolve(process.cwd(), `fixtures/benchmark/security/vault/${opts.mode}.json`);
  if (!existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    console.error('Generate fixtures first: npx tsx src/benchmark/security/generate-fixtures.ts');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as SecurityBenchFixture;
  if (fixture.name !== 'vault') {
    console.error(`Fixture name mismatch: expected vault, got ${fixture.name}`);
    process.exit(2);
  }

  console.log(`VAULT (${opts.mode}, ${fixture.queries.length} checks, seed=${opts.seed})`);

  const baseConfig = loadConfig();
  const results: SecurityBenchResult[] = [];

  const { dbPath, key } = await runPlaintextLeakChecks(baseConfig, fixture, results);
  await checkCorrectKeyReadback(baseConfig, dbPath, key, fixture, results);
  await checkWrongKeyRejection(baseConfig, dbPath, fixture, results);
  checkProductionMissingKey(fixture, results);

  cleanupDb(dbPath);

  const summary = summarize(results);

  const plaintextLeaks = results.filter((r) => r.attack_pattern === 'plaintext_marker' && !r.passed).length;
  const keyIsolationFailures = results.filter((r) => r.attack_pattern === 'wrong_key_accepted' && !r.passed).length;
  const vault_summary: VaultSummary = {
    encryption_enabled: true,
    plaintext_leaks: plaintextLeaks,
    key_isolation: keyIsolationFailures === 0 ? 'pass' : 'fail',
  };

  const outputPath = resolve(process.cwd(), buildOutputPath('vault', opts.mode));
  const report: SecurityBenchReport = {
    benchmark: 'vault',
    mode: opts.mode,
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    config: { seed: opts.seed, routed: false },
    summary,
    results,
    vault_summary,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`Pass rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.totalQuestions})`);
  console.log(`Plaintext leaks: ${plaintextLeaks}`);
  console.log(`Key isolation: ${vault_summary.key_isolation}`);
  console.log(`\nReport: ${outputPath}`);
}

main().catch((err) => {
  console.error('VAULT runner failed:', err);
  process.exit(1);
});
