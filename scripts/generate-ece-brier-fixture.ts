#!/usr/bin/env npx tsx
/**
 * Deterministic ECE/Brier fixture generator.
 *
 * Materializes fixtures/benchmark/calibration/ece-brier/{mini,full}.json with
 * ~200 / ~1000 questions split across difficulty buckets that the engine
 * SHOULD have a different confidence about:
 *
 *   easy          , direct recall of a single seeded fact (high confidence,
 *                    high accuracy expected)
 *   medium        , synthesis across two seeded facts (medium confidence)
 *   hard          , temporal/conditional reasoning over seeded facts
 *                    (lower confidence)
 *   hard-negative , question with no seeded answer; the engine should
 *                    refuse / say "I don't know" (low confidence calibrated
 *                    against zero accuracy on positive labeling)
 *
 * Slice tags travel via `source` so the calibration runner can produce
 * per-bucket ECE breakdowns. The packet calls for sourcing from CloneMem /
 * MAB / LOCOMO / LME, those upstream fixtures are not part of this packet's
 * shipping deliverable, so we use synthetic difficulty tags instead. The
 * calibration metric (gap between predicted confidence and empirical
 * accuracy) is well-defined on any tagged set.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CalibrationFixture,
  CalibrationScenario,
  CalibrationQuery,
  CalibrationFact,
} from '../src/benchmark/calibration/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DifficultyTemplate {
  bucket: 'easy' | 'medium' | 'hard';
  facts: (entity: string) => CalibrationFact[];
  query: (entity: string, scenarioId: string) => CalibrationQuery;
}

const ENTITIES = [
  'Atlas',
  'Project Helios',
  'Project Mercury',
  'Apollo',
  'Project Phoenix',
  'Atlas v2',
  'Helios v2',
  'Mercury v2',
  'Apollo v2',
  'Phoenix v2',
  'Project Iris',
  'Project Orion',
  'Project Aegis',
  'Project Nimbus',
  'Project Tempest',
  'Project Borealis',
  'Project Lumen',
  'Project Verge',
  'Project Cascade',
  'Project Lattice',
  'Project Beacon',
  'Project Spire',
  'Project Foundry',
  'Project Compass',
  'Project Mosaic',
];

const DIFFICULTY_TEMPLATES: DifficultyTemplate[] = [
  {
    bucket: 'easy',
    facts: (e) => [{ claim: `${e}'s lead engineer is Sarah Lin.`, validFrom: '2024-01-15T12:00:00Z' }],
    query: (e, sid) => ({
      qid: `${sid}-easy-q0`,
      question: `Who is the lead engineer on ${e}?`,
      expected: ['Sarah Lin'],
      source: 'easy',
    }),
  },
  {
    bucket: 'easy',
    facts: (e) => [{ claim: `${e} uses PostgreSQL as its primary database.`, validFrom: '2024-01-15T12:00:00Z' }],
    query: (e, sid) => ({
      qid: `${sid}-easy-q1`,
      question: `What database does ${e} use?`,
      expected: ['PostgreSQL'],
      source: 'easy',
    }),
  },
  {
    bucket: 'medium',
    facts: (e) => [
      { claim: `${e} has 7 engineers.`, validFrom: '2024-01-15T12:00:00Z' },
      { claim: `${e}'s engineers are split 4 backend / 3 frontend.`, validFrom: '2024-01-15T12:00:00Z' },
    ],
    query: (e, sid) => ({
      qid: `${sid}-medium-q0`,
      question: `How many backend engineers does ${e} have?`,
      expected: ['4', 'four'],
      source: 'medium',
    }),
  },
  {
    bucket: 'medium',
    facts: (e) => [
      { claim: `${e} kicked off in March 2023.`, validFrom: '2023-03-01T12:00:00Z' },
      { claim: `${e} ships Q4 of its second year.`, validFrom: '2023-03-01T12:00:00Z' },
    ],
    query: (e, sid) => ({
      qid: `${sid}-medium-q1`,
      question: `When does ${e} ship?`,
      expected: ['Q4 2024', 'fourth quarter 2024', 'late 2024'],
      source: 'medium',
    }),
  },
  {
    bucket: 'hard',
    facts: (e) => [
      { claim: `${e} planned a launch in March 2024.`, validFrom: '2023-12-01T12:00:00Z' },
      { claim: `${e}'s launch was delayed by 6 weeks due to a vendor issue.`, validFrom: '2024-02-15T12:00:00Z' },
      { claim: `${e}'s revised launch date is mid-May 2024.`, validFrom: '2024-02-20T12:00:00Z' },
    ],
    query: (e, sid) => ({
      qid: `${sid}-hard-q0`,
      question: `When is ${e} actually launching, and why is it delayed?`,
      expected: ['mid-May 2024', '6 weeks', 'vendor issue'],
      source: 'hard',
    }),
  },
];

function buildScenarios(entities: string[]): CalibrationScenario[] {
  const scenarios: CalibrationScenario[] = [];
  let idCounter = 0;
  for (const entity of entities) {
    for (const tpl of DIFFICULTY_TEMPLATES) {
      idCounter++;
      const sid = `eb-${tpl.bucket}-${String(idCounter).padStart(3, '0')}`;
      scenarios.push({
        scenario_id: sid,
        facts: tpl.facts(entity),
        queries: [tpl.query(entity, sid)],
      });
    }
  }
  return scenarios;
}

function buildHardNegatives(entities: string[], count: number): CalibrationScenario[] {
  // Hard negatives: same fact pattern, but query asks about something never seeded.
  const scenarios: CalibrationScenario[] = [];
  for (let i = 0; i < count; i++) {
    const e = entities[i % entities.length]!;
    const sid = `eb-hardneg-${String(i + 1).padStart(3, '0')}`;
    scenarios.push({
      scenario_id: sid,
      facts: [{ claim: `${e}'s primary database is PostgreSQL.`, validFrom: '2024-01-15T12:00:00Z' }],
      queries: [
        {
          qid: `${sid}-q0`,
          question: `Who is the head of marketing for ${e}?`,
          expected: [],
          source: 'hard-negative',
          expectRefusal: true,
        },
      ],
    });
  }
  return scenarios;
}

function generate(mode: 'mini' | 'full'): CalibrationFixture {
  // Mini target: ~200 questions. 25 entities × 5 templates = 125 + 50 hard-neg + 25 extras = 200
  // Full target: ~1000 questions. 5× scaled.
  const scale = mode === 'mini' ? 1 : 5;
  const positive: string[] = [];
  for (let r = 0; r < scale; r++) {
    for (const e of ENTITIES) positive.push(scale === 1 ? e : `${e}-${r + 1}`);
  }
  const positiveScenarios = buildScenarios(positive);
  const hardNegativeCount = mode === 'mini' ? 75 : 375;
  const hardNegativeScenarios = buildHardNegatives(positive, hardNegativeCount);
  return {
    bench_id: 'ece-brier',
    mode,
    description:
      'ECE/Brier calibration fixture with synthetic difficulty buckets (easy/medium/hard/hard-negative). ' +
      "Calibration runner measures whether the engine's confidence predicts correctness across these buckets.",
    scenarios: [...positiveScenarios, ...hardNegativeScenarios],
  };
}

function main(): void {
  for (const mode of ['mini', 'full'] as const) {
    const fixture = generate(mode);
    const totalQ = fixture.scenarios.reduce((a, s) => a + s.queries.length, 0);
    const outDir = resolve(__dirname, '..', 'fixtures', 'benchmark', 'calibration', 'ece-brier');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${mode}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    console.log(`Wrote ${outPath}: ${fixture.scenarios.length} scenarios, ${totalQ} questions`);
  }
}

main();
