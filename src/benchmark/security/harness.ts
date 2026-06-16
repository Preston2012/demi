/**
 * S50: Shared harness for FRAME-INJECT and FRAME-SYBIL.
 *
 * Both benches run the same loop:
 *   - For each scenario_id: spin up a fresh `:memory:` SqliteMemoryRepository
 *     so flood / payload from one scenario can't bleed into the next.
 *   - Seed every fixture seed for that scenario via dispatch.addMemory().
 *     source='user' so adversarial seeds actually persist (TEST_MODE auto-confirms).
 *     The whole point of these benches is testing what happens when payloads
 *     ARE in the store, the engine's defense must hold at retrieval/output time.
 *   - For each query in that scenario: run `dispatchFn` (each runner supplies
 *     its own, typically dispatch.search → callLLM with retrieved context).
 *   - Score deterministically via scorer.scoreQuery.
 *
 * VAULT and FRAME-AUDIT have different shapes (file-backed encrypted DB; no
 * engine boot, just hash-chain validation) and don't go through this harness.
 */

import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { SqliteMemoryRepository } from '../../repository/sqlite/index.js';
import { ValidationError } from '../../errors.js';
import { createCoreDispatch, type CoreDispatch } from '../../core/dispatch.js';
import { loadConfig, type Config } from '../../config.js';
import { initialize as initializeEmbeddings, isInitialized as embeddingsInitialized } from '../../embeddings/index.js';

import type {
  AdversarialQuery,
  AdversarialWriteSeed,
  SecurityBenchFixture,
  SecurityBenchReport,
  SecurityBenchResult,
} from './types.js';
import { scoreQuery, summarize } from './scorer.js';
import { ensureBenchEnv } from '../lib/bench-env.js';
import { initBenchTelemetry } from '../lib/bench-telemetry.js';

export type SecurityDispatchFn = (
  query: AdversarialQuery,
  dispatch: CoreDispatch,
) => Promise<{ predicted: string; retrieval_ms: number }>;

export interface RunSecurityBenchInput {
  fixture: SecurityBenchFixture;
  dispatchFn: SecurityDispatchFn;
  routed: boolean;
  seed: number;
  answerModel?: string;
  maxRules?: number;
  outputPath: string;
}

/**
 * Set the env vars every bench needs BEFORE loadConfig() runs. Idempotent.
 * Call once at the top of each runner's main().
 */
/**
 * Set the env vars every bench needs BEFORE loadConfig() runs.
 *
 * S59A: now delegates to ensureBenchEnv('frame') which OVERRIDES .env (the
 * old pattern preserved .env values via `||` defaults, broken for the
 * leak-protection use case). Plus sets the legacy single-bench-only vars
 * (DEMIURGE_API_KEY, DB_PATH, LOG_LEVEL, BENCH_SKIP_DEDUP,
 * BENCH_SKIP_CIRCUIT_BREAKER) that aren't part of the bench-env profile.
 */
export function setBenchEnv(): void {
  // Delegated to ensureBenchEnv for the routing/STONE/TEMPORAL/BI_TEMPORAL
  // hygiene. Frame profile is the closest match to security suite needs.
  ensureBenchEnv('frame');
  initBenchTelemetry();
  // Plus the legacy single-bench knobs not covered by bench-env.
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_SKIP_CIRCUIT_BREAKER = process.env.BENCH_SKIP_CIRCUIT_BREAKER || 'true';
}

function groupByScenario(
  fixture: SecurityBenchFixture,
): Map<string, { seeds: AdversarialWriteSeed[]; queries: AdversarialQuery[] }> {
  const groups = new Map<string, { seeds: AdversarialWriteSeed[]; queries: AdversarialQuery[] }>();
  for (const q of fixture.queries) {
    const g = groups.get(q.scenario_id) ?? { seeds: [], queries: [] };
    g.queries.push(q);
    groups.set(q.scenario_id, g);
  }
  for (const s of fixture.seeds) {
    const g = groups.get(s.scenario_id);
    if (!g) continue; // orphan seed (no matching query); skip silently
    g.seeds.push(s);
  }
  return groups;
}

function getCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

async function seedScenario(dispatch: CoreDispatch, seeds: AdversarialWriteSeed[]): Promise<void> {
  for (const seed of seeds) {
    try {
      await dispatch.addMemory({
        claim: seed.content,
        subject: seed.subject ?? 'user',
        source: seed.source as 'user' | 'llm' | 'import',
        confidence: 0.95,
        validFrom: seed.validFrom,
        user_id: seed.user_id,
      });
    } catch (err) {
      // S53: refusal-first means injection-shaped seeds get rejected at the
      // write gate even under TEST_MODE. This is the correct behavior: a
      // poisoned claim should never enter the retrieval pool. The query loop
      // will then answer from legit seeds only and score `pass`. Log at debug
      // level only, every adversarial fixture is expected to trip this.
      // Anything that's NOT a ValidationError is a real error and re-throws.
      if (!(err instanceof ValidationError)) throw err;
    }
  }
}

export async function runSecurityBench(input: RunSecurityBenchInput): Promise<SecurityBenchReport> {
  const config: Config = loadConfig();

  // S52 fix: initialize embeddings ONCE before any scenario loop. Without
  // this, dispatch.addMemory() silently skips writing to memories_vec, then
  // dispatch.search() returns 0 candidates because vector retrieval is
  // empty and FTS5 alone can't bridge "What is my favorite color?" to
  // "favorite color is blue". Manifested as FRAME-INJECT 0/50 all
  // refused_legitimate (#1937).
  if (!embeddingsInitialized()) {
    try {
      await initializeEmbeddings(config.modelPath);
    } catch (err) {
      console.warn(
        'WARN: embeddings init failed; lexical-only retrieval. legitimate-fact recall will be near zero on natural-language questions:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const groups = groupByScenario(input.fixture);
  const results: SecurityBenchResult[] = [];

  for (const [, group] of groups.entries()) {
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    const dispatch = createCoreDispatch(repo, config);

    try {
      await seedScenario(dispatch, group.seeds);

      for (const query of group.queries) {
        const queryStart = performance.now();
        let predicted = '';
        let retrieval_ms = 0;
        try {
          const out = await input.dispatchFn(query, dispatch);
          predicted = out.predicted;
          retrieval_ms = out.retrieval_ms;
        } catch (err) {
          predicted = `[error] ${err instanceof Error ? err.message : String(err)}`;
        }
        const total_ms = performance.now() - queryStart;

        const score = scoreQuery(query, predicted);
        results.push({
          qid: query.qid,
          attack_pattern: query.attack_pattern,
          scenario_id: query.scenario_id,
          passed: score.passed,
          predicted,
          failure_mode: score.failure_mode,
          retrieval_ms,
          total_ms,
        });
      }
    } finally {
      await repo.close();
    }
  }

  const summary = summarize(results);
  const report: SecurityBenchReport = {
    benchmark: input.fixture.name,
    mode: input.fixture.mode,
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    config: {
      seed: input.seed,
      routed: input.routed,
      answerModel: input.answerModel,
      maxRules: input.maxRules,
    },
    summary,
    results,
  };

  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, JSON.stringify(report, null, 2));
  return report;
}

/**
 * Build the standard output path for a security bench run:
 *   benchmark-results/security-{name}-{mode}-{ISO}.json
 */
export function buildOutputPath(name: string, mode: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `benchmark-results/security-${name}-${mode}-${ts}.json`;
}
