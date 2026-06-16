/**
 * Attribution Accuracy bench (S51 / D4), deterministic generator.
 *
 * Five attack patterns, each tests whether the engine correctly identifies
 * WHICH memory it surfaced and reports its source + date:
 *
 *   source-collision       , multiple memories about the same fact, different
 *                             sources. Most recent wins.
 *   date-confusion         , natural-language date phrasing ("last March",
 *                             "January 15th") competing with ISO timestamps.
 *   cross-source-duplicate , same fact across two distinct sources. Engine
 *                             must report a single canonical source.
 *   stale-source-contradiction, old source asserts X, new source asserts Y.
 *                             Engine should attribute to the newer source.
 *   anonymous-source       , memory has no source label. Engine should
 *                             surface the fact but flag source unknown.
 *
 * Per scenario: 5 memories, 1 query. Deterministic given a seed.
 * Mini: 12 entities × 5 patterns = 60 questions.
 * Full: 48 entities × 5 patterns = 240 questions.
 */

import type { ProductFact, ProductFixture, ProductQuery, ProductScenario } from '../types.js';

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

const ENTITIES_MINI = [
  'my project Atlas',
  'my dog Rex',
  'my favorite restaurant',
  'my workout routine',
  'my apartment',
  'my career goal',
  'my best friend Sarah',
  'my college',
  'my hometown',
  'my car',
  'my book club',
  'my hobby',
];

const ENTITIES_FULL = [
  ...ENTITIES_MINI,
  'my brother',
  'my sister',
  'my therapist',
  'my doctor',
  'my morning routine',
  'my favorite movie',
  'my last vacation',
  'my upcoming wedding',
  'my budget',
  'my running pace',
  'my favorite author',
  'my preferred coffee shop',
  'my financial advisor',
  'my chess rating',
  'my apartment lease',
  'my retirement plan',
  'my cooking style',
  'my favorite hike',
  'my workplace',
  'my garden',
  'my gym membership',
  'my dental routine',
  'my piano practice',
  'my language tutor',
  'my favorite podcast',
  'my study group',
  'my mentor',
  'my office desk setup',
  'my favorite dish',
  'my dietary restriction',
  'my preferred airline',
  'my home internet provider',
  'my insurance policy',
  'my reading list',
  'my photography style',
  'my car insurance',
];

export type AttributionPatternId =
  | 'source-collision'
  | 'date-confusion'
  | 'cross-source-duplicate'
  | 'stale-source-contradiction'
  | 'anonymous-source';

const PATTERNS: AttributionPatternId[] = [
  'source-collision',
  'date-confusion',
  'cross-source-duplicate',
  'stale-source-contradiction',
  'anonymous-source',
];

interface ScenarioBuild {
  facts: ProductFact[];
  query: ProductQuery;
  /** memory_id (within facts[]) we expect to be the canonical answer. */
  expectedFactIndex: number;
}

function isoFromDate(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}T12:00:00Z`;
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}

function patternLabel(p: AttributionPatternId): string {
  return p;
}

function buildScenarioForPattern(pattern: AttributionPatternId, entity: string, scenarioId: string): ScenarioBuild {
  const e = entity;
  switch (pattern) {
    case 'source-collision': {
      // Same content "X" appears twice with different sources; newer should win.
      const facts: ProductFact[] = [
        {
          claim: `${e} is currently in the design phase`,
          source: 'conversation_2024-01-15',
          validFrom: isoFromDate(2024, 1, 15),
          meta: { factId: `${scenarioId}-f0` },
        },
        {
          claim: `${e} requires weekly status updates`,
          source: 'document_upload_2024-03-22',
          validFrom: isoFromDate(2024, 3, 22),
          meta: { factId: `${scenarioId}-f1` },
        },
        {
          claim: `${e} is currently in the design phase`,
          source: 'conversation_2024-06-10',
          validFrom: isoFromDate(2024, 6, 10),
          meta: { factId: `${scenarioId}-f2` },
        },
        {
          claim: `${e} has stakeholder sign-off`,
          source: 'api_import_2025-02-01',
          validFrom: isoFromDate(2025, 2, 1),
          meta: { factId: `${scenarioId}-f3` },
        },
        {
          claim: `${e} is on track for Q4`,
          source: 'conversation_2025-08-15',
          validFrom: isoFromDate(2025, 8, 15),
          meta: { factId: `${scenarioId}-f4` },
        },
      ];
      const query: ProductQuery = {
        qid: `${scenarioId}-q0`,
        category: 'source-collision',
        question: `When did I most recently tell you that ${e} is currently in the design phase, and what was the source?`,
        expected: ['conversation_2024-06-10', 'June 2024', '2024-06-10'],
        meta: {
          pattern,
          expectedFactIndex: 2,
          expectedSource: 'conversation_2024-06-10',
          expectedDate: '2024-06-10',
        },
      };
      return { facts, query, expectedFactIndex: 2 };
    }
    case 'date-confusion': {
      // Two different "last March" candidates; query specifies which March.
      const facts: ProductFact[] = [
        {
          claim: `${e} had a major review`,
          source: 'conversation_log',
          validFrom: isoFromDate(2023, 3, 12),
          meta: { factId: `${scenarioId}-f0`, dateNL: 'March 2023' },
        },
        {
          claim: `${e} was kicked off`,
          source: 'document_upload',
          validFrom: isoFromDate(2024, 1, 5),
          meta: { factId: `${scenarioId}-f1`, dateNL: 'January 2024' },
        },
        {
          claim: `${e} had a major review`,
          source: 'conversation_log',
          validFrom: isoFromDate(2024, 3, 18),
          meta: { factId: `${scenarioId}-f2`, dateNL: 'March 2024' },
        },
        {
          claim: `${e} hit a milestone`,
          source: 'api_import',
          validFrom: isoFromDate(2024, 9, 30),
          meta: { factId: `${scenarioId}-f3`, dateNL: 'September 2024' },
        },
        {
          claim: `${e} had a major review`,
          source: 'conversation_log',
          validFrom: isoFromDate(2025, 3, 7),
          meta: { factId: `${scenarioId}-f4`, dateNL: 'March 2025' },
        },
      ];
      const query: ProductQuery = {
        qid: `${scenarioId}-q0`,
        category: 'date-confusion',
        question: `In March 2024, what did I tell you about ${e}? When was the date exactly?`,
        expected: ['March 2024', '2024-03-18', 'major review'],
        meta: {
          pattern,
          expectedFactIndex: 2,
          expectedSource: 'conversation_log',
          expectedDate: '2024-03-18',
        },
      };
      return { facts, query, expectedFactIndex: 2 };
    }
    case 'cross-source-duplicate': {
      // Same fact appears in two distinct sources; engine should attribute consistently.
      const facts: ProductFact[] = [
        {
          claim: `${e} costs around 200 dollars per month`,
          source: 'conversation_2024-04-01',
          validFrom: isoFromDate(2024, 4, 1),
          meta: { factId: `${scenarioId}-f0` },
        },
        {
          claim: `${e} costs around 200 dollars per month`,
          source: 'document_upload_2024-04-10',
          validFrom: isoFromDate(2024, 4, 10),
          meta: { factId: `${scenarioId}-f1` },
        },
        {
          claim: `${e} requires a credit card on file`,
          source: 'document_upload_2024-04-10',
          validFrom: isoFromDate(2024, 4, 10),
          meta: { factId: `${scenarioId}-f2` },
        },
        {
          claim: `${e} can be paused at any time`,
          source: 'conversation_2024-09-15',
          validFrom: isoFromDate(2024, 9, 15),
          meta: { factId: `${scenarioId}-f3` },
        },
        {
          claim: `${e} has an annual discount`,
          source: 'document_upload_2025-01-05',
          validFrom: isoFromDate(2025, 1, 5),
          meta: { factId: `${scenarioId}-f4` },
        },
      ];
      // Either of the two duplicate sources is acceptable; expected = the most recent (f1).
      const query: ProductQuery = {
        qid: `${scenarioId}-q0`,
        category: 'cross-source-duplicate',
        question: `When did I tell you that ${e} costs around 200 dollars per month, and what was the source?`,
        expected: ['document_upload_2024-04-10', 'April 2024', '2024-04-10'],
        meta: {
          pattern,
          expectedFactIndex: 1,
          expectedSource: 'document_upload_2024-04-10',
          expectedDate: '2024-04-10',
          alternateAcceptableSources: ['conversation_2024-04-01'],
        },
      };
      return { facts, query, expectedFactIndex: 1 };
    }
    case 'stale-source-contradiction': {
      // Old source says X, new source says Y. Engine should attribute the
      // current value to the newer source, not the stale one.
      const facts: ProductFact[] = [
        {
          claim: `${e} is best on Mondays`,
          source: 'conversation_2023-02-14',
          validFrom: isoFromDate(2023, 2, 14),
          meta: { factId: `${scenarioId}-f0` },
        },
        {
          claim: `${e} requires twice-monthly check-ins`,
          source: 'document_upload_2023-09-01',
          validFrom: isoFromDate(2023, 9, 1),
          meta: { factId: `${scenarioId}-f1` },
        },
        {
          claim: `${e} is best on Wednesdays`,
          source: 'conversation_2024-11-20',
          validFrom: isoFromDate(2024, 11, 20),
          meta: { factId: `${scenarioId}-f2` },
        },
        {
          claim: `${e} has a hard deadline`,
          source: 'api_import_2024-12-15',
          validFrom: isoFromDate(2024, 12, 15),
          meta: { factId: `${scenarioId}-f3` },
        },
        {
          claim: `${e} is on track`,
          source: 'conversation_2025-05-04',
          validFrom: isoFromDate(2025, 5, 4),
          meta: { factId: `${scenarioId}-f4` },
        },
      ];
      const query: ProductQuery = {
        qid: `${scenarioId}-q0`,
        category: 'stale-source-contradiction',
        question: `What day of the week is best for ${e}, and where did that come from?`,
        expected: ['Wednesdays', 'conversation_2024-11-20', 'November 2024'],
        meta: {
          pattern,
          expectedFactIndex: 2,
          expectedSource: 'conversation_2024-11-20',
          expectedDate: '2024-11-20',
          contradictedSource: 'conversation_2023-02-14',
        },
      };
      return { facts, query, expectedFactIndex: 2 };
    }
    case 'anonymous-source': {
      // One memory has no source label; engine should answer the content but
      // flag the source as unknown / not available.
      const facts: ProductFact[] = [
        {
          claim: `${e} prefers afternoon scheduling`,
          source: 'conversation_2024-02-10',
          validFrom: isoFromDate(2024, 2, 10),
          meta: { factId: `${scenarioId}-f0` },
        },
        {
          claim: `${e} has a 30-minute commute`,
          source: 'document_upload_2024-04-22',
          validFrom: isoFromDate(2024, 4, 22),
          meta: { factId: `${scenarioId}-f1` },
        },
        {
          claim: `${e} responds best to gentle nudges`,
          // No source, anonymous.
          validFrom: isoFromDate(2024, 7, 7),
          meta: { factId: `${scenarioId}-f2`, anonymous: true },
        },
        {
          claim: `${e} has a budget of 500 dollars`,
          source: 'api_import_2024-10-01',
          validFrom: isoFromDate(2024, 10, 1),
          meta: { factId: `${scenarioId}-f3` },
        },
        {
          claim: `${e} should escalate fast`,
          source: 'conversation_2025-03-15',
          validFrom: isoFromDate(2025, 3, 15),
          meta: { factId: `${scenarioId}-f4` },
        },
      ];
      const query: ProductQuery = {
        qid: `${scenarioId}-q0`,
        category: 'anonymous-source',
        question: `What's the best way to get a response from ${e}? Where did you hear that from?`,
        expected: ['gentle nudges', 'unknown source', 'no source available'],
        meta: {
          pattern,
          expectedFactIndex: 2,
          expectedSource: null,
          expectedDate: '2024-07-07',
          shouldFlagAnonymous: true,
        },
      };
      return { facts, query, expectedFactIndex: 2 };
    }
  }
}

export function generate(seed: number, mode: 'mini' | 'full'): ProductFixture {
  const rand = mulberry32(seed);
  const entities = mode === 'mini' ? ENTITIES_MINI : ENTITIES_FULL;
  // Shuffle entity order deterministically by seed for variety
  const shuffled = entities.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const scenarios: ProductScenario[] = [];
  let counter = 0;
  for (const pattern of PATTERNS) {
    for (const entity of shuffled) {
      counter++;
      const scenarioId = `attr-${pad3(counter)}-${pattern}`;
      const built = buildScenarioForPattern(pattern, entity, scenarioId);
      scenarios.push({
        scenario_id: scenarioId,
        facts: built.facts,
        queries: [built.query],
        meta: { pattern: patternLabel(pattern), entity },
      });
    }
  }

  return {
    bench_id: 'attribution',
    upstream_version: 'attribution-gen-v1',
    description:
      'Attribution Accuracy bench: 5 attack patterns testing whether the engine correctly identifies which memory it surfaced and reports its source + date.',
    mode,
    scenarios,
  };
}
