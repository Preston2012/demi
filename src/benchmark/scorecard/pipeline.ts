/**
 * Product scorecard, ingest pipeline (S78).
 *
 * One entry point that turns a results directory into the fully-populated
 * NormalizedRecord list every downstream module reads: load → normalize →
 * attach config fingerprint → classify (unified taxonomy). Both the CLI and the
 * tests build records through here so they exercise the exact same path.
 */

import { loadArchive } from './loader.js';
import { normalize, type NormalizeOptions } from './normalize.js';
import { fingerprint } from './fingerprint.js';
import { classifyAll, type ClassifyOptions, type ClassifyResult } from './taxonomy.js';
import type { BenchFile, BenchId, ConfigFingerprint, NormalizedRecord, SkippedFile } from './types.js';

export interface BuildOptions extends NormalizeOptions, ClassifyOptions {
  /** Restrict to a single bench. */
  bench?: BenchId;
  /** Restrict to runs whose commit starts with this (short) sha. */
  commit?: string;
}

export interface BuildResult {
  records: NormalizedRecord[];
  files: BenchFile[];
  skipped: SkippedFile[];
  fingerprints: Map<string, ConfigFingerprint>;
  classify: ClassifyResult;
}

/** Build the normalized, fingerprinted, classified record set from a dir/file. */
export function buildRecords(dir: string, opts: BuildOptions): BuildResult {
  const { files: allFiles, skipped } = loadArchive(dir);

  const files = allFiles.filter((f) => {
    if (opts.bench && f.bench !== opts.bench) return false;
    if (opts.commit && !f.commit.startsWith(opts.commit) && !f.shortCommit.startsWith(opts.commit)) return false;
    return true;
  });

  const fingerprints = new Map<string, ConfigFingerprint>();
  const records: NormalizedRecord[] = [];
  for (const file of files) {
    const fp = fingerprint(file);
    fingerprints.set(fp.hash, fp);
    const recs = normalize(file, opts);
    for (const r of recs) r.fingerprint = fp.hash;
    records.push(...recs);
  }

  const classify = classifyAll(records, opts);
  return { records, files, skipped, fingerprints, classify };
}

/**
 * Select the report's current-state rows. Prefers the latest GOLDEN production
 * config per (bench, Q-tier) and keeps every run sharing that fingerprint, so
 * an experiment never leaks into the product number and repeats aggregate.
 * Variance and the time series read the full record set instead. A
 * (bench, Q-tier) with no golden run falls back to its latest run.
 */
export function selectLatestRuns(
  records: NormalizedRecord[],
  fingerprints?: Map<string, ConfigFingerprint>,
): NormalizedRecord[] {
  // Prefer the GOLDEN production config so an experiment (reranker/routing/model
  // A/B) can never become the product number. Pick the latest golden fingerprint
  // per (bench, Q-tier), then keep EVERY golden run sharing it (same config,
  // commit, fixtures) so the report aggregates all repeats, not one noisy draw.
  // A (bench, Q-tier) with no golden run falls back to its latest run.
  const isGoldenFp = (h: string): boolean => (fingerprints ? (fingerprints.get(h)?.is_golden ?? false) : true);

  const latestGoldenFp = new Map<string, { ts: string; fp: string }>();
  for (const r of records) {
    if (!isGoldenFp(r.fingerprint)) continue;
    const k = `${r.bench}|${r.qtier}`;
    const cur = latestGoldenFp.get(k);
    if (!cur || r.run_timestamp > cur.ts) latestGoldenFp.set(k, { ts: r.run_timestamp, fp: r.fingerprint });
  }

  const latestAnyTs = new Map<string, string>();
  for (const r of records) {
    const k = `${r.bench}|${r.qtier}`;
    const cur = latestAnyTs.get(k);
    if (!cur || r.run_timestamp > cur) latestAnyTs.set(k, r.run_timestamp);
  }

  return records.filter((r) => {
    const k = `${r.bench}|${r.qtier}`;
    const golden = latestGoldenFp.get(k);
    if (golden) return r.fingerprint === golden.fp;
    return latestAnyTs.get(k) === r.run_timestamp;
  });
}
