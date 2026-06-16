/**
 * S59A, CAX11 latency + RAM gate for the new mxbai-rerank-xsmall reranker.
 *
 * Run on CAX11 (the production target hardware) BEFORE flipping
 * RERANKER_ENABLED=true on benches. Validates:
 *
 *   1. ONNX model file exists and loads on ARM64.
 *   2. Total RAM (BGE embedder + reranker + better-sqlite3 + Node) stays
 *      under 3.5 GB on the prod profile.
 *   3. Cross-encoder p50/p95/p99 latency on 96 query-doc pairs (representative
 *      of prod gate × overfetch).
 *
 * GATE behavior:
 *   - p95 > 250ms  → exit 1 (BLOCK build flip)
 *   - p95 > 150ms  → exit 0 with WARN (proceed but note in S59 export packet)
 *   - p95 ≤ 150ms  → exit 0
 *   - peak RSS > 3.5 GB → exit 1
 *   - model load failure on ARM → exit 1
 *
 * The locked RERANK_TIMEOUT_MS for production should be measured_p95 * 1.30,
 * printed at end of run as a recommendation.
 *
 * Usage:
 *   /root/demiurge/node_modules/.bin/tsx scripts/validate-rerank-onnx.ts
 *
 * Optional env:
 *   RERANK_MODEL_PATH=models/mxbai-rerank-xsmall.onnx (default)
 *   RERANK_VALIDATE_PAIRS=96 (default)
 */

import { initialize as initEmbeddings } from '../src/embeddings/index.js';
import { rerank, disposeReranker } from '../src/retrieval/reranker.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { FinalScoredCandidate } from '../src/retrieval/scorer.js';
import type { MemoryRecord, ScoredCandidate } from '../src/schema/memory.js';

const PAIR_COUNT = parseInt(process.env.RERANK_VALIDATE_PAIRS || '300', 10);
const MAX_RSS_MB = 3500;
const P95_FAIL_MS = 250;
const P95_WARN_MS = 150;

const SAMPLE_QUERIES = [
  'When did Sarah move to New York',
  'What did the team decide about the migration',
  'Who attended the board meeting in October',
  'What is the latest status of project Phoenix',
  'Where did we leave off on the contract review',
  'What did Alex say about the budget',
  'Has the deployment been completed',
  'What were the action items from Tuesday',
];

const SAMPLE_CLAIMS = [
  'Sarah moved to New York in March 2024 to start her new role at Acme.',
  'The team agreed to migrate to Postgres by Q3, with a fallback to MySQL.',
  'On October 14, the board reviewed Q3 financials and approved hiring.',
  'Project Phoenix is currently in beta with three pilot customers.',
  'The contract review paused at section 8.2 pending legal feedback.',
  'Alex said the budget should focus on infrastructure, not headcount.',
  'Deployment was completed on Thursday at 3am with zero downtime.',
  'Tuesday meeting items: hire two engineers, ship beta, fix billing bug.',
  'A meeting on October 20 covered Q3 strategy and budget reallocation.',
  'Sarah is currently leading the New York office and reports to Jamie.',
  'The team had a long discussion about whether to use Postgres or MySQL.',
  'Alex argued strongly for hiring engineers over marketing investment.',
];

function p(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function makeFinal(claim: string): FinalScoredCandidate {
  const record = {
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    claim,
    subject: 'test',
    validFrom: '2026-04-01T00:00:00Z',
    createdAt: '2026-04-01T00:00:00Z',
  } as unknown as MemoryRecord;
  const candidate: ScoredCandidate = {
    id: record.id,
    record,
    lexicalScore: 1,
    vectorScore: 1,
    source: 'fts',
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
  return {
    id: record.id,
    candidate,
    finalScore: 0.5,
    scoreBreakdown: {
      lexicalComponent: 0,
      vectorComponent: 0,
      provenanceComponent: 0,
      freshnessComponent: 0,
      confirmedBonus: 0,
      contradictionPenalty: 0,
    },
  };
}

async function main() {
  console.log('=== S59A: mxbai-rerank-xsmall ONNX validation ===\n');

  // 0. Model file presence.
  const modelPath = resolve(process.cwd(), process.env.RERANK_MODEL_PATH || 'models/mxbai-rerank-xsmall.onnx');
  if (!existsSync(modelPath)) {
    console.error(`FAIL: model not found at ${modelPath}`);
    console.error(
      'Download: hf-hub-cli download mixedbread-ai/mxbai-rerank-xsmall-v1 model.onnx -o models/mxbai-rerank-xsmall.onnx',
    );
    process.exit(1);
  }
  console.log(`Model file: ${modelPath}, present`);

  // 1. Load BGE embedder (matches prod startup).
  const config = loadConfig();
  await initEmbeddings(config.modelPath);
  console.log(`BGE embedder loaded`);

  // 2. Enable reranker and warm up the model with multiple representative calls.
  // ONNX sessions need more than one inference to fully JIT-warm. Five calls
  // at production batch size (10 candidates) is enough, verified S59A.
  process.env.RERANKER_ENABLED = 'true';
  const warmupBatch = parseInt(process.env.RERANK_VALIDATE_BATCH || '30', 10);
  console.log(`Warming up reranker model (5 calls × ${warmupBatch} candidates to fully JIT)...`);
  for (let i = 0; i < 5; i++) {
    const warmCands = Array.from({ length: warmupBatch }, (_, j) =>
      makeFinal(SAMPLE_CLAIMS[j % SAMPLE_CLAIMS.length]!),
    );
    await rerank('warm up query ' + i, warmCands, 5);
  }
  console.log('Reranker warm.');

  // 3. Latency benchmark: PAIR_COUNT scoring calls split across queries.
  // Batch size matches production rerank cap (RERANK_MAX_CANDIDATES default 30).
  // Earlier versions used 10/call which under-measured: S59A smoke caught
  // 75-cand production calls timing out at 200ms despite 10-cand p95=74ms.
  const latencies: number[] = [];
  const candidatesPerCall = parseInt(process.env.RERANK_VALIDATE_BATCH || '30', 10);
  const callCount = Math.ceil(PAIR_COUNT / candidatesPerCall);

  console.log(`\nBenching ${callCount} rerank() calls × ${candidatesPerCall} candidates each (${PAIR_COUNT} pairs)`);
  for (let i = 0; i < callCount; i++) {
    const query = SAMPLE_QUERIES[i % SAMPLE_QUERIES.length]!;
    const cands = Array.from({ length: candidatesPerCall }, (_, j) =>
      makeFinal(SAMPLE_CLAIMS[(i + j) % SAMPLE_CLAIMS.length]!),
    );
    const start = performance.now();
    await rerank(query, cands, 5);
    latencies.push(performance.now() - start);
  }

  const p50 = p(latencies, 0.5);
  const p95 = p(latencies, 0.95);
  const p99 = p(latencies, 0.99);
  const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;

  console.log(`\nLatency over ${callCount} rerank calls:`);
  console.log(`  mean: ${mean.toFixed(1)}ms`);
  console.log(`  p50:  ${p50.toFixed(1)}ms`);
  console.log(`  p95:  ${p95.toFixed(1)}ms`);
  console.log(`  p99:  ${p99.toFixed(1)}ms`);

  // 4. RAM check.
  const memMB = process.memoryUsage().rss / 1024 / 1024;
  console.log(`\nPeak RSS: ${memMB.toFixed(0)} MB (limit ${MAX_RSS_MB} MB)`);

  await disposeReranker();

  // 5. Gate decision.
  const errors: string[] = [];
  const warnings: string[] = [];
  if (memMB > MAX_RSS_MB) errors.push(`RSS ${memMB.toFixed(0)}MB > ${MAX_RSS_MB}MB ceiling`);
  if (p95 > P95_FAIL_MS) errors.push(`p95 ${p95.toFixed(1)}ms > ${P95_FAIL_MS}ms fail threshold`);
  else if (p95 > P95_WARN_MS) warnings.push(`p95 ${p95.toFixed(1)}ms > ${P95_WARN_MS}ms warn threshold`);

  console.log('\n=== Recommendations ===');
  console.log(`RERANK_TIMEOUT_MS = ${Math.ceil(p95 * 1.3)} (= measured_p95 * 1.30)`);

  if (errors.length > 0) {
    console.error('\nGATE FAILED:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.log('\nGATE WARN:');
    warnings.forEach((w) => console.log(`  - ${w}`));
    console.log('Note in S59 export packet, but build can proceed.');
  } else {
    console.log('\nGATE PASSED.');
  }
}

main().catch((err) => {
  console.error('Validation script crashed:', err);
  process.exit(1);
});
