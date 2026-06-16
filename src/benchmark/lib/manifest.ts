/**
 * Bench result manifest (S63 Tier 0.4, BRAVO-MANIFEST).
 *
 * Why this exists: S62 council R33 generated three phantom regression calls
 * by reading bench numbers stripped of their runtime context. The cure is
 * structural, every bench result emits a manifest documenting exactly what
 * was measured. Comparison helpers refuse to compare across mismatched
 * manifests. Filenames carry commit short SHAs.
 *
 * Production-blocked. Bench-only.
 *
 * Brain memory references:
 *   S62 council R33: phantom regression class (LOCOMO 50.68%, HaluMem 3.16%, BEAM 52.13%)
 *   #2044: nowIso plumbing (B19-D)
 *   #2032: pre-flight checklist (manifest is the structural fix at result-emit time)
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onByDefault } from '../../config/flag-defaults.js';

export enum AdapterMode {
  /** Raw input → DeepSeek extraction → engine write. The "real" production path. */
  PRODUCT_PATH = 'product_path',
  /** Pre-extracted facts seeded directly. Tests storage/retrieval/answer only. */
  ENGINE_PATH = 'engine_path_preextracted',
  /** Fixture-specific parsing/cleanup. Internal-only diagnostics. */
  ADAPTER_ASSISTED = 'adapter_assisted',
  /** License-limited, small-N, broken adapter. Numbers cannot be cited. */
  DIAGNOSTIC_ONLY = 'diagnostic_only',
  /** Feature didn't fire, missing canonicalFactId, broken circuit breaker.
   *  Numbers MUST NOT be cited. */
  INVALID = 'invalid',
}

export interface ResultManifest {
  /** git rev-parse HEAD at run-start. */
  commit_sha: string;
  /** git status --porcelain non-empty at run-start. */
  dirty_worktree: boolean;
  /** Listing of dirty paths if dirty_worktree=true. Empty array otherwise. */
  dirty_paths: string[];
  /** Optional: container image SHA when bench runs in a container. */
  container_image_hash: string | null;
  /** Exact model strings used for each role. */
  model_pins: {
    answer: string;
    judge: string;
    embed: string;
  };
  /** sha256 of relevant env vars + flags + classifier commit. */
  env_config_hash: string;
  /** Inputs to env_config_hash, for human inspection. */
  env_config_inputs: {
    ANSWER_ROUTING: string;
    BI_TEMPORAL_ENABLED: string;
    STONE_ENABLED: string;
    RERANKER_ENABLED: string;
    EPISODES_ENABLED: string;
    REEXTRACT_ENABLED: string;
    COMPRESSION_ROUTER_ENABLED: string;
    RETRIEVAL_FRESHEST_BY_SUBJECT: string;
    ENTITY_BOOST_ENABLED: string;
    HYBRID_FUSION_MODE: string;
    ENTITY_SPLIT_TEMPORAL: string;
    classifier_commit: string;
    max_rules: number;
    cli_flags: string;
  };
  /** Source / version of the fixture being run. */
  fixture_version: string;
  /** Source / version of the scorer being applied. */
  scorer_version: string;
  /** Which adapter mode this run is. Declared per-runner, not free-text. */
  adapter_mode: AdapterMode;
  /** Number of questions actually scored. */
  sample_size: number;
  /** Human label: 'mini' | 'full' | 'smoke' | custom string. */
  scope_label: string;
  /** ISO 8601 wall-clock at run-start. */
  date_iso: string;
  /** Hash of the bench runner script file. Catches runner mutation. */
  bench_runner_version: string;
  /** Whether nowIso plumbing fired in the run (B19-D wiring active). */
  nowIso_passed: boolean;
}

const TRACKED_ENV_VARS = [
  'ANSWER_ROUTING',
  'BI_TEMPORAL_ENABLED',
  'STONE_ENABLED',
  'RERANKER_ENABLED',
  'EPISODES_ENABLED',
  'REEXTRACT_ENABLED',
  'COMPRESSION_ROUTER_ENABLED',
  'RETRIEVAL_FRESHEST_BY_SUBJECT',
  'ENTITY_BOOST_ENABLED',
  'HYBRID_FUSION_MODE',
  'ENTITY_SPLIT_TEMPORAL',
  'MATERIALIZER_ENABLED',
  'STONE_ENABLED_FOR_MATERIALIZER',
  'CALIBRATED_ADJUDICATOR_ENABLED',
] as const;

const CLASSIFIER_PATH = 'src/retrieval/query-classifier.ts';

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function gitRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

// Golden Stack default-ON flags: the manifest must record the EFFECTIVE value,
// not the raw process.env string. After the default-ON change an unset flag is
// effectively ON, so recording the raw "" would be a lie about what the engine
// actually ran, and the manifest is the audit surface that diagnosed the S77
// 4pp regression (an unset ENTITY_SPLIT_TEMPORAL). These resolvers mirror the
// engine's own defaulting so recorded config and effective config cannot diverge.
const EFFECTIVE_ENV_RESOLVERS: Partial<Record<(typeof TRACKED_ENV_VARS)[number], () => string>> = {
  EPISODES_ENABLED: () => String(onByDefault(process.env.EPISODES_ENABLED)),
  ENTITY_SPLIT_TEMPORAL: () => String(onByDefault(process.env.ENTITY_SPLIT_TEMPORAL)),
  ENTITY_BOOST_ENABLED: () => String(onByDefault(process.env.ENTITY_BOOST_ENABLED)),
  BI_TEMPORAL_ENABLED: () => String(onByDefault(process.env.BI_TEMPORAL_ENABLED)),
  HYBRID_FUSION_MODE: () => process.env.HYBRID_FUSION_MODE ?? 'additive',
  // RETRIEVAL_FRESHEST_BY_SUBJECT stays default-OFF (golden value is `off`); the
  // engine resolves `?? 'off'`, so record that to stay honest about the default.
  RETRIEVAL_FRESHEST_BY_SUBJECT: () => (process.env.RETRIEVAL_FRESHEST_BY_SUBJECT ?? 'off').toLowerCase(),
};

function readEnvVars(): Record<(typeof TRACKED_ENV_VARS)[number], string> {
  const out = {} as Record<(typeof TRACKED_ENV_VARS)[number], string>;
  for (const k of TRACKED_ENV_VARS) {
    const resolver = EFFECTIVE_ENV_RESOLVERS[k];
    out[k] = resolver ? resolver() : (process.env[k] ?? '');
  }
  return out;
}

/**
 * Compute the manifest at run-start. Caller passes runtime details that
 * can't be discovered from env (model pins, fixture version, scope label,
 * adapter mode). Everything else is read from environment + git.
 *
 * Throws if the runner script specifically has uncommitted changes vs
 * HEAD, catches dirty-worktree bench runs that would silently drift from
 * main. Pass `_skipDriftCheck: true` (wired to the runner's
 * `--allow-dirty-runner` flag) to override.
 *
 * Production-blocked. Bench-only.
 */
export function computeManifest(args: {
  runnerPath: string;
  modelPins: ResultManifest['model_pins'];
  fixtureVersion: string;
  scorerVersion: string;
  adapterMode: AdapterMode;
  sampleSize: number;
  scopeLabel: string;
  cliFlags: string[];
  maxRules: number;
  nowIsoPassed: boolean;
  _skipDriftCheck?: boolean;
}): ResultManifest {
  const root = gitRoot();
  const commit_sha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: root }).trim();

  const porcelain = execSync('git status --porcelain', { encoding: 'utf-8', cwd: root }).trim();
  const dirty_worktree = porcelain.length > 0;
  const dirty_paths = dirty_worktree
    ? porcelain
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((p) => p.length > 0)
    : [];

  const runnerPorcelain = execSync(`git status --porcelain -- ${args.runnerPath}`, {
    encoding: 'utf-8',
    cwd: root,
  }).trim();
  const runnerDirty = runnerPorcelain.length > 0;
  if (runnerDirty && !args._skipDriftCheck) {
    throw new Error(
      `bench runner ${args.runnerPath} has uncommitted changes vs HEAD; ` +
        `pass --allow-dirty-runner to override (run is NOT reproducible)`,
    );
  }

  const runnerAbs = resolve(root, args.runnerPath);
  const bench_runner_version = sha256(readFileSync(runnerAbs));

  const classifierAbs = resolve(root, CLASSIFIER_PATH);
  const classifier_commit = sha256(readFileSync(classifierAbs));

  const envSnapshot = readEnvVars();
  const env_config_inputs: ResultManifest['env_config_inputs'] = {
    ...envSnapshot,
    classifier_commit,
    max_rules: args.maxRules,
    cli_flags: args.cliFlags.join(' '),
  };
  const env_config_hash = sha256(JSON.stringify(env_config_inputs));

  const container_image_hash = process.env.CONTAINER_IMAGE_HASH ?? null;

  return {
    commit_sha,
    dirty_worktree,
    dirty_paths,
    container_image_hash,
    model_pins: args.modelPins,
    env_config_hash,
    env_config_inputs,
    fixture_version: args.fixtureVersion,
    scorer_version: args.scorerVersion,
    adapter_mode: args.adapterMode,
    sample_size: args.sampleSize,
    scope_label: args.scopeLabel,
    date_iso: new Date().toISOString(),
    bench_runner_version,
    nowIso_passed: args.nowIsoPassed,
  };
}

export class BenchManifestMismatchError extends Error {
  readonly differences: Array<{ field: string; a: unknown; b: unknown }>;
  constructor(differences: Array<{ field: string; a: unknown; b: unknown }>) {
    const lines = differences.map((d) => `  ${d.field}: ${JSON.stringify(d.a)} != ${JSON.stringify(d.b)}`);
    super(`manifests are not comparable:\n${lines.join('\n')}`);
    this.name = 'BenchManifestMismatchError';
    this.differences = differences;
  }
}

/**
 * Check whether two manifests are comparable (same commit, models, fixture,
 * scorer, adapter mode, scope, runner version, env config). Throws
 * BenchManifestMismatchError with structured detail when they differ.
 *
 * Use before printing any "vs baseline" delta.
 *
 * Note: dirty_worktree, dirty_paths, date_iso, sample_size, nowIso_passed,
 * container_image_hash, and env_config_inputs are NOT compared, they're
 * either run-specific metadata or already rolled into env_config_hash.
 */
export function assertComparableManifests(a: ResultManifest, b: ResultManifest): void {
  const diffs: Array<{ field: string; a: unknown; b: unknown }> = [];
  const cmp = (field: string, av: unknown, bv: unknown): void => {
    if (av !== bv) diffs.push({ field, a: av, b: bv });
  };
  cmp('commit_sha', a.commit_sha, b.commit_sha);
  cmp('model_pins.answer', a.model_pins.answer, b.model_pins.answer);
  cmp('model_pins.judge', a.model_pins.judge, b.model_pins.judge);
  cmp('model_pins.embed', a.model_pins.embed, b.model_pins.embed);
  cmp('env_config_hash', a.env_config_hash, b.env_config_hash);
  cmp('fixture_version', a.fixture_version, b.fixture_version);
  cmp('scorer_version', a.scorer_version, b.scorer_version);
  cmp('adapter_mode', a.adapter_mode, b.adapter_mode);
  cmp('scope_label', a.scope_label, b.scope_label);
  cmp('bench_runner_version', a.bench_runner_version, b.bench_runner_version);
  if (diffs.length > 0) throw new BenchManifestMismatchError(diffs);
}

/**
 * Filename helper: produces `${bench}-${scope}-${shortSha}-${ISO}.json`.
 * Example: `beam-100k-mini-9050914-2026-05-08T04-56-35-414Z.json`.
 */
export function manifestedFilename(args: { bench: string; scope: string; manifest: ResultManifest }): string {
  const shortSha = args.manifest.commit_sha.slice(0, 7);
  const ts = args.manifest.date_iso.replace(/[:.]/g, '-');
  return `${args.bench}-${args.scope}-${shortSha}-${ts}.json`;
}
