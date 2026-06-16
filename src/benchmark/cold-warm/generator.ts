/**
 * Bench 5 (Cold-Warm Transition), synthetic deterministic generator.
 *
 * Each scenario has two sub-corpora:
 *   - seed pack: 8-12 facts representing pre-loaded knowledge ("smart" mode).
 *     Inserted with source='import' → provenance=IMPORTED.
 *   - user stream: 6-10 facts the user adds in their first session.
 *     Inserted with source='user' → provenance=USER_CONFIRMED.
 *
 * Question types:
 *   - seed-only: must surface a seeded fact (no user contamination)
 *   - user-only: must surface a user fact (no seed contamination)
 *   - hybrid:    answer should reference both sources, with attribution
 *   - conflict:  seed and user disagree → user version should win
 *
 * Pure function of seed. No LLM.
 */

// --- Mulberry32 ---

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

// --- Topic packs ---

interface TopicPack {
  topic: string;
  /** Seeded "knowledge pack" facts and the keyword each is identified by. */
  seedFacts: { claim: string; keyword: string }[];
  /** User-stream facts and their keyword. */
  userFacts: { claim: string; keyword: string }[];
  /** Pairs that intentionally conflict. seed claims X, user claims X'. */
  conflicts: { seed: { claim: string; keyword: string }; user: { claim: string; keyword: string } }[];
  /** Question templates by category (referencing keywords for ground truth). */
  templates: {
    seedOnly: { question: string; expectedKeyword: string }[];
    userOnly: { question: string; expectedKeyword: string }[];
    hybrid: { question: string; seedKeyword: string; userKeyword: string }[];
    conflict: { question: string; conflictIndex: number }[];
  };
}

const PACKS: TopicPack[] = [
  {
    topic: 'project-management',
    seedFacts: [
      { claim: 'The framework recommends running a daily 15-minute standup.', keyword: 'standup' },
      { claim: 'The framework defines a sprint as a fixed 2-week iteration.', keyword: 'sprint' },
      {
        claim: 'The framework treats a retrospective as a mandatory end-of-sprint ritual.',
        keyword: 'retrospective',
      },
      { claim: 'The framework recommends a kickoff meeting at the start of every quarter.', keyword: 'kickoff' },
      { claim: 'The framework defines a milestone as a binary done/not-done checkpoint.', keyword: 'milestone' },
      { claim: 'The framework prescribes WIP limits to control flow on the team board.', keyword: 'WIP limit' },
    ],
    userFacts: [
      { claim: 'My current project is named Atlas and runs through next March.', keyword: 'Atlas' },
      { claim: 'I lead a team of four engineers on the Atlas project.', keyword: 'four engineers' },
      {
        claim: 'My team has been blocked on infrastructure for the last two weeks.',
        keyword: 'blocked on infrastructure',
      },
      { claim: 'I scheduled my first kickoff meeting for next Monday at 10am.', keyword: 'next Monday at 10am' },
    ],
    conflicts: [
      {
        seed: { claim: 'The framework recommends running a daily 15-minute standup.', keyword: 'standup' },
        user: {
          claim: 'My team has decided to run our standup as a weekly 30-minute meeting instead of daily.',
          keyword: 'weekly 30-minute',
        },
      },
      {
        seed: { claim: 'The framework defines a sprint as a fixed 2-week iteration.', keyword: '2-week' },
        user: { claim: 'My team uses 1-week sprints for the Atlas project.', keyword: '1-week sprints' },
      },
    ],
    templates: {
      seedOnly: [
        { question: 'What does the framework say about retrospectives?', expectedKeyword: 'retrospective' },
        { question: 'How does the framework define a milestone?', expectedKeyword: 'milestone' },
        { question: 'What does the framework say about WIP limits?', expectedKeyword: 'WIP limit' },
      ],
      userOnly: [
        { question: 'What is my current project called?', expectedKeyword: 'Atlas' },
        { question: 'How big is my team?', expectedKeyword: 'four engineers' },
        { question: 'What is my team currently blocked on?', expectedKeyword: 'blocked on infrastructure' },
      ],
      hybrid: [
        {
          question: 'When is the kickoff meeting for my project, and what does the framework say about kickoffs?',
          seedKeyword: 'kickoff',
          userKeyword: 'next Monday at 10am',
        },
      ],
      conflict: [
        { question: 'How often does my team run standups?', conflictIndex: 0 },
        { question: 'How long are my project sprints?', conflictIndex: 1 },
      ],
    },
  },
  {
    topic: 'productivity',
    seedFacts: [
      {
        claim: 'The productivity guide recommends time-blocking the calendar for deep work.',
        keyword: 'time-blocking',
      },
      { claim: 'The productivity guide promotes the inbox-zero method for email.', keyword: 'inbox-zero' },
      {
        claim: 'The productivity guide treats single-tasking as the dominant work mode.',
        keyword: 'single-tasking',
      },
      { claim: 'The productivity guide recommends a weekly review every Friday afternoon.', keyword: 'weekly review' },
      {
        claim: 'The productivity guide treats notifications as a major source of context-switching cost.',
        keyword: 'notifications',
      },
    ],
    userFacts: [
      { claim: 'I use a paper notebook for daily planning.', keyword: 'paper notebook' },
      { claim: 'My most productive hours are between 6am and 9am.', keyword: '6am and 9am' },
      { claim: 'I currently keep my email open all day at work.', keyword: 'email open all day' },
      { claim: 'I have a meeting with my manager every other Wednesday.', keyword: 'every other Wednesday' },
    ],
    conflicts: [
      // Packet C3 / Bug 4: seed.claim must match an entry in seedFacts above
      // verbatim so the generator can attach canonical_fact_id to a single
      // record per conflict pair (no orphan duplicate seed record).
      {
        seed: {
          claim: 'The productivity guide promotes the inbox-zero method for email.',
          keyword: 'inbox-zero',
        },
        user: { claim: 'I have given up on inbox-zero and now ignore most email.', keyword: 'ignore most email' },
      },
      {
        seed: {
          claim: 'The productivity guide recommends a weekly review every Friday afternoon.',
          keyword: 'Friday afternoon',
        },
        user: { claim: 'I do my weekly review on Sunday evening.', keyword: 'Sunday evening' },
      },
    ],
    templates: {
      seedOnly: [
        { question: 'What does the productivity guide say about time-blocking?', expectedKeyword: 'time-blocking' },
        { question: 'What does the productivity guide say about single-tasking?', expectedKeyword: 'single-tasking' },
        { question: 'What does the productivity guide say about notifications?', expectedKeyword: 'notifications' },
      ],
      userOnly: [
        { question: 'What planning tool do I use?', expectedKeyword: 'paper notebook' },
        { question: 'When are my most productive hours?', expectedKeyword: '6am and 9am' },
        { question: 'When is my recurring meeting with my manager?', expectedKeyword: 'every other Wednesday' },
      ],
      hybrid: [
        {
          question: "How does my email habit compare to the productivity guide's advice?",
          seedKeyword: 'inbox-zero',
          userKeyword: 'email open all day',
        },
      ],
      conflict: [
        { question: 'When should I do my weekly review?', conflictIndex: 1 },
        { question: 'What is my current email approach?', conflictIndex: 0 },
      ],
    },
  },
  {
    topic: 'fitness',
    seedFacts: [
      { claim: 'The training plan recommends three strength sessions per week.', keyword: 'three strength sessions' },
      { claim: 'The training plan treats sleep as the dominant recovery variable.', keyword: 'sleep' },
      { claim: 'The training plan emphasizes progressive overload week to week.', keyword: 'progressive overload' },
      { claim: 'The training plan recommends one full rest day per week.', keyword: 'one full rest day' },
      { claim: 'The training plan defines a deload week as every fourth week.', keyword: 'deload week' },
    ],
    userFacts: [
      { claim: 'I currently train at the Riverside gym four mornings a week.', keyword: 'Riverside gym' },
      { claim: 'My favorite lift is the deadlift.', keyword: 'deadlift' },
      { claim: 'I tweaked my left shoulder six weeks ago and it still hurts.', keyword: 'left shoulder' },
      { claim: 'My current target is to bench 200 pounds by spring.', keyword: '200 pounds by spring' },
    ],
    conflicts: [
      {
        seed: { claim: 'The training plan recommends three strength sessions per week.', keyword: 'three' },
        user: { claim: 'I train four mornings a week, not three.', keyword: 'four mornings' },
      },
    ],
    templates: {
      seedOnly: [
        {
          question: 'What does the training plan say about progressive overload?',
          expectedKeyword: 'progressive overload',
        },
        { question: 'What does the training plan say about rest days?', expectedKeyword: 'one full rest day' },
        { question: 'What does the training plan say about deload weeks?', expectedKeyword: 'deload week' },
      ],
      userOnly: [
        { question: 'What gym do I train at?', expectedKeyword: 'Riverside gym' },
        { question: 'What is my favorite lift?', expectedKeyword: 'deadlift' },
        { question: 'What injury am I dealing with?', expectedKeyword: 'left shoulder' },
      ],
      hybrid: [
        {
          question: 'What does the training plan say about strength sessions, and how does my own routine compare?',
          seedKeyword: 'three strength sessions',
          userKeyword: 'four mornings',
        },
      ],
      conflict: [{ question: 'How many days a week do I train?', conflictIndex: 0 }],
    },
  },
  {
    topic: 'cooking',
    seedFacts: [
      {
        claim: 'The cookbook recommends cooking with extra-virgin olive oil for low-heat dishes.',
        keyword: 'extra-virgin olive oil',
      },
      { claim: 'The cookbook treats kosher salt as the default for seasoning.', keyword: 'kosher salt' },
      { claim: 'The cookbook recommends resting meat for ten minutes before slicing.', keyword: 'resting meat' },
      { claim: 'The cookbook calls for using a cast-iron skillet for searing.', keyword: 'cast-iron skillet' },
      { claim: 'The cookbook treats mise en place as a non-negotiable habit.', keyword: 'mise en place' },
    ],
    userFacts: [
      { claim: 'I keep my main spice rack on the counter next to the stove.', keyword: 'next to the stove' },
      { claim: 'I have one chef knife that I bought five years ago.', keyword: 'five years ago' },
      { claim: 'I usually cook dinner around 7pm on weeknights.', keyword: '7pm on weeknights' },
      { claim: 'I am hosting eight people for dinner this Saturday.', keyword: 'eight people' },
    ],
    conflicts: [
      {
        seed: { claim: 'The cookbook treats kosher salt as the default for seasoning.', keyword: 'kosher salt' },
        user: { claim: 'I prefer fine sea salt over kosher salt for everyday cooking.', keyword: 'fine sea salt' },
      },
    ],
    templates: {
      seedOnly: [
        { question: 'What does the cookbook say about resting meat?', expectedKeyword: 'resting meat' },
        { question: 'What does the cookbook say about cast iron?', expectedKeyword: 'cast-iron skillet' },
        { question: 'What does the cookbook say about mise en place?', expectedKeyword: 'mise en place' },
      ],
      userOnly: [
        { question: 'Where is my spice rack?', expectedKeyword: 'next to the stove' },
        { question: 'How old is my chef knife?', expectedKeyword: 'five years ago' },
        { question: 'How many people am I hosting Saturday?', expectedKeyword: 'eight people' },
      ],
      hybrid: [
        {
          question: 'What does the cookbook recommend about salt, and what do I actually use?',
          seedKeyword: 'kosher salt',
          userKeyword: 'fine sea salt',
        },
      ],
      conflict: [{ question: 'What kind of salt do I cook with?', conflictIndex: 0 }],
    },
  },
];

// --- Fixture types ---

export type ColdWarmQuestionType = 'seed-only' | 'user-only' | 'hybrid' | 'conflict';

export interface ColdWarmFact {
  fact_id: string;
  source: 'seed' | 'user';
  claim: string;
  /**
   * Packet C3 / Bug 4: conflict pairs share a stable canonical UUID so the
   * provenance-aware dedup in inject/budget.ts picks the user version. Set
   * only on the seed and user halves of an intentional conflict; left
   * undefined for plain facts.
   */
  canonical_fact_id?: string;
}

export interface ColdWarmQuestion {
  qid: string;
  type: ColdWarmQuestionType;
  question: string;
  /** All keywords required (case-insensitive substring) for pass. */
  expected_keywords: string[];
  /** Forbidden keywords (e.g. seed value when user wins). */
  expected_excludes: string[];
  /** Provenance the answer's primary fact should have come from. */
  expected_provenance: 'imported' | 'user-confirmed' | 'both';
}

export interface ColdWarmScenario {
  scenario_id: string;
  topic: string;
  facts: ColdWarmFact[];
  questions: ColdWarmQuestion[];
}

export interface ColdWarmFixture {
  version: string;
  seed: number;
  mode: 'mini' | 'full';
  scenarios: ColdWarmScenario[];
}

// --- Generation ---

export function generate(seed: number, mode: 'mini' | 'full'): ColdWarmFixture {
  const rand = mulberry32(seed);
  // We use the rand only for fact ordering; topic packs are fixed.
  void rand;

  const tracesPerPack = mode === 'mini' ? 1 : 4;
  const packs = PACKS;
  const scenarios: ColdWarmScenario[] = [];
  let scenarioCounter = 0;

  // Packet C3 / Bug 4: deterministic canonical UUID per conflict pair.
  // Builds a v4-shaped UUID from a stable string seed so the seed and user
  // halves share the same canonicalFactId without needing a real hash dep.
  function conflictUuid(scenarioId: string, conflictIdx: number): string {
    const seedStr = `${scenarioId}_conflict_${conflictIdx}`;
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) | 0;
    const hex = (h >>> 0).toString(16).padStart(8, '0');
    // Pad out to UUID v4 shape; the regex in src/write/index.ts only checks
    // structural format, not version bits.
    const fill = (hex + hex + hex + hex).slice(0, 32);
    return `${fill.slice(0, 8)}-${fill.slice(8, 12)}-4${fill.slice(13, 16)}-a${fill.slice(17, 20)}-${fill.slice(20, 32)}`;
  }

  for (const pack of packs) {
    for (let t = 0; t < tracesPerPack; t++) {
      scenarioCounter++;
      const scenarioId = `cw_${String(scenarioCounter).padStart(3, '0')}`;
      const facts: ColdWarmFact[] = [];
      let factCounter = 0;
      function addFact(source: 'seed' | 'user', claim: string, canonicalFactId?: string): string {
        factCounter++;
        const id = `${scenarioId}_f${factCounter}`;
        const fact: ColdWarmFact = { fact_id: id, source, claim };
        if (canonicalFactId) fact.canonical_fact_id = canonicalFactId;
        facts.push(fact);
        return id;
      }

      // Seed pack first.
      for (const sf of pack.seedFacts) addFact('seed', sf.claim);
      // Conflict seed claims also seeded (if not duplicates by exact claim).
      // Packet C3 / Bug 4: tag both halves of each conflict pair with a
      // shared canonical_fact_id so dedup picks user > seed at inject time.
      for (let ci = 0; ci < pack.conflicts.length; ci++) {
        const c = pack.conflicts[ci]!;
        const cuid = conflictUuid(scenarioId, ci);
        const existing = facts.find((f) => f.claim === c.seed.claim);
        if (existing) {
          existing.canonical_fact_id = cuid;
        } else {
          addFact('seed', c.seed.claim, cuid);
        }
      }
      // Then user stream.
      for (const uf of pack.userFacts) addFact('user', uf.claim);
      // Conflict user statements at end.
      for (let ci = 0; ci < pack.conflicts.length; ci++) {
        const c = pack.conflicts[ci]!;
        const cuid = conflictUuid(scenarioId, ci);
        addFact('user', c.user.claim, cuid);
      }

      const questions: ColdWarmQuestion[] = [];
      let qCounter = 0;
      function nextQid(): string {
        qCounter++;
        return `${scenarioId}_q${String(qCounter).padStart(2, '0')}`;
      }

      const cap = mode === 'mini' ? 2 : pack.templates.seedOnly.length;
      for (const t of pack.templates.seedOnly.slice(0, cap)) {
        questions.push({
          qid: nextQid(),
          type: 'seed-only',
          question: t.question,
          expected_keywords: [t.expectedKeyword],
          expected_excludes: [],
          expected_provenance: 'imported',
        });
      }
      for (const t of pack.templates.userOnly.slice(0, cap)) {
        questions.push({
          qid: nextQid(),
          type: 'user-only',
          question: t.question,
          expected_keywords: [t.expectedKeyword],
          expected_excludes: [],
          expected_provenance: 'user-confirmed',
        });
      }
      for (const t of pack.templates.hybrid) {
        questions.push({
          qid: nextQid(),
          type: 'hybrid',
          question: t.question,
          expected_keywords: [t.seedKeyword, t.userKeyword],
          expected_excludes: [],
          expected_provenance: 'both',
        });
      }
      for (const t of pack.templates.conflict) {
        const conflict = pack.conflicts[t.conflictIndex];
        if (!conflict) continue;
        questions.push({
          qid: nextQid(),
          type: 'conflict',
          question: t.question,
          expected_keywords: [conflict.user.keyword],
          expected_excludes: [conflict.seed.keyword],
          expected_provenance: 'user-confirmed',
        });
      }

      scenarios.push({ scenario_id: scenarioId, topic: pack.topic, facts, questions });
    }
  }

  return { version: '1.0', seed, mode, scenarios };
}
