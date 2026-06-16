#!/usr/bin/env npx tsx
/**
 * Bench 5 (Cold-Warm Transition), runner.
 *
 * Per scenario: fresh `:memory:` repo. Seed pack inserted via
 * dispatch.addMemory(source='import') → provenance=IMPORTED. User stream
 * inserted with source='user' → provenance=USER_CONFIRMED. No new env flag
 * needed: source maps cleanly to provenance via the existing trust-branch
 * pipeline (src/write/trust-branch.ts:94-98).
 *
 * Question mix: seed-only / user-only / hybrid / conflict.
 *
 * Reports per-type accuracy + seed/user leakage rates + conflict resolution
 * accuracy + attribution accuracy on hybrid.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { v4 as uuid } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { generate, type ColdWarmScenario } from './generator.js';
import { judge } from './judge.js';
import { callLLM } from '../llm-caller.js';
import {
  type MemoryRecord,
  Provenance,
  TrustClass,
  ReviewStatus,
  Scope,
  PermanenceStatus,
  ResolutionLevel,
  MemoryType,
  StorageTier,
  InterferenceStatus,
} from '../../schema/memory.js';

/**
 * Bench 5 inserts hand-built MemoryRecords via repo.insert (mirrors Bench 1).
 * Why not dispatch.addMemory: addMemory's pipeline triggers consensus on the
 * intentional conflicts (seed says X, user says X'), which fails without an
 * Anthropic key and quarantines records, making the bench non-runnable
 * without keys. repo.insert sidesteps consensus and gives explicit provenance
 * control via the source→provenance map encoded here.
 */

function computeSourceHashSync(claim: string): string {
  let h = 0;
  for (let i = 0; i < claim.length; i++) h = (h * 31 + claim.charCodeAt(i)) | 0;
  return `bench-${(h >>> 0).toString(16)}-${claim.length}`;
}

function buildSyntheticRecord(
  claim: string,
  source: 'seed' | 'user',
  validFrom: string,
  embedding: number[] | null = null,
  canonicalFactId: string | null = null,
): MemoryRecord {
  const provenance = source === 'seed' ? Provenance.IMPORTED : Provenance.USER_CONFIRMED;
  return {
    id: uuid(),
    userId: 'system',
    externalRef: null,
    claim,
    subject: 'user',
    scope: Scope.GLOBAL,
    validFrom,
    validTo: null,
    provenance,
    trustClass: TrustClass.CONFIRMED,
    confidence: 0.95,
    sourceHash: computeSourceHashSync(claim),
    supersedes: null,
    conflictsWith: [],
    reviewStatus: ReviewStatus.APPROVED,
    accessCount: 0,
    lastAccessed: validFrom,
    createdAt: validFrom,
    updatedAt: validFrom,
    embedding,
    permanenceStatus: PermanenceStatus.PROVISIONAL,
    hubId: null,
    hubScore: 0,
    resolution: ResolutionLevel.SPECIFIC,
    memoryType: MemoryType.DECLARATIVE,
    versionNumber: 1,
    parentVersionId: null,
    frozenAt: null,
    decayScore: 1,
    storageTier: StorageTier.ACTIVE,
    isInhibitory: false,
    inhibitionTarget: null,
    interferenceStatus: InterferenceStatus.ACTIVE,
    correctionCount: 0,
    isFrozen: false,
    causedBy: null,
    leadsTo: null,
    // Packet C3 / Bug 4: conflict pair members share a canonicalFactId so the
    // provenance-aware dedup in inject/budget.ts can pick user > seed.
    canonicalFactId,
    isCanonical: true,
    validAt: validFrom,
    invalidAt: null,
    persona: false,
  };
}

const ANSWER_MODEL = 'gpt-4.1-mini';
const ANSWER_PROMPT =
  'You have two kinds of context: pre-loaded "seed" knowledge and what the ' +
  'user said. When they conflict, prefer the user. When the question asks ' +
  'about both ("how does my X compare to the framework"), reference both ' +
  'distinctly. Be concise (1-3 sentences).';

interface ColdWarmQuestionResult {
  qid: string;
  scenario_id: string;
  topic: string;
  type: string;
  question: string;
  expected_keywords: string[];
  expected_excludes: string[];
  expected_provenance: string;
  predicted_answer: string;
  correct: boolean;
  seed_leak: boolean;
  /** Distribution of provenance in retrieved set. */
  retrieved_provenance: { imported: number; userConfirmed: number; other: number };
  retrieved_ids: string[];
  retrieved_claims: string[];
  memories_injected: number;
  retrieval_time_ms: number;
  total_time_ms: number;
}

interface ColdWarmSummary {
  totalQuestions: number;
  correct: number;
  accuracy: number;
  perType: Record<string, { total: number; correct: number; accuracy: number }>;
  seedLeakageOnUserQs: number; // % of user-only Qs whose retrieved set was majority seed
  userLeakageOnSeedQs: number; // % of seed-only Qs whose retrieved set was majority user
  conflictResolutionAccuracy: number; // accuracy on conflict Qs
  hybridAttributionAccuracy: number; // % of hybrid Qs whose retrieved set has both provenances
  meanRetrievalMs: number;
}

interface ColdWarmReport {
  benchmark: 'cold-warm';
  timestamp: string;
  config: { mode: 'mini' | 'full'; answerModel: string; seed: number };
  methodology: { note: string; metric: string; ceiling: number };
  summary: ColdWarmSummary;
  results: ColdWarmQuestionResult[];
}

function summarize(results: ColdWarmQuestionResult[]): ColdWarmSummary {
  const perType: ColdWarmSummary['perType'] = {};
  for (const r of results) {
    if (!perType[r.type]) perType[r.type] = { total: 0, correct: 0, accuracy: 0 };
    perType[r.type]!.total++;
    if (r.correct) perType[r.type]!.correct++;
  }
  for (const v of Object.values(perType)) v.accuracy = v.total ? v.correct / v.total : 0;

  const userOnly = results.filter((r) => r.type === 'user-only');
  const seedOnly = results.filter((r) => r.type === 'seed-only');
  const conflict = results.filter((r) => r.type === 'conflict');
  const hybrid = results.filter((r) => r.type === 'hybrid');

  function majoritySeed(r: ColdWarmQuestionResult): boolean {
    const total = r.retrieved_provenance.imported + r.retrieved_provenance.userConfirmed;
    return total > 0 && r.retrieved_provenance.imported > r.retrieved_provenance.userConfirmed;
  }
  function majorityUser(r: ColdWarmQuestionResult): boolean {
    const total = r.retrieved_provenance.imported + r.retrieved_provenance.userConfirmed;
    return total > 0 && r.retrieved_provenance.userConfirmed > r.retrieved_provenance.imported;
  }
  function bothProvenances(r: ColdWarmQuestionResult): boolean {
    return r.retrieved_provenance.imported > 0 && r.retrieved_provenance.userConfirmed > 0;
  }

  const seedLeakUser = userOnly.length ? userOnly.filter(majoritySeed).length / userOnly.length : 0;
  const userLeakSeed = seedOnly.length ? seedOnly.filter(majorityUser).length / seedOnly.length : 0;
  const conflictAcc = conflict.length ? conflict.filter((r) => r.correct).length / conflict.length : 0;
  const attribAcc = hybrid.length ? hybrid.filter(bothProvenances).length / hybrid.length : 0;
  const meanRet = results.length ? results.reduce((a, b) => a + b.retrieval_time_ms, 0) / results.length : 0;

  const correct = results.filter((r) => r.correct).length;
  return {
    totalQuestions: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    perType,
    seedLeakageOnUserQs: seedLeakUser,
    userLeakageOnSeedQs: userLeakSeed,
    conflictResolutionAccuracy: conflictAcc,
    hybridAttributionAccuracy: attribAcc,
    meanRetrievalMs: meanRet,
  };
}

async function runScenario(
  scenario: ColdWarmScenario,
  config: Record<string, unknown>,
): Promise<ColdWarmQuestionResult[]> {
  const { SqliteMemoryRepository } = await import('../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../core/dispatch.js');
  const { encode, isInitialized: embedReady } = await import('../../embeddings/index.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = { ...config, dbPath: ':memory:' } as any;
  const repo = new SqliteMemoryRepository(cfg);
  await repo.initialize();
  await repo.setMetadata('last_activity', new Date().toISOString());
  const dispatch = createCoreDispatch(repo, cfg);

  // Insert facts in chronological order with explicit provenance. Seed first,
  // then user, same temporal arc as a real cold→warm transition.
  const baseTime = Date.UTC(2025, 0, 1);
  for (let i = 0; i < scenario.facts.length; i++) {
    const fact = scenario.facts[i]!;
    const validFrom = new Date(baseTime + i * 3600_000).toISOString();
    const embedding = embedReady() ? await encode(fact.claim) : null;
    // Packet C3 / Bug 4: pass through the canonicalFactId set by the generator
    // for conflict pairs. The provenance-aware dedup in inject/budget.ts uses
    // it to pick the user version over the seeded version.
    const rec = buildSyntheticRecord(fact.claim, fact.source, validFrom, embedding, fact.canonical_fact_id ?? null);
    try {
      await repo.insert(rec);
    } catch (err) {
      console.error('SEED_ERROR:', err instanceof Error ? err.message : String(err));
    }
  }

  const out: ColdWarmQuestionResult[] = [];
  for (const q of scenario.questions) {
    const totalStart = performance.now();
    const retrievalStart = performance.now();
    const searchResult = await dispatch.search(q.question, 25);
    const retrievalMs = performance.now() - retrievalStart;

    const prompt = `${ANSWER_PROMPT}\n\nContext:\n${searchResult.contextText}`;
    let predicted: string;
    try {
      predicted = await callLLM(ANSWER_MODEL, prompt, q.question, 120, 0, {
        cacheKey: 'demiurge:cold-warm:answer:v1',
      });
    } catch (err) {
      predicted = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
    const totalMs = performance.now() - totalStart;
    const judgement = judge(q, predicted);

    const provenanceCounts = { imported: 0, userConfirmed: 0, other: 0 };
    for (const c of searchResult.raw.candidates) {
      const p = c.candidate.record.provenance;
      if (p === 'imported') provenanceCounts.imported++;
      else if (p === 'user-confirmed') provenanceCounts.userConfirmed++;
      else provenanceCounts.other++;
    }

    out.push({
      qid: q.qid,
      scenario_id: scenario.scenario_id,
      topic: scenario.topic,
      type: q.type,
      question: q.question,
      expected_keywords: q.expected_keywords,
      expected_excludes: q.expected_excludes,
      expected_provenance: q.expected_provenance,
      predicted_answer: predicted,
      correct: judgement.correct,
      seed_leak: judgement.seedLeak,
      retrieved_provenance: provenanceCounts,
      retrieved_ids: searchResult.raw.candidates.map((c) => c.id),
      retrieved_claims: searchResult.raw.candidates.map((c) => c.candidate.record.claim),
      memories_injected: searchResult.raw.candidates.length,
      retrieval_time_ms: retrievalMs,
      total_time_ms: totalMs,
    });
  }

  await repo.close();
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mini = args.includes('--mini') || !args.includes('--full');
  const mode: 'mini' | 'full' = mini ? 'mini' : 'full';
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(args[seedArg + 1] ?? '42', 10) : 42;

  // S68: bench-env profile sets TEST_MODE/STONE/ROUTING/TEMPORAL/BI_TEMPORAL/DEDUP/CIRCUIT_BREAKER.
  const { ensureBenchEnv } = await import('../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../lib/bench-telemetry.js');
  ensureBenchEnv('cold-warm');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { loadConfig } = await import('../../config.js');
  const config = loadConfig();

  const { initialize: initEmbeddings } = await import('../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
    console.log('Embedding model loaded');
  } catch (e) {
    console.warn('Embeddings unavailable (lexical-only):', e instanceof Error ? e.message : String(e));
  }

  const fixture = generate(seed, mode);
  const totalQ = fixture.scenarios.reduce((a, b) => a + b.questions.length, 0);
  console.log(`Bench 5: cold-warm [${mode}] seed=${seed} → ${fixture.scenarios.length} scenarios, ${totalQ} questions`);

  const allResults: ColdWarmQuestionResult[] = [];
  for (let i = 0; i < fixture.scenarios.length; i++) {
    const sc = fixture.scenarios[i]!;
    const r = await runScenario(sc, config as unknown as Record<string, unknown>);
    allResults.push(...r);
    if ((i + 1) % 2 === 0 || i === fixture.scenarios.length - 1) {
      const pct = ((allResults.filter((x) => x.correct).length / allResults.length) * 100).toFixed(1);
      console.log(`  [${i + 1}/${fixture.scenarios.length}] ${allResults.length} Qs, ${pct}% correct so far`);
    }
  }

  const summary = summarize(allResults);
  const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(__dirname, '../../../benchmark-results');
  mkdirSync(outputDir, { recursive: true });

  const report: ColdWarmReport = {
    benchmark: 'cold-warm',
    timestamp: new Date().toISOString(),
    config: { mode, answerModel: ANSWER_MODEL, seed },
    methodology: {
      note:
        'Cold-warm transition. Fresh :memory: repo per scenario. Seed pack inserted ' +
        'with source=import (provenance=IMPORTED); user stream with source=user ' +
        '(provenance=USER_CONFIRMED). No new env flag, source maps to provenance ' +
        'via existing trust-branch.',
      metric:
        'keyword inclusion (seed/user/hybrid); user-keyword present + seed-keyword absent (conflict); ' +
        'provenance distribution of retrieved set (leakage)',
      ceiling: 1.0,
    },
    summary,
    results: allResults,
  };

  const path = resolve(outputDir, `cold-warm-${isoSafe}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${path}`);

  console.log('\n=== Final scores ===');
  console.log(
    `  Overall:                   ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.totalQuestions})`,
  );
  for (const t of ['seed-only', 'user-only', 'hybrid', 'conflict']) {
    const v = summary.perType[t];
    if (!v) continue;
    console.log(`  ${t.padEnd(26)}: ${(v.accuracy * 100).toFixed(1).padStart(5)}% (${v.correct}/${v.total})`);
  }
  console.log(`  Seed leakage on user Qs:   ${(summary.seedLeakageOnUserQs * 100).toFixed(1)}%`);
  console.log(`  User leakage on seed Qs:   ${(summary.userLeakageOnSeedQs * 100).toFixed(1)}%`);
  console.log(`  Conflict resolution acc:   ${(summary.conflictResolutionAccuracy * 100).toFixed(1)}%`);
  console.log(`  Hybrid attribution acc:    ${(summary.hybridAttributionAccuracy * 100).toFixed(1)}%`);
  console.log(`  Mean retrieval ms:         ${summary.meanRetrievalMs.toFixed(1)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runScenario, summarize };
