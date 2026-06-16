#!/usr/bin/env npx tsx
/**
 * Cache-warm probe (S68, brain #2184).
 *
 * Every bench launcher must call this BEFORE firing the bench so the operator
 * knows whether to expect a 7-25min warm run or a 60-180min cold run. Aborts
 * unless BENCH_COLD_OK=1 is set when COLD detected.
 *
 * Usage:
 *   npx tsx scripts/cache-warm-probe.ts <bench-name>          # interactive abort on COLD
 *   npx tsx scripts/cache-warm-probe.ts <bench-name> --info-only   # never abort
 *   BENCH_COLD_OK=1 npx tsx scripts/cache-warm-probe.ts <bench-name>   # bypass abort
 *
 * Brain refs:
 *   #2087, Sprint 1 Section C persistent cache infra (M1+M9+M4)
 *   #2175, cache-key namespace coupling (multiSpeaker prompt swap busts)
 *   #2184, probe requirement
 */

import { getSharedCache } from '../src/cache/cache-store.js';

interface BenchTags {
  /** Tag prefix in judge_cache.judge_model (e.g. 'judge:lme-launcher'). Empty = no LLM judge. */
  judgeTagPrefix: string;
  /** Optional extractor model filter (rare; usually unset). */
  extractionModelPrefix?: string;
  /** Whether this bench uses the engine's extraction pipeline (Phase 1B benches do). */
  usesExtraction: boolean;
  /** Whether this bench fires episode hooks (S71 T4: same set as usesExtraction by default). */
  usesEpisodes?: boolean;
}

const BENCH_REGISTRY: Record<string, BenchTags> = {
  // === Phase 1B raw-text benches (extraction in loop) ===
  locomo: { judgeTagPrefix: 'judge:locomo', usesExtraction: true },
  beam: { judgeTagPrefix: 'judge:beam', usesExtraction: true },
  lme: { judgeTagPrefix: 'judge:lme-launcher', usesExtraction: true },
  // === LLM-judge benches (no extraction in their pipeline; pre-shaped facts) ===
  'intent-ambiguity': { judgeTagPrefix: 'judge:intent-ambig', usesExtraction: false },
  'multi-hop-chain': { judgeTagPrefix: 'judge:multi-hop', usesExtraction: false },
  'ece-brier': { judgeTagPrefix: 'judge:ece-brier', usesExtraction: false },
  dialsim: { judgeTagPrefix: 'judge:dialsim', usesExtraction: false },
  // attribution has TWO tags (source + date), cover both via shared prefix
  attribution: { judgeTagPrefix: 'judge:attribution', usesExtraction: false },
  paraphrase: { judgeTagPrefix: 'judge:paraphrase', usesExtraction: false },
  'stale-memory': { judgeTagPrefix: 'judge:stale-memory', usesExtraction: false },
  // === Deterministic-judge benches (no LLM judge; embedding cache only) ===
  'correction-propagation': { judgeTagPrefix: '', usesExtraction: false },
  'cross-session-temporal': { judgeTagPrefix: '', usesExtraction: false },
  'skin-persona': { judgeTagPrefix: '', usesExtraction: false },
  'cold-warm': { judgeTagPrefix: '', usesExtraction: false },
  // === Public benches (deterministic judges) ===
  clonemem: { judgeTagPrefix: '', usesExtraction: false },
  mab: { judgeTagPrefix: '', usesExtraction: false },
  // === Security / audit benches (no LLM judge) ===
  'frame-inject': { judgeTagPrefix: '', usesExtraction: false },
  'frame-sybil': { judgeTagPrefix: '', usesExtraction: false },
  'frame-audit': { judgeTagPrefix: '', usesExtraction: false },
  vault: { judgeTagPrefix: '', usesExtraction: false },
  // === Calibration recall (deterministic) ===
  recall: { judgeTagPrefix: '', usesExtraction: false },
};

/** Below these thresholds, that surface is COLD. */
const WARM_THRESHOLDS = {
  judge: 50,
  extraction: 100,
  embedding: 1000,
  episodes: 50,
};

interface ProbeResult {
  bench: string;
  judge: { entries: number; lastWrite: string | null; relevant: boolean };
  extraction: { entries: number; lastWrite: string | null; relevant: boolean };
  embedding: { entries: number; lastWrite: string | null };
  episodes: { entries: number; lastWrite: string | null; relevant: boolean };
  status: 'COLD' | 'WARM' | 'PARTIAL';
  expectedWallMinutes: { min: number; max: number };
}

const WALL_ESTIMATES = {
  WARM: { min: 7, max: 25 },
  PARTIAL: { min: 30, max: 90 },
  COLD: { min: 60, max: 180 },
};

function probe(bench: string): ProbeResult {
  const tags = BENCH_REGISTRY[bench];
  if (!tags) {
    throw new Error(`Unknown bench: ${bench}. Known benches: ${Object.keys(BENCH_REGISTRY).join(', ')}`);
  }

  const cache = getSharedCache();

  const judgeRes = tags.judgeTagPrefix
    ? cache.countJudgeByTagPrefix(tags.judgeTagPrefix)
    : { rows: 0, lastWriteIso: null };
  const extRes = tags.usesExtraction
    ? cache.countExtractionByModelPrefix(tags.extractionModelPrefix)
    : { rows: 0, lastWriteIso: null };
  const embRes = cache.countEmbedding();
  const epRes = cache.countEpisodeTitle();

  const judgeRelevant = !!tags.judgeTagPrefix;
  const extRelevant = tags.usesExtraction;
  // S71 T4: episode hooks fire from dispatch.ingest(), same set as extraction
  // unless explicitly overridden in registry.
  const epRelevant = tags.usesEpisodes ?? tags.usesExtraction;

  // Status logic:
  //   - Surfaces marked irrelevant don't influence status (e.g. deterministic
  //     judge benches don't need a judge cache to be warm).
  //   - WARM = all RELEVANT surfaces above threshold.
  //   - COLD = all RELEVANT surfaces below threshold.
  //   - PARTIAL = mixed.
  const judgeWarm = !judgeRelevant || judgeRes.rows >= WARM_THRESHOLDS.judge;
  const extWarm = !extRelevant || extRes.rows >= WARM_THRESHOLDS.extraction;
  const embWarm = embRes.rows >= WARM_THRESHOLDS.embedding;
  const epWarm = !epRelevant || epRes.rows >= WARM_THRESHOLDS.episodes;

  // For "cold" we want ALL relevant surfaces below threshold AND the bench
  // actually USES at least one of those surfaces. If a bench only uses the
  // embedding cache (deterministic-judge, no extraction), then embedding
  // alone determines warm/cold.
  const allRelevantSurfaces: Array<'judge' | 'extraction' | 'embedding'> = ['embedding'];
  if (judgeRelevant) allRelevantSurfaces.push('judge');
  if (extRelevant) allRelevantSurfaces.push('extraction');
  if (epRelevant) allRelevantSurfaces.push('episodes');

  const surfaceWarm: Record<string, boolean> = {
    judge: judgeWarm,
    extraction: extWarm,
    embedding: embWarm,
    episodes: epWarm,
  };

  const allWarm = allRelevantSurfaces.every((s) => surfaceWarm[s]);
  const allCold = allRelevantSurfaces.every((s) => !surfaceWarm[s]);

  let status: ProbeResult['status'];
  if (allWarm) status = 'WARM';
  else if (allCold) status = 'COLD';
  else status = 'PARTIAL';

  return {
    bench,
    judge: { entries: judgeRes.rows, lastWrite: judgeRes.lastWriteIso, relevant: judgeRelevant },
    extraction: { entries: extRes.rows, lastWrite: extRes.lastWriteIso, relevant: extRelevant },
    embedding: { entries: embRes.rows, lastWrite: embRes.lastWriteIso },
    episodes: { entries: epRes.rows, lastWrite: epRes.lastWriteIso, relevant: epRelevant },
    status,
    expectedWallMinutes: WALL_ESTIMATES[status],
  };
}

function fmtRel(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtRow(label: string, count: number, lastWrite: string | null, relevant: boolean): string {
  const c = count.toLocaleString().padStart(8);
  const rel = relevant
    ? count >= 100
      ? '← WARM'
      : count > 0
        ? '← partial'
        : '← COLD'
    : '(not relevant for this bench)';
  const lw = relevant && lastWrite ? `last: ${fmtRel(lastWrite)}` : '';
  return `  ${label.padEnd(22)} ${c} entries  ${rel.padEnd(12)} ${lw}`;
}

function printBanner(r: ProbeResult): void {
  const host = process.env.HOSTNAME || 'unknown';
  const commit = process.env.GIT_COMMIT || 'HEAD';
  const bar = '='.repeat(72);
  console.error(bar);
  console.error(`  CACHE WARM PROBE  bench=${r.bench}  host=${host}  commit=${commit}`);
  console.error(bar);
  console.error(fmtRow('extraction_cache', r.extraction.entries, r.extraction.lastWrite, r.extraction.relevant));
  console.error(fmtRow('judge_cache', r.judge.entries, r.judge.lastWrite, r.judge.relevant));
  console.error(fmtRow('embedding_cache', r.embedding.entries, r.embedding.lastWrite, true));
  console.error(fmtRow('episode_title_cache', r.episodes.entries, r.episodes.lastWrite, r.episodes.relevant));
  console.error(bar);
  const wm = r.expectedWallMinutes;
  console.error(`  STATUS: ${r.status}, expect ~${wm.min}-${wm.max}min wall`);
  if (r.status === 'COLD') {
    console.error('  → Cold runs cost 5-25× warm wall AND ~$2-4 in extraction LLM spend.');
    console.error('  → Set BENCH_COLD_OK=1 to bypass this abort.');
  }
  console.error(bar);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bench = args[0];
  const infoOnly = args.includes('--info-only');

  if (!bench) {
    console.error('Usage: npx tsx scripts/cache-warm-probe.ts <bench-name> [--info-only]');
    console.error(`Known benches: ${Object.keys(BENCH_REGISTRY).join(', ')}`);
    process.exit(2);
  }

  const result = probe(bench);
  printBanner(result);

  if (infoOnly) return;

  if (result.status === 'COLD' && process.env.BENCH_COLD_OK !== '1') {
    console.error('ABORT: bench cache is COLD and BENCH_COLD_OK is not set.');
    process.exit(1);
  }
}

// Run when invoked directly via tsx (not when imported by tests).
const isMain = process.argv[1] && process.argv[1].endsWith('cache-warm-probe.ts');
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { probe, printBanner, BENCH_REGISTRY, WARM_THRESHOLDS };
export type { ProbeResult };
