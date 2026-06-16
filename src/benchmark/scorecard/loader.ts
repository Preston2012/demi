/**
 * Product scorecard, archive loader (S78).
 *
 * Globs a directory of bench result JSONs (the committed `benchmark-archive/`,
 * including its `cax21/` subdirectory), parses each, classifies it to a
 * `BenchId`, and resolves the provenance the rest of the tool needs: commit,
 * Q-tier, timestamp, config block, manifest block, summary, and the raw rows.
 *
 * Two bench shapes have no per-question `results` array and are out of v1
 * scope (spec §9): amb (per-dimension aggregate) and recall (cluster dict).
 * They are recorded in `skipped` with a reason rather than dropped silently -
 * a skipped bench must always be visible (spec §8).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type {
  BenchFile,
  BenchHost,
  BenchId,
  KnownBenchPrefix,
  LoadResult,
  ManifestBlock,
  QTier,
  RawRecord,
  SkippedFile,
} from './types.js';
import { ScorecardError } from './types.js';

/**
 * Filename-prefix → bench, longest-prefix-first so `security-frame-inject`
 * is tried before any shorter accidental match and `longmemeval` before a
 * hypothetical `long`. Every recognised prefix is here, including the two we
 * skip, so an unrecognised file is loud rather than mis-bucketed.
 */
const BENCH_PREFIXES: Array<{ prefix: string; bench: KnownBenchPrefix }> = [
  { prefix: 'security-frame-inject', bench: 'security-frame-inject' },
  { prefix: 'longmemeval', bench: 'longmemeval' },
  { prefix: 'ece-brier', bench: 'ece-brier' },
  { prefix: 'clonemem', bench: 'clonemem' },
  { prefix: 'dialsim', bench: 'dialsim' },
  { prefix: 'locomo', bench: 'locomo' },
  { prefix: 'recall', bench: 'recall' },
  { prefix: 'beam', bench: 'beam' },
  { prefix: 'amb', bench: 'amb' },
  { prefix: 'mab', bench: 'mab' },
];

/** Benches we recognise but deliberately do not normalize in v1. */
const SKIP_BENCHES: Record<string, string> = {
  amb: 'per-dimension aggregate (no per-question results array); security section is a separate v2 add (spec §9)',
  recall: 'cluster-shaped (no per-question results array); retrieval-recall section is v2 (spec §9)',
};

function detectBench(filename: string): KnownBenchPrefix | null {
  for (const { prefix, bench } of BENCH_PREFIXES) {
    if (filename.startsWith(prefix)) return bench;
  }
  return null;
}

/** Recursively collect *.json paths under `dir` (archive is one level deep). */
function walkJson(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new ScorecardError(`results path not found or not readable: ${dir}`);
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkJson(full));
    } else if (name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function hostFromPath(path: string): BenchHost {
  return /(^|\/)cax21(\/|$)/.test(path) ? 'cax21' : 'cax11';
}

/** Resolve the 40-char commit from wherever this bench stores it. */
function resolveCommit(
  json: Record<string, unknown>,
  manifest: ManifestBlock | null,
  filename: string,
): { commit: string; shortCommit: string } {
  const fromManifest = manifest?.commit_sha;
  const fromTop = typeof json.commit === 'string' ? (json.commit as string) : undefined;
  const commit = fromManifest ?? fromTop ?? '';
  if (commit && commit !== 'local') {
    return { commit, shortCommit: commit.slice(0, 7) };
  }
  // Fall back to the 7-char short SHA embedded in the filename, when present:
  // `<bench>-<scope>-<7hex>-<ISO timestamp>.json`. The timestamp starts with a
  // 4-digit year, so a 7-hex token immediately before a `-YYYY-` is the SHA.
  const m = filename.match(/-([0-9a-f]{7})-\d{4}-\d{2}-\d{2}T/);
  if (m && m[1]) return { commit, shortCommit: m[1] };
  return { commit, shortCommit: commit ? commit.slice(0, 7) : commit || 'local' };
}

/**
 * Resolve a canonical Q-tier string from the config/manifest blocks (reliable)
 * with a filename fallback. Combines size (100K/500K/100k) with scope
 * (mini/full) so beam-100k-mini and beam-500k-mini never collapse together.
 */
function resolveQTier(config: Record<string, unknown>, manifest: ManifestBlock | null, filename: string): QTier {
  const size = typeof config.size === 'string' ? config.size : typeof config.tier === 'string' ? config.tier : null;
  let scope: string | null =
    (typeof manifest?.scope_label === 'string' ? manifest.scope_label : null) ??
    (typeof config.mode === 'string' ? (config.mode as string) : null) ??
    (config.mini === true ? 'mini' : null);
  if (!scope) {
    if (/-full-|_full|\bfull\b/.test(filename)) scope = 'full';
    else if (/-mini-|_mini|\bmini\b/.test(filename)) scope = 'mini';
  }
  if (!scope) scope = 'full';
  const tier = [size, scope].filter(Boolean).join('-').toLowerCase();
  return tier || 'unknown';
}

function asRecordArray(v: unknown): RawRecord[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((r): r is RawRecord => typeof r === 'object' && r !== null);
}

/**
 * Parse and classify a single file. Returns either a BenchFile or a
 * SkippedFile (for amb/recall, unrecognised prefixes, unparseable JSON, or a
 * recognised per-question bench that unexpectedly lacks a `results` array).
 */
export function loadOne(path: string): { file: BenchFile } | { skipped: SkippedFile } {
  const filename = basename(path);
  const prefix = detectBench(filename);
  if (!prefix) {
    return { skipped: { path, filename, prefix: 'unknown', reason: 'unrecognised bench filename prefix' } };
  }
  if (prefix in SKIP_BENCHES) {
    return { skipped: { path, filename, prefix, reason: SKIP_BENCHES[prefix]! } };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return { skipped: { path, filename, prefix, reason: `unparseable JSON: ${(e as Error).message}` } };
  }

  const rawResults = asRecordArray(json.results);
  if (!rawResults || rawResults.length === 0) {
    return {
      skipped: { path, filename, prefix, reason: 'no non-empty `results` array (empty or aggregate-only run)' },
    };
  }

  const bench = prefix as BenchId;
  const config = (typeof json.config === 'object' && json.config !== null ? json.config : {}) as Record<
    string,
    unknown
  >;
  const manifest =
    typeof json.manifest === 'object' && json.manifest !== null ? (json.manifest as ManifestBlock) : null;
  const summary =
    typeof json.summary === 'object' && json.summary !== null ? (json.summary as Record<string, unknown>) : null;
  const { commit, shortCommit } = resolveCommit(json, manifest, filename);
  const qtier = resolveQTier(config, manifest, filename);
  const timestamp = typeof json.timestamp === 'string' ? json.timestamp : '';
  const upstream =
    typeof json.upstream === 'string'
      ? (json.upstream as string)
      : typeof json.upstream === 'object' && json.upstream !== null
        ? JSON.stringify(json.upstream)
        : null;

  return {
    file: {
      path,
      filename,
      bench,
      host: hostFromPath(path),
      commit,
      shortCommit,
      qtier,
      timestamp,
      config,
      manifest,
      upstream,
      summary,
      rawResults,
    },
  };
}

/**
 * Load every result JSON under `dir` (recursively). Accepts either a directory
 * or a single .json file path. Returns the loaded BenchFiles plus the skipped
 * list. Sorted by (bench, timestamp) for deterministic downstream output.
 */
export function loadArchive(dir: string): LoadResult {
  let paths: string[];
  const st = statSync(dir);
  if (st.isDirectory()) {
    paths = walkJson(dir);
  } else if (dir.endsWith('.json')) {
    paths = [dir];
  } else {
    throw new ScorecardError(`--results must be a directory or a .json file: ${dir}`);
  }

  const files: BenchFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const p of paths.sort()) {
    const res = loadOne(p);
    if ('file' in res) files.push(res.file);
    else skipped.push(res.skipped);
  }
  files.sort((a, b) => (a.bench === b.bench ? a.timestamp.localeCompare(b.timestamp) : a.bench.localeCompare(b.bench)));
  return { files, skipped };
}
