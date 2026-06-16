#!/usr/bin/env npx tsx
/**
 * Difficulty Injection (S51 / D6), CLI.
 *
 * Loads a PublicBenchFixture-shaped JSON file, applies one or more
 * augmentations (entity-collision / four-hop / distractor-flood /
 * paraphrase-mix), and runs the same harness on both the base AND augmented
 * fixtures, then reports the delta.
 *
 * Why operate on PublicBenchFixture rather than ProductFixture: the
 * augmentation patterns are most informative on the existing public benches
 * (CloneMem / MAB / DialSim) where the engine is already strong. Running the
 * augmenter on a low-baseline fixture gives a noisy delta.
 *
 * Usage:
 *   npx tsx src/benchmark/product/difficulty/cli.ts \\
 *     --fixture-path fixtures/benchmark/product/difficulty/configs/demo.json \\
 *     --augment entity-collision,distractor-flood \\
 *     --mini --routed --seed 42
 *
 *   # Or, with a config-file shortcut for known augmentation presets:
 *   npx tsx src/benchmark/product/difficulty/cli.ts \\
 *     --fixture-path … --config fixtures/benchmark/product/difficulty/configs/entity-collision.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { callLLM } from '../../llm-caller.js';
import { runFixture } from '../../public/shared/run-fixture.js';
import {
  applyAugmentations,
  assertPublicBenchFixture,
  type AugmentationId,
  type AugmentOpts,
  AUGMENTERS,
} from './augmenter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  fixturePath: string;
  augmentations: AugmentationId[];
  configPath?: string;
  mode: 'mini' | 'full';
  routed: boolean;
  seed: number;
  answerModel: string;
  judgeModel: string;
  maxRules: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const fp = args.indexOf('--fixture-path');
  const fixturePath = fp !== -1 ? args[fp + 1] : undefined;
  if (!fixturePath) throw new Error('--fixture-path required');
  const cfg = args.indexOf('--config');
  const configPath = cfg !== -1 ? args[cfg + 1] : undefined;
  const aug = args.indexOf('--augment');
  let augmentations: AugmentationId[] = [];
  if (aug !== -1) {
    augmentations = (args[aug + 1] ?? '').split(',').filter(Boolean) as AugmentationId[];
  }
  for (const a of augmentations) {
    if (!(a in AUGMENTERS))
      throw new Error(`Unknown augmentation: ${a}. Choose from: ${Object.keys(AUGMENTERS).join(', ')}`);
  }
  const mode: 'mini' | 'full' = args.includes('--full') ? 'full' : 'mini';
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1] ?? '42', 10) : 42;
  const am = args.indexOf('--answer-model');
  const answerModel = am !== -1 ? (args[am + 1] ?? 'gpt-4o-mini') : 'gpt-4o-mini';
  const jm = args.indexOf('--judge-model');
  const judgeModel = jm !== -1 ? (args[jm + 1] ?? 'gpt-4o-mini') : 'gpt-4o-mini';
  const mr = args.indexOf('--max-rules');
  const maxRules = mr !== -1 ? parseInt(args[mr + 1] ?? '65', 10) : 65;

  const out: CliArgs = {
    fixturePath,
    augmentations,
    mode,
    routed: args.includes('--routed'),
    seed,
    answerModel,
    judgeModel,
    maxRules,
  };
  if (configPath) out.configPath = configPath;
  return out;
}

interface ConfigFile {
  augmentations: AugmentationId[];
  opts?: Partial<AugmentOpts>;
}

function loadConfig(path: string): ConfigFile {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as ConfigFile;
  if (!Array.isArray(data.augmentations)) throw new Error(`config ${path}: missing 'augmentations' array`);
  return data;
}

async function main(): Promise<void> {
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  process.env.BENCH_MODE = process.env.BENCH_MODE || 'true';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true'; // A2 back-compat alias

  const cli = parseArgs(process.argv);

  const baseFixture = assertPublicBenchFixture(JSON.parse(readFileSync(cli.fixturePath, 'utf-8')));
  baseFixture.mode = cli.mode;

  let augmentations = cli.augmentations;
  let augOpts: AugmentOpts = { seed: cli.seed };
  if (cli.configPath) {
    const cfg = loadConfig(cli.configPath);
    augmentations = cfg.augmentations;
    augOpts = { seed: cli.seed, ...(cfg.opts ?? {}) };
  }

  console.log(
    `Difficulty Injection: base=${baseFixture.bench_id} augmentations=[${augmentations.join(', ')}] mode=${cli.mode} routed=${cli.routed}`,
  );

  const augmentedFixture = applyAugmentations(baseFixture, augmentations, augOpts);

  console.log(
    `  base scenarios: ${baseFixture.scenarios.length}; augmented scenarios: ${augmentedFixture.scenarios.length}`,
  );
  const baseFactCount = baseFixture.scenarios.reduce((a, s) => a + s.facts.length, 0);
  const augFactCount = augmentedFixture.scenarios.reduce((a, s) => a + s.facts.length, 0);
  console.log(`  base facts: ${baseFactCount}; augmented facts: ${augFactCount}`);

  console.log('\n[1/2] Running BASE fixture...');
  const baseReport = await runFixture({
    fixture: baseFixture,
    answerModel: cli.answerModel,
    judgeModel: cli.judgeModel,
    maxRules: cli.maxRules,
    seed: cli.seed,
    callLLM,
  });

  console.log('\n[2/2] Running AUGMENTED fixture...');
  const augReport = await runFixture({
    fixture: augmentedFixture,
    answerModel: cli.answerModel,
    judgeModel: cli.judgeModel,
    maxRules: cli.maxRules,
    seed: cli.seed,
    callLLM,
  });

  const baseScore = baseReport.summary.accuracy;
  const augScore = augReport.summary.accuracy;
  const delta = augScore - baseScore;

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const summary = {
    benchmark: 'difficulty-injection',
    base_bench_id: baseFixture.bench_id,
    augmented_bench_id: augmentedFixture.bench_id,
    augmentations,
    augmentation_opts: augOpts,
    timestamp: new Date().toISOString(),
    commit,
    config: {
      mode: cli.mode,
      answerModel: cli.answerModel,
      judgeModel: cli.judgeModel,
      maxRules: cli.maxRules,
      seed: cli.seed,
    },
    base_score: baseScore,
    augmented_score: augScore,
    delta,
    base_summary: baseReport.summary,
    augmented_summary: augReport.summary,
  };

  const outDir = resolve(__dirname, '../../../../benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `difficulty-${cli.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`  → wrote ${out}`);

  console.log('\n=== Difficulty Injection Summary ===');
  console.log(`  Base accuracy:      ${(baseScore * 100).toFixed(1)}%`);
  console.log(`  Augmented accuracy: ${(augScore * 100).toFixed(1)}%`);
  console.log(
    `  Delta:              ${(delta * 100).toFixed(1)}pp ${delta < 0 ? '(degradation)' : '(robust or improved)'}`,
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
