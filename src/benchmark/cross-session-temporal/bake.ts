#!/usr/bin/env npx tsx
/**
 * Bench 2 (Cross-Session Temporal), offline fixture baker (S68 v2).
 *
 * Generates the fixture with embedding-aware rejection sampling so every
 * pair of facts has cosine < MAX_COSINE_AT_BAKE. Resulting fixture is
 * committed to git so the bench runs deterministically.
 *
 * Strategy:
 *   1. For each session, pick a theme (round-robin across THEMES).
 *   2. Generate a candidate fact via `templates.buildFact()`.
 *   3. Embed with BGE-small.
 *   4. Compare against all previously-accepted facts. If max sim >=
 *      MAX_COSINE_AT_BAKE, reject the candidate and try again.
 *   5. Per-session candidate budget = 50 (if exceeded, the pools are too
 *      small for the session size, bake aborts with a clear message).
 *   6. Build questions over the accepted facts (same logic as v1).
 *   7. Write fixture JSON + manifest.
 *
 * Why MAX_COSINE_AT_BAKE = 0.92 (not 0.95):
 *   - 0.95 is the engine dedup threshold (src/write/dedup.ts).
 *   - We bake to 0.92 to give a 0.03 safety margin against minor BGE drift,
 *     prompt changes, or future model upgrades. If a future BGE pushes a
 *     borderline pair above 0.95, the runner's verifyFixturePairwise()
 *     catches it and demands a re-bake.
 *
 * Run:
 *   npx tsx src/benchmark/cross-session-temporal/bake.ts --mode mini
 *   npx tsx src/benchmark/cross-session-temporal/bake.ts --mode full
 *
 * Outputs:
 *   src/benchmark/cross-session-temporal/fixtures/scenarios-{mini,full}.json
 *   src/benchmark/cross-session-temporal/fixtures/manifest-{mini,full}.json
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

import { initialize, encode, isInitialized } from '../../embeddings/index.js';
import { loadConfig } from '../../config.js';
import { buildFact, THEMES } from './templates.js';
import type { CSTFixture, CSTQuestion, Fact, Session, FixtureManifest, Theme } from './generator-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE_VERSION = '2.0.0';
const MAX_COSINE_AT_BAKE = 0.92;
const PER_SESSION_CANDIDATE_BUDGET = 50;
const BASE = Date.UTC(2024, 10, 1); // 2024-11-01
const SESSION_GAP_MS = 3.5 * 86_400_000;

// --- Mulberry32 (seeded RNG, no dep) ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoForSession(sessionIdx: number): string {
  return new Date(BASE + sessionIdx * SESSION_GAP_MS).toISOString();
}

function dateLabel(sessionIdx: number): string {
  const d = new Date(BASE + sessionIdx * SESSION_GAP_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface BakeStats {
  candidatesGenerated: number;
  candidatesRejected: number;
}

async function bakeFacts(
  rand: () => number,
  numSessions: number,
  minFacts: number,
  maxFacts: number,
): Promise<{ sessions: Session[]; stats: BakeStats; pairwise: { max: number; mean: number; p99: number } }> {
  const sessions: Session[] = [];
  const acceptedEmbeddings: number[][] = [];
  const stats: BakeStats = { candidatesGenerated: 0, candidatesRejected: 0 };

  for (let s = 0; s < numSessions; s++) {
    const theme = THEMES[s % THEMES.length]!;
    const factCount = minFacts + Math.floor(rand() * (maxFacts - minFacts + 1));
    const facts: Fact[] = [];

    for (let f = 0; f < factCount; f++) {
      let accepted = false;
      let candidates = 0;
      while (!accepted && candidates < PER_SESSION_CANDIDATE_BUDGET) {
        const built = buildFact(rand, theme);
        candidates++;
        stats.candidatesGenerated++;
        const vec = await encode(built.claim);
        // Check against all previously accepted across all sessions
        let maxSim = 0;
        for (const prior of acceptedEmbeddings) {
          const sim = cosine(vec, prior);
          if (sim > maxSim) maxSim = sim;
          if (maxSim >= MAX_COSINE_AT_BAKE) break; // early exit
        }
        if (maxSim < MAX_COSINE_AT_BAKE) {
          facts.push({
            fact_id: `s${s}_f${f}`,
            session_idx: s,
            fact_idx: f,
            theme,
            claim: built.claim,
            distinctive: built.distinctive,
            valid_from: isoForSession(s),
          });
          acceptedEmbeddings.push(vec);
          accepted = true;
        } else {
          stats.candidatesRejected++;
        }
      }
      if (!accepted) {
        throw new Error(
          `Bake failed at session ${s} fact ${f}: ${PER_SESSION_CANDIDATE_BUDGET} candidates rejected. ` +
            `Theme=${theme}. Pools too small or templates too clustered. ` +
            `Either expand templates.ts pools/templates or lower numSessions/factCount.`,
        );
      }
    }

    sessions.push({ session_idx: s, date: isoForSession(s), theme, facts });
    if ((s + 1) % 5 === 0 || s === numSessions - 1) {
      const accepted = acceptedEmbeddings.length;
      const rejected = stats.candidatesRejected;
      const rejectRate = stats.candidatesGenerated > 0 ? rejected / stats.candidatesGenerated : 0;
      console.log(
        `  session ${s + 1}/${numSessions}: ${accepted} facts accepted, ${rejected} rejected (${(rejectRate * 100).toFixed(1)}% reject rate)`,
      );
    }
  }

  // Compute pairwise stats for the manifest
  const sims: number[] = [];
  let maxSim = 0;
  for (let i = 0; i < acceptedEmbeddings.length; i++) {
    for (let j = i + 1; j < acceptedEmbeddings.length; j++) {
      const sim = cosine(acceptedEmbeddings[i]!, acceptedEmbeddings[j]!);
      sims.push(sim);
      if (sim > maxSim) maxSim = sim;
    }
  }
  sims.sort((a, b) => a - b);
  const mean = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
  const p99 = sims.length > 0 ? (sims[Math.floor(sims.length * 0.99)] ?? 0) : 0;

  return { sessions, stats, pairwise: { max: maxSim, mean, p99 } };
}

function buildQuestions(
  rand: () => number,
  sessions: Session[],
  numSessions: number,
  factsPerType: number,
  mode: 'mini' | 'full',
): CSTQuestion[] {
  const allFacts: Fact[] = sessions.flatMap((s) => s.facts);
  const recentLo = Math.max(0, numSessions - 5);
  const recentHi = numSessions;
  const midLo = mode === 'mini' ? 5 : 10;
  const midHi = mode === 'mini' ? 15 : 30;
  const distantLo = 0;
  const distantHi = mode === 'mini' ? 5 : 20;

  function factsInBucket(lo: number, hi: number): Fact[] {
    return allFacts.filter((f) => f.session_idx >= lo && f.session_idx < hi);
  }

  function sample<T>(arr: T[], n: number): T[] {
    if (arr.length === 0) return [];
    const out: T[] = [];
    const seen = new Set<number>();
    let safety = n * 10;
    while (out.length < n && safety-- > 0) {
      const i = Math.floor(rand() * arr.length);
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(arr[i]!);
    }
    return out;
  }

  const questions: CSTQuestion[] = [];
  let qCounter = 0;
  const nextQid = () => `cst_q_${String(++qCounter).padStart(3, '0')}`;

  for (const f of sample(factsInBucket(recentLo, recentHi), factsPerType)) {
    questions.push({
      qid: nextQid(),
      type: 'recent',
      question: `What did I say about ${f.theme} this week?`,
      distinctive: f.distinctive,
      ref_session_idx: f.session_idx,
    });
  }
  for (const f of sample(factsInBucket(midLo, midHi), factsPerType)) {
    questions.push({
      qid: nextQid(),
      type: 'mid',
      question: `What did I mention about ${f.theme} a few weeks ago?`,
      distinctive: f.distinctive,
      ref_session_idx: f.session_idx,
    });
  }
  for (const f of sample(factsInBucket(distantLo, distantHi), factsPerType)) {
    questions.push({
      qid: nextQid(),
      type: 'distant',
      question: `What did I say about ${f.theme} a few months ago?`,
      distinctive: f.distinctive,
      ref_session_idx: f.session_idx,
    });
  }
  for (const f of sample(allFacts, factsPerType)) {
    questions.push({
      qid: nextQid(),
      type: 'time-anchored',
      question: `What did I mention about ${f.theme} around ${dateLabel(f.session_idx)}?`,
      distinctive: f.distinctive,
      ref_session_idx: f.session_idx,
    });
  }
  let orderPicked = 0;
  let safetyOrder = factsPerType * 20;
  while (orderPicked < factsPerType && safetyOrder-- > 0) {
    const a = allFacts[Math.floor(rand() * allFacts.length)]!;
    const b = allFacts[Math.floor(rand() * allFacts.length)]!;
    if (a.session_idx === b.session_idx) continue;
    if (a.distinctive.length === 0 || b.distinctive.length === 0) continue;
    const aTok = a.distinctive[0]!;
    const bTok = b.distinctive[0]!;
    if (aTok.toLowerCase() === bTok.toLowerCase()) continue;
    const expected: 'before' | 'after' = a.session_idx < b.session_idx ? 'before' : 'after';
    questions.push({
      qid: nextQid(),
      type: 'order-aware',
      question: `Did I mention "${aTok}" before or after "${bTok}"?`,
      distinctive: [],
      ref_session_idx: a.session_idx,
      ref2_session_idx: b.session_idx,
      expected_order: expected,
    });
    orderPicked++;
  }

  return questions;
}

interface CliArgs {
  mode: 'mini' | 'full';
  seed: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: 'mini' | 'full' = 'mini';
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      const v = args[i + 1];
      if (v !== 'mini' && v !== 'full') throw new Error('--mode must be mini or full');
      mode = v;
      i++;
    } else if (args[i] === '--seed') {
      seed = parseInt(args[i + 1] ?? '42', 10);
      i++;
    }
  }
  return { mode, seed };
}

async function main(): Promise<void> {
  const { mode, seed } = parseArgs();
  console.log(`\n=== Cross-Session-Temporal Bake, mode=${mode} seed=${seed} ===`);
  console.log(`Fixture version: ${FIXTURE_VERSION}`);
  console.log(`Pairwise cosine threshold: < ${MAX_COSINE_AT_BAKE}`);
  console.log(`Per-session candidate budget: ${PER_SESSION_CANDIDATE_BUDGET}`);

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const config = loadConfig();
  await initialize(config.modelPath);
  if (!isInitialized()) {
    throw new Error('BGE embeddings failed to initialize');
  }
  console.log('BGE-small loaded.');

  const numSessions = mode === 'mini' ? 20 : 50;
  const minFacts = 5;
  const maxFacts = 10;
  const factsPerType = mode === 'mini' ? 6 : 30;

  const rand = mulberry32(seed);

  const startMs = Date.now();
  console.log('\nBaking facts...');
  const { sessions, stats, pairwise } = await bakeFacts(rand, numSessions, minFacts, maxFacts);
  console.log(`Facts baked in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

  console.log('\nBuilding questions...');
  const questions = buildQuestions(rand, sessions, numSessions, factsPerType, mode);

  const allFacts = sessions.flatMap((s) => s.facts);
  console.log(`\nTotals: ${allFacts.length} facts, ${questions.length} questions, ${sessions.length} sessions`);
  console.log(
    `Pairwise cosine: max=${pairwise.max.toFixed(4)}, mean=${pairwise.mean.toFixed(4)}, p99=${pairwise.p99.toFixed(4)}`,
  );
  console.log(
    `Generation: ${stats.candidatesGenerated} candidates, ${stats.candidatesRejected} rejected (${
      stats.candidatesGenerated > 0 ? ((stats.candidatesRejected / stats.candidatesGenerated) * 100).toFixed(1) : 0
    }% reject rate)`,
  );

  // Per-theme stats for manifest
  const perTheme = {} as Record<
    Theme,
    { facts: number; templateShapes: number; pool: { name: string; size: number }[] }
  >;
  for (const theme of THEMES) {
    perTheme[theme] = {
      facts: allFacts.filter((f) => f.theme === theme).length,
      templateShapes: 3,
      pool: [],
    };
  }

  const fixture: CSTFixture = {
    version: FIXTURE_VERSION,
    seed,
    mode,
    sessions,
    questions,
  };

  const manifest: FixtureManifest = {
    fixtureVersion: FIXTURE_VERSION,
    bakedAt: new Date().toISOString(),
    embeddingModel: 'bge-small-en-v1.5-onnx-fp32',
    seed,
    mode,
    factCount: allFacts.length,
    questionCount: questions.length,
    pairwise: {
      max: pairwise.max,
      mean: pairwise.mean,
      p99: pairwise.p99,
      enforcedMaxCosine: MAX_COSINE_AT_BAKE,
    },
    perTheme,
    generationStats: {
      candidatesGenerated: stats.candidatesGenerated,
      candidatesRejected: stats.candidatesRejected,
      rejectRate: stats.candidatesGenerated > 0 ? stats.candidatesRejected / stats.candidatesGenerated : 0,
      bakeWallSeconds: (Date.now() - startMs) / 1000,
    },
  };

  const fixturesDir = resolve(__dirname, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const fixturePath = resolve(fixturesDir, `scenarios-${mode}.json`);
  const manifestPath = resolve(fixturesDir, `manifest-${mode}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nWrote: ${fixturePath}`);
  console.log(`Wrote: ${manifestPath}`);
  console.log(`\nBake complete in ${(Date.now() - startMs) / 1000}s.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
