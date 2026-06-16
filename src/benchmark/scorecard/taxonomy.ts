/**
 * Product scorecard, unified taxonomy (S78).
 *
 * The DEEP views (spec §5) pool across benches by ONE query_type column. The
 * recorded `query_type` is too sparse and inconsistent across runs to anchor a
 * cross-run time series (it was added partway through the archive window and is
 * present on only some runs of beam/locomo/lme, see the plan). So the
 * scorecard classifies EVERY question with the in-tree engine classifier
 * `classifyQuery()` to produce one consistent `query_type_unified`, and keeps
 * the recorded label as a cross-check with a divergence report (spec §2, §11).
 *
 * `classifyQuery()` is a pure heuristic (no LLM, no network). Its one side
 * effect, `recordDecision()`, is a no-op without a telemetry context
 * (src/telemetry/trace.ts early-returns on `!ctx`), so calling it offline here
 * writes nothing. Results are cached in a sidecar keyed by the classifier's
 * content hash, so a classifier change auto-invalidates the cache and re-runs
 * are free.
 *
 * "One definition per dimension, always" (spec §11): sub-labels are derived by
 * reading the unified string exactly (temporal vs multi-hop), never by a second
 * keyword guess.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyQuery, type QueryType } from '../../retrieval/query-classifier.js';
import type { BenchId, DivergenceReport, NormalizedRecord } from './types.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Resolve the classifier source path so its content hash stamps the taxonomy.
 *  Under tsx this module sits next to the .ts source tree. */
function classifierSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const ext of ['ts', 'js']) {
    const cand = resolve(here, `../../retrieval/query-classifier.${ext}`);
    if (existsSync(cand)) return cand;
  }
  return resolve(process.cwd(), 'src/retrieval/query-classifier.ts');
}

let _classifierHash: string | null = null;

/**
 * Content hash of the classifier that produces the unified taxonomy. Stamped
 * into every report and baseline so a classifier change is visible and the gate
 * can warn on a taxonomy mismatch. Mirrors how manifest.ts stamps
 * `classifier_commit`. Memoized (the file does not change within a run).
 */
export function classifierHash(): string {
  if (_classifierHash) return _classifierHash;
  try {
    _classifierHash = sha256(readFileSync(classifierSourcePath(), 'utf-8'));
  } catch {
    // Fall back to hashing the live function so output is still stamped, just
    // less precisely; flagged with a prefix so the degradation is visible.
    _classifierHash = 'fn-' + sha256(classifyQuery.toString());
  }
  return _classifierHash;
}

const DEFAULT_CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.cache');

export interface ClassifyOptions {
  /** Directory for the sidecar classifier cache. Default: scorecard/.cache. */
  cacheDir?: string;
  /** When true, do not read or write the on-disk cache (pure in-memory). Used
   *  by strict read-only contexts (e.g. CI) where no fs write is acceptable. */
  noCache?: boolean;
}

export interface ClassifyResult {
  classifier_hash: string;
  total: number;
  cache_hits: number;
  cache_misses: number;
  cache_path: string | null;
}

interface CacheShape {
  classifier_hash: string;
  entries: Record<string, QueryType>;
}

function cachePathFor(cacheDir: string, hash: string): string {
  return join(cacheDir, `classifier-${hash.slice(0, 12)}.json`);
}

function loadCache(path: string, hash: string): Record<string, QueryType> {
  if (!existsSync(path)) return {};
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8')) as CacheShape;
    // A hash mismatch means a stale cache from a different classifier; ignore it.
    return c.classifier_hash === hash && c.entries ? c.entries : {};
  } catch {
    return {};
  }
}

/**
 * Fill `query_type_unified` on every record (in place) by classifying its
 * question, set `query_type_diverged` against the recorded label, and cache the
 * classifications. Idempotent: a second call is fully cache-served.
 */
export function classifyAll(records: NormalizedRecord[], opts: ClassifyOptions = {}): ClassifyResult {
  const hash = classifierHash();
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const cachePath = opts.noCache ? null : cachePathFor(cacheDir, hash);
  const cache: Record<string, QueryType> = cachePath ? loadCache(cachePath, hash) : {};

  let hits = 0;
  let misses = 0;
  let dirty = false;
  for (const r of records) {
    let qt = cache[r.question_hash];
    if (qt) {
      hits++;
    } else {
      qt = classifyQuery(r.question);
      cache[r.question_hash] = qt;
      misses++;
      dirty = true;
    }
    r.query_type_unified = qt;
    r.query_type_diverged = r.query_type_recorded !== null && r.query_type_recorded !== qt;
  }

  if (cachePath && dirty) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const out: CacheShape = { classifier_hash: hash, entries: cache };
      writeFileSync(cachePath, JSON.stringify(out));
    } catch {
      // A cache write failure must never break a read-only report.
    }
  }

  return {
    classifier_hash: hash,
    total: records.length,
    cache_hits: hits,
    cache_misses: misses,
    cache_path: cachePath,
  };
}

/**
 * Divergence between the recorded `query_type` (where a run stored it) and the
 * unified classification. A high rate means the recorded labels came from a
 * different classifier version than the in-tree one, itself a drift signal,
 * and a caveat on pooling unified-only benches against benches that also carry
 * a recorded label.
 */
export function buildDivergenceReport(records: NormalizedRecord[]): DivergenceReport {
  const perBench = new Map<BenchId, { withRecorded: number; diverged: number; confusion: Map<string, number> }>();
  for (const r of records) {
    if (r.query_type_recorded === null) continue;
    let e = perBench.get(r.bench);
    if (!e) {
      e = { withRecorded: 0, diverged: 0, confusion: new Map() };
      perBench.set(r.bench, e);
    }
    e.withRecorded++;
    if (r.query_type_diverged) e.diverged++;
    const key = `${r.query_type_recorded}→${r.query_type_unified}`;
    e.confusion.set(key, (e.confusion.get(key) ?? 0) + 1);
  }

  return {
    per_bench: [...perBench.entries()]
      .map(([bench, e]) => ({
        bench,
        n_with_recorded: e.withRecorded,
        n_diverged: e.diverged,
        divergence_rate: e.withRecorded ? e.diverged / e.withRecorded : 0,
        confusion: [...e.confusion.entries()]
          .map(([k, n]) => {
            const [recorded, unified] = k.split('→');
            return { recorded: recorded ?? '', unified: unified ?? '', n };
          })
          .sort((a, b) => b.n - a.n),
      }))
      .sort((a, b) => a.bench.localeCompare(b.bench)),
  };
}

// ---- sub-label predicates: read the unified string exactly (spec §11) ----

export function isTemporal(queryTypeUnified: string): boolean {
  return queryTypeUnified === 'temporal' || queryTypeUnified === 'temporal-multi-hop';
}
export function isMultiHop(queryTypeUnified: string): boolean {
  return queryTypeUnified === 'multi-hop' || queryTypeUnified === 'temporal-multi-hop';
}
export function isSingleHop(queryTypeUnified: string): boolean {
  return queryTypeUnified === 'single-hop';
}
/** temporal-single vs temporal-multi, by reading the string (not re-guessing). */
export function temporalSub(queryTypeUnified: string): 'temporal-single' | 'temporal-multi' | null {
  if (queryTypeUnified === 'temporal') return 'temporal-single';
  if (queryTypeUnified === 'temporal-multi-hop') return 'temporal-multi';
  return null;
}
