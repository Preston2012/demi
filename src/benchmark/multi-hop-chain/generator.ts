#!/usr/bin/env npx tsx
/**
 * Bench 3 (Multi-Hop Chain), corpus generator.
 *
 * Calls gpt-4.1-mini (with provider failover via callLLM) to produce
 * self-contained multi-hop scenarios. Validates each scenario with Zod;
 * retries on parse failure up to 3 times per scenario; aborts if total
 * LLM calls exceed MAX_TOTAL_CALLS.
 *
 * Run once and commit the output:
 *   npx tsx src/benchmark/multi-hop-chain/generator.ts --target 60
 *
 * Default target is 60 scenarios. Output: src/benchmark/multi-hop-chain/fixtures/scenarios.json
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callLLM } from '../llm-caller.js';
import { ScenarioSchema, FixtureSchema, type Scenario, type Fixture } from './schema.js';

const GEN_MODEL = 'gpt-4.1-mini';
const MAX_RETRIES = 3;
const MAX_TOTAL_CALLS = 200;

const PROMPT = `Generate one self-contained multi-hop reasoning scenario as STRICT JSON (single object, no markdown).

Schema:
{
  "scenario_id": "scn_<short>",
  "entities": [3-8 strings, distinct names of people/places/objects],
  "facts": [
    { "fact_id": "f1", "text": "<single atomic fact>", "entities": ["A","B"] },
    ...8 to 12 facts total, each one fact, each referencing 1-2 entities from the list
  ],
  "questions": [
    { "question_id": "q1", "type": "2-hop", "question": "...", "answer": "<short answer>", "evidence_chain": ["f1","f3"] },
    { "question_id": "q2", "type": "3-hop", "question": "...", "answer": "<short answer>", "evidence_chain": ["f2","f5","f7"] }
  ]
}

Hard constraints:
- exactly 2 questions per scenario: one 2-hop, one 3-hop
- evidence_chain MUST list the fact_ids needed to answer; the answer cannot be in any single fact
- each fact text is a single sentence
- entity names are short (1-3 words)
- output MUST be a single JSON object, no prose, no code fences
- scenario_id should be unique per scenario`;

function extractJson(text: string): string | null {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

async function generateOne(idx: number, totalCallsRef: { n: number }): Promise<Scenario | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (totalCallsRef.n >= MAX_TOTAL_CALLS) return null;
    totalCallsRef.n++;
    let raw: string;
    try {
      raw = await callLLM(
        GEN_MODEL,
        'You generate strictly-formatted JSON for benchmark fixtures.',
        `${PROMPT}\n\nScenario index: ${idx}`,
        1500,
        0.7,
      );
    } catch (err) {
      console.error(`  attempt ${attempt + 1} LLM error:`, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!raw) continue;
    const json = extractJson(raw);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      const result = ScenarioSchema.safeParse(parsed);
      if (result.success) {
        // Validate that evidence_chain references existing fact_ids.
        const factIds = new Set(result.data.facts.map((f) => f.fact_id));
        const valid = result.data.questions.every((q) => q.evidence_chain.every((fid) => factIds.has(fid)));
        if (!valid) continue;
        return result.data;
      }
    } catch {
      // fall through to retry
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf('--target');
  const target = targetIdx !== -1 ? parseInt(args[targetIdx + 1] ?? '60', 10) : 60;

  const fixturesDir = resolve(__dirname, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const outPath = resolve(fixturesDir, 'scenarios.json');

  // Preserve any existing scenarios; we append, dedup by scenario_id.
  const existing: Scenario[] = [];
  if (existsSync(outPath)) {
    try {
      const raw = JSON.parse(readFileSync(outPath, 'utf-8'));
      const parsed = FixtureSchema.safeParse(raw);
      if (parsed.success) existing.push(...parsed.data.scenarios);
    } catch {
      // ignore, start fresh
    }
  }
  const seenIds = new Set(existing.map((s) => s.scenario_id));
  console.log(`Existing fixture: ${existing.length} scenarios. Target: ${target}.`);

  const totalCallsRef = { n: 0 };
  const newScenarios: Scenario[] = [];
  for (let i = existing.length; i < target; i++) {
    if (totalCallsRef.n >= MAX_TOTAL_CALLS) {
      console.error(
        `MAX_TOTAL_CALLS=${MAX_TOTAL_CALLS} hit. Stopping early at ${existing.length + newScenarios.length}/${target}.`,
      );
      break;
    }
    process.stdout.write(`  generating ${i + 1}/${target} (calls=${totalCallsRef.n})... `);
    const sc = await generateOne(i, totalCallsRef);
    if (sc && !seenIds.has(sc.scenario_id)) {
      newScenarios.push(sc);
      seenIds.add(sc.scenario_id);
      console.log(`OK (${sc.facts.length} facts, ${sc.questions.length} Qs)`);
    } else {
      console.log('SKIP (invalid or duplicate)');
    }
  }

  const finalScenarios = [...existing, ...newScenarios];
  const fixture: Fixture = { version: '1.0', scenarios: finalScenarios };
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`\nWrote ${finalScenarios.length} scenarios to ${outPath} (${totalCallsRef.n} LLM calls)`);
  if (finalScenarios.length < target) {
    console.error(`WARNING: only ${finalScenarios.length}/${target} scenarios; rerun to fill.`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { generateOne };
