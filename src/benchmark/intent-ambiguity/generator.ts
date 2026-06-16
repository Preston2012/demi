#!/usr/bin/env npx tsx
/**
 * Bench 6 (Intent Inference), corpus generator.
 *
 * Calls gpt-4.1-mini (with provider failover via callLLM) to produce
 * ambiguity scenarios. Validates each scenario with Zod; retries on parse
 * failure up to MAX_RETRIES per scenario; aborts if total LLM calls exceed
 * MAX_TOTAL_CALLS.
 *
 * Run once and commit the output:
 *   npx tsx src/benchmark/intent-ambiguity/generator.ts --target 50
 *
 * Output: src/benchmark/intent-ambiguity/fixtures/scenarios.json
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { callLLM } from '../llm-caller.js';
import { ScenarioSchema, FixtureSchema, type Scenario, type Fixture } from './schema.js';

const GEN_MODEL = 'gpt-4.1-mini';
const MAX_RETRIES = 3;
const MAX_TOTAL_CALLS = 175;

const PROMPT = `Generate one ambiguity scenario for an intent-inference benchmark as STRICT JSON
(single object, no markdown).

Schema:
{
  "scenario_id": "amb_<short>",
  "entities": [3-5 strings, distinct names of people/places/things],
  "facts": [
    { "fact_id": "f1", "text": "<single fact>", "about_entity": "<one of entities>" },
    ...6 to 10 facts total
  ],
  "questions": [
    {
      "question_id": "q1",
      "ambiguity_type": "pronoun" | "partial-name" | "time-relative" | "polysemy" | "default-reference",
      "question": "<deliberately ambiguous question>",
      "preferred_interpretation": {
        "entity": "<one of entities, the contextually correct target>",
        "answer": "<short ground-truth answer assuming preferred interpretation>",
        "evidence": ["f1","f3", ...]
      },
      "incorrect_interpretation": {
        "entity": "<a different one of entities, also plausible>",
        "answer": "<what the answer would be under the wrong interpretation>"
      }
    },
    ...exactly 4 questions, one per ambiguity_type from {pronoun, partial-name, time-relative, polysemy, default-reference}
    (pick any 4 of those 5 types per scenario)
  ]
}

Hard constraints:
- The corpus MUST genuinely support BOTH interpretations (so the ambiguity is real).
- The "preferred" interpretation must be the one a thoughtful reader would pick from
  conversational context, typically the most-recent / strongest-association entity.
- The "incorrect" interpretation must be plausible (not absurd), just less likely.
- Each question must reference at least 2 facts in evidence.
- Output MUST be a single JSON object, no prose, no code fences.`;

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
        2000,
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
        // Validate that evidence references real fact_ids and that preferred/incorrect
        // entities are in the entity list and distinct.
        const factIds = new Set(result.data.facts.map((f) => f.fact_id));
        const entitySet = new Set(result.data.entities.map((e) => e.toLowerCase()));
        const valid = result.data.questions.every((q) => {
          const ev = q.preferred_interpretation.evidence;
          if (!ev.every((fid: string) => factIds.has(fid))) return false;
          if (!entitySet.has(q.preferred_interpretation.entity.toLowerCase())) return false;
          if (!entitySet.has(q.incorrect_interpretation.entity.toLowerCase())) return false;
          if (q.preferred_interpretation.entity.toLowerCase() === q.incorrect_interpretation.entity.toLowerCase()) {
            return false;
          }
          return true;
        });
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
  const target = targetIdx !== -1 ? parseInt(args[targetIdx + 1] ?? '50', 10) : 50;

  const fixturesDir = resolve(__dirname, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const outPath = resolve(fixturesDir, 'scenarios.json');

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
