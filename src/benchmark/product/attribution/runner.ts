#!/usr/bin/env npx tsx
/**
 * Attribution Accuracy bench (S51 / D4), runner.
 *
 * Custom flow (not via runProductBench) because the LLM must see source +
 * validFrom on each retrieved memory in order to answer attribution
 * questions, and the default inject-format strips that.
 *
 * Per scenario:
 *   - fresh :memory: repo
 *   - seed 5 facts via dispatch.addMemory
 *   - dispatch.search(question, maxRules) → retrieve top candidates
 *   - build custom context: each line = "[idMnemonic] (source=..., date=...) <claim>"
 *   - ask LLM: "Cite the source+date that supports the answer."
 *   - score:
 *       memoryIdMatch: did the expected fact's id appear in retrieved top-K?
 *       sourceCorrect: LLM-judged source string match (paraphrase-tolerant)
 *       dateCorrect:   LLM-judged date string match ("January 2024" ≈ "2024-01-15")
 *     correct = memoryIdMatch && sourceCorrect && dateCorrect
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { callLLM } from '../../llm-caller.js';
import { callJudgeCached } from '../../judge-cache.js';
import { aggregatePerCategory, parseYesNo } from '../scorer.js';
import { generate } from './generator.js';
import type { ProductQuestionResult, ProductReport } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANSWER_MODEL_DEFAULT = 'gpt-4o-mini';
const JUDGE_MODEL_DEFAULT = 'gpt-4o-mini';
const MAX_RULES_DEFAULT = 65;

const ATTRIBUTION_ANSWER_PROMPT =
  'You are answering questions about user memories. The context below is a numbered list of memories with explicit source and date metadata. ' +
  'When you answer, you MUST cite the source label AND the date that supports your answer (e.g. "Source: conversation_2024-06-10, Date: 2024-06-10"). ' +
  'If the supporting memory has no source label, say "Source: unknown" rather than inventing one. ' +
  'Be concise (1-3 sentences for the substantive answer plus the source/date line).';

const SOURCE_JUDGE_PROMPT =
  'You are a strict evaluator. Respond ONLY with "yes" or "no".\n\n' +
  'Expected source: {expectedSource}\n' +
  'System answer (verbatim): {predicted}\n\n' +
  'Does the system answer attribute the source CORRECTLY? Accept paraphrases ' +
  '("conversation_2024-06-10" ≈ "the June 2024 conversation"). Say "no" if the ' +
  'source is missing, wrong, or hallucinated.';

const DATE_JUDGE_PROMPT =
  'You are a strict evaluator. Respond ONLY with "yes" or "no".\n\n' +
  'Expected date: {expectedDate}\n' +
  'System answer (verbatim): {predicted}\n\n' +
  'Does the system answer cite the date CORRECTLY? Accept paraphrases ' +
  '("2024-06-10" ≈ "June 2024" ≈ "June 10, 2024"). Say "no" if the date is ' +
  'missing, wrong, or contradicted.';

interface AttributionExtra {
  pattern: string;
  expectedFactIndex: number;
  expectedSource: string | null;
  expectedDate: string;
  retrievedExpected: boolean;
  sourceCorrect: boolean;
  dateCorrect: boolean;
  hallucinated: boolean;
}

interface CliArgs {
  mode: 'mini' | 'full';
  routed: boolean;
  seed: number;
  answerModel: string;
  judgeModel: string;
  maxRules: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const mode: 'mini' | 'full' = args.includes('--full') ? 'full' : 'mini';
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1] ?? '42', 10) : 42;
  const am = args.indexOf('--answer-model');
  const answerModel = am !== -1 ? (args[am + 1] ?? ANSWER_MODEL_DEFAULT) : ANSWER_MODEL_DEFAULT;
  const jm = args.indexOf('--judge-model');
  const judgeModel = jm !== -1 ? (args[jm + 1] ?? JUDGE_MODEL_DEFAULT) : JUDGE_MODEL_DEFAULT;
  const mr = args.indexOf('--max-rules');
  const maxRules = mr !== -1 ? parseInt(args[mr + 1] ?? String(MAX_RULES_DEFAULT), 10) : MAX_RULES_DEFAULT;
  return { mode, routed: args.includes('--routed'), seed, answerModel, judgeModel, maxRules };
}

interface RetrievedRecord {
  id: string;
  claim: string;
  source: string | null | undefined;
  validFrom: string | null | undefined;
}

function buildAttributionContext(retrieved: ReadonlyArray<RetrievedRecord>): string {
  // Lead with explicit Source: and Date: labels so the model can directly
  // copy them when the prompt asks for source/date citation. Earlier format
  // used [M${i+1}] bracket labels + parenthesized source=..., date=..., when
  // multiple memories shared a generic source string (e.g. "conversation_log"
  // across 3 of 5 facts), the model fell back to citing the unique-looking
  // bracket label as the source. Removing the bracket label forces the model
  // to use the only labels left, which match the prompt verbatim.
  const lines = retrieved.map((r) => {
    const src = r.source ? r.source : 'unknown';
    const date = r.validFrom ? r.validFrom.substring(0, 10) : 'unknown';
    return `Source: ${src} | Date: ${date} | ${r.claim}`;
  });
  return [
    'Memory context (each line is one memory; cite the Source and Date that support your answer):',
    ...lines,
  ].join('\n');
}

async function runAttribution(): Promise<ProductReport> {
  const cli = parseArgs(process.argv);

  // S59A: bench-env preamble overrides .env for ANSWER_ROUTING / STONE /
  // TEMPORAL / BI_TEMPORAL. Then keep legacy single-bench knobs below.
  const { ensureBenchEnv } = await import('../../lib/bench-env.js');
  const { initBenchTelemetry } = await import('../../lib/bench-telemetry.js');
  ensureBenchEnv('product');
  initBenchTelemetry();
  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const fixture = generate(cli.seed, cli.mode);
  const totalQ = fixture.scenarios.reduce((a, s) => a + s.queries.length, 0);
  console.log(
    `Attribution [${cli.mode}] seed=${cli.seed} routed=${cli.routed} → ${fixture.scenarios.length} scenarios, ${totalQ} questions`,
  );

  const { loadConfig } = await import('../../../config.js');
  const config = loadConfig();
  const { initialize: initEmbeddings } = await import('../../../embeddings/index.js');
  try {
    await initEmbeddings(config.modelPath);
  } catch {
    // lexical-only is fine
  }
  const { SqliteMemoryRepository } = await import('../../../repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../../../core/dispatch.js');

  const allResults: ProductQuestionResult[] = [];

  for (let i = 0; i < fixture.scenarios.length; i++) {
    const sc = fixture.scenarios[i]!;
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    // The schema's `source` field is a fixed enum (user/llm/import), so we
    // can't persist arbitrary source labels (e.g. 'conversation_2024-06-10')
    // through dispatch.addMemory. Instead, the bench builds an out-of-band
    // map (memoryId → {source, validFrom, factIndex}) at seed time and uses
    // that map to construct the attribution context for the LLM.
    const factIdToMemoryId: Array<string | null> = [];
    const memoryIdToFact = new Map<
      string,
      { source: string | null; validFrom: string; factIndex: number; claim: string }
    >();
    for (let fi = 0; fi < sc.facts.length; fi++) {
      const f = sc.facts[fi]!;
      try {
        const r = await dispatch.addMemory({
          claim: f.claim,
          subject: f.subject ?? 'user',
          // Schema accepts only enum values here; the BENCH source label
          // travels in the side-map below, not through addMemory.
          source: 'user',
          confidence: 0.95,
          validFrom: f.validFrom,
        });
        const memId = r.action !== 'rejected' ? r.id : null;
        factIdToMemoryId.push(memId);
        if (memId) {
          memoryIdToFact.set(memId, {
            source: f.source ?? null,
            validFrom: f.validFrom ?? '',
            factIndex: fi,
            claim: f.claim,
          });
        }
      } catch {
        factIdToMemoryId.push(null);
      }
    }

    for (const q of sc.queries) {
      const totalStart = performance.now();
      const tStart = performance.now();
      let retrieved: RetrievedRecord[] = [];
      let predicted = '';
      let error: string | undefined;
      const meta = (q.meta ?? {}) as {
        pattern?: string;
        expectedFactIndex?: number;
        expectedSource?: string | null;
        expectedDate?: string;
        alternateAcceptableSources?: string[];
      };
      const expectedFactIndex = meta.expectedFactIndex ?? 0;
      const expectedSource = meta.expectedSource ?? null;
      const expectedDate = meta.expectedDate ?? '';
      const alternateSources = meta.alternateAcceptableSources ?? [];
      const acceptableSources = expectedSource !== null ? [expectedSource, ...alternateSources] : [];
      const expectedMemoryId = factIdToMemoryId[expectedFactIndex] ?? null;

      let retrievalMs = 0;
      let extra: AttributionExtra = {
        pattern: meta.pattern ?? 'unknown',
        expectedFactIndex,
        expectedSource,
        expectedDate,
        retrievedExpected: false,
        sourceCorrect: false,
        dateCorrect: false,
        hallucinated: false,
      };
      let correct = false;

      try {
        const search = await dispatch.search(q.question, cli.maxRules);
        retrievalMs = performance.now() - tStart;
        retrieved = search.raw.candidates.map((c) => {
          const sideInfo = memoryIdToFact.get(c.id);
          return {
            id: c.id,
            claim: c.candidate.record.claim,
            source: sideInfo?.source ?? null,
            validFrom: sideInfo?.validFrom ?? c.candidate.record.validFrom ?? null,
          };
        });

        const ctx = buildAttributionContext(retrieved);
        const userPrompt = `${ctx}\n\nQuestion: ${q.question}`;
        // S65 prompt-audit pass 2: cacheKey added.
        predicted = await callLLM(cli.answerModel, ATTRIBUTION_ANSWER_PROMPT, userPrompt, 250, 0, {
          cacheKey: 'demiurge:attribution:answer:v1',
        });

        const retrievedExpected = expectedMemoryId !== null && retrieved.some((r) => r.id === expectedMemoryId);

        // Source check, deterministic-first, LLM-judge only on ambiguity.
        // gpt-4o-mini with max_tokens=5 returns "no" on predictions that
        // contain the verbatim expected source (18 such false-negatives in
        // S53 baseline). Verbatim substring match is unambiguous; fall back
        // to LLM only when the predicted answer paraphrases the source label.
        let sourceCorrect = false;
        if (expectedSource === null) {
          // anonymous: predicted must mark source as unknown in a Source: line,
          // not just include "unknown" anywhere in prose.
          sourceCorrect =
            /source[:\s=]+(unknown|none|n\/?a|not (?:available|specified|provided|known)|anonymous|no\s+source)/i.test(
              predicted,
            );
        } else {
          const directHit = acceptableSources.some((src) => predicted.includes(src));
          if (directHit) {
            sourceCorrect = true;
          } else {
            const sourceList = acceptableSources.map((s) => '"' + s + '"').join(' OR ');
            const sourcePrompt = SOURCE_JUDGE_PROMPT.replace('{expectedSource}', sourceList).replace(
              '{predicted}',
              predicted,
            );
            // S68: persistent judge cache (M9). cacheTag = attribution-source.
            const sjRes = await callJudgeCached({
              model: cli.judgeModel,
              system:
                'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
              user: sourcePrompt,
              predicted,
              cacheTag: 'attribution-source',
              maxTokens: 5,
              llmCacheKey: 'demiurge:attribution:source-judge:v1',
            });
            sourceCorrect = parseYesNo(sjRes.verdict);
          }
        }

        // Date check, deterministic-first, LLM-judge only on ambiguity.
        let dateCorrect = false;
        if (expectedDate) {
          if (predicted.includes(expectedDate)) {
            dateCorrect = true;
          } else {
            const isoMatch = expectedDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
            if (isoMatch) {
              const year = isoMatch[1] as string;
              const month = isoMatch[2] as string;
              const monthIdx = parseInt(month, 10);
              const monthNames = [
                '',
                'January',
                'February',
                'March',
                'April',
                'May',
                'June',
                'July',
                'August',
                'September',
                'October',
                'November',
                'December',
              ];
              const monthName = monthNames[monthIdx];
              if (monthName) {
                const monthYearRe = new RegExp(monthName + '[\\s,]+' + year, 'i');
                if (monthYearRe.test(predicted)) {
                  dateCorrect = true;
                }
              }
            }
            if (!dateCorrect) {
              const datePrompt = DATE_JUDGE_PROMPT.replace('{expectedDate}', expectedDate).replace(
                '{predicted}',
                predicted,
              );
              // S68: persistent judge cache (M9). cacheTag = attribution-date.
              const djRes = await callJudgeCached({
                model: cli.judgeModel,
                system:
                  'You are a strict benchmark evaluator. Respond on a single line with the single word "yes" or "no" as instructed by the user prompt.',
                user: datePrompt,
                predicted,
                cacheTag: 'attribution-date',
                maxTokens: 5,
                llmCacheKey: 'demiurge:attribution:date-judge:v1',
              });
              dateCorrect = parseYesNo(djRes.verdict);
            }
          }
        }

        // Hallucination heuristic: model cites a source string nothing in retrieved had.
        const allSources = new Set(retrieved.map((r) => r.source ?? '').filter(Boolean));
        const citedSourceMatch = predicted.match(/source[:\s=]+([\w\-_:]+)/i);
        let hallucinated = false;
        if (citedSourceMatch) {
          const cited = citedSourceMatch[1] ?? '';
          if (cited && !allSources.has(cited) && !/unknown|none|n\/a/i.test(cited)) {
            hallucinated = true;
          }
        }

        extra = {
          pattern: meta.pattern ?? 'unknown',
          expectedFactIndex,
          expectedSource,
          expectedDate,
          retrievedExpected,
          sourceCorrect,
          dateCorrect,
          hallucinated,
        };
        correct = retrievedExpected && sourceCorrect && dateCorrect;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const total_ms = performance.now() - totalStart;
      const result: ProductQuestionResult = {
        qid: q.qid,
        scenario_id: sc.scenario_id,
        question: q.question,
        expected: q.expected,
        predicted,
        correct,
        retrieved_count: retrieved.length,
        retrieved_ids: retrieved.map((r) => r.id),
        retrieved_claims: retrieved.map((r) => r.claim),
        retrieval_ms: retrievalMs,
        total_ms,
        extra: extra as unknown as Record<string, unknown>,
      };
      if (q.category !== undefined) result.category = q.category;
      if (error !== undefined) result.error = error;
      allResults.push(result);
    }

    if (typeof (repo as { close?: () => void }).close === 'function') {
      (repo as { close: () => void }).close();
    }
    if ((i + 1) % 10 === 0 || i === fixture.scenarios.length - 1) {
      const accSoFar = allResults.filter((r) => r.correct).length / Math.max(1, allResults.length);
      console.log(`  [${i + 1}/${fixture.scenarios.length}] running acc: ${(accSoFar * 100).toFixed(1)}%`);
    }
  }

  // Aggregate per-pattern + global hallucination/source/date rates
  const total = allResults.length;
  const correct = allResults.filter((r) => r.correct).length;
  const perCategory = aggregatePerCategory(allResults);

  const sourceCorrectRate =
    allResults.filter((r) => (r.extra as AttributionExtra | undefined)?.sourceCorrect).length / Math.max(1, total);
  const dateCorrectRate =
    allResults.filter((r) => (r.extra as AttributionExtra | undefined)?.dateCorrect).length / Math.max(1, total);
  const hallucinationRate =
    allResults.filter((r) => (r.extra as AttributionExtra | undefined)?.hallucinated).length / Math.max(1, total);
  const memoryIdMatchRate =
    allResults.filter((r) => (r.extra as AttributionExtra | undefined)?.retrievedExpected).length / Math.max(1, total);

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    // no-op
  }

  const report: ProductReport = {
    benchmark: 'attribution',
    upstream_version: fixture.upstream_version,
    timestamp: new Date().toISOString(),
    commit,
    config: {
      mode: fixture.mode,
      answerModel: cli.answerModel,
      judgeModel: cli.judgeModel,
      maxRules: cli.maxRules,
      seed: cli.seed,
    },
    summary: {
      totalQuestions: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      perCategory,
      extra: {
        memoryIdMatchRate,
        sourceCorrectRate,
        dateCorrectRate,
        hallucinationRate,
      },
    },
    results: allResults,
  };

  const outDir = resolve(__dirname, '../../../../benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `attribution-${fixture.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`  → wrote ${out}`);

  console.log('\n=== Attribution Summary ===');
  console.log(`  Overall correct (memory-id + source + date): ${(report.summary.accuracy * 100).toFixed(1)}%`);
  console.log(`  Memory-id match rate:    ${(memoryIdMatchRate * 100).toFixed(1)}%`);
  console.log(`  Source-correct rate:     ${(sourceCorrectRate * 100).toFixed(1)}%`);
  console.log(`  Date-correct rate:       ${(dateCorrectRate * 100).toFixed(1)}%`);
  console.log(`  Hallucination rate:      ${(hallucinationRate * 100).toFixed(1)}%`);
  for (const [pat, v] of Object.entries(perCategory)) {
    console.log(`  ${pat.padEnd(28)}: ${(v.accuracy * 100).toFixed(1)}% (${v.correct}/${v.total})`);
  }
  return report;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runAttribution().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { runAttribution, buildAttributionContext };
