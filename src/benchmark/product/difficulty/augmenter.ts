/**
 * Difficulty Injection (S51 / D6), pluggable augmentation layer.
 *
 * Operates on src/benchmark/public/shared/runner-base.ts:PublicBenchFixture
 * so any normalized public-bench fixture can be made harder by composing
 * one or more augmentations. The CLI loads a fixture, applies the chosen
 * augmentations in order, and re-runs the same harness on the result.
 *
 * Patterns:
 *   entity-collision  , rename 30% of entities to share names (multiple
 *                        "Sarah"s, multiple "Project X"s) so the engine has
 *                        to disambiguate via context, not just name match.
 *   four-hop          , extend multi-hop queries with 2 extra hops by
 *                        appending bridging clauses derived from facts in
 *                        the same scenario.
 *   distractor-flood  , seed 50 irrelevant memories per scenario so the
 *                        engine's precision-vs-recall trade-off is stressed.
 *   paraphrase-mix    , rephrase 50% of seed memories with a templated
 *                        rewrite that preserves the fact but changes the
 *                        surface form (lexical-only retrieval gets weaker).
 *
 * All augmentations are pure functions of (fixture, opts, seed). Stack-
 * composable: applying [entityCollision, distractorFlood] is well-defined.
 */

import type {
  PublicBenchFact,
  PublicBenchFixture,
  PublicBenchQuery,
  PublicBenchScenario,
} from '../../public/shared/runner-base.js';

export type AugmentationId = 'entity-collision' | 'four-hop' | 'distractor-flood' | 'paraphrase-mix';

export interface AugmentOpts {
  seed: number;
  /** Augment-specific knobs; consumed by individual augmenters. */
  collisionRate?: number; // entityCollision; default 0.3
  numHops?: number; // fourHop; default 2 extra hops
  distractorsPerScenario?: number; // distractorFlood; default 50
  paraphraseRate?: number; // paraphraseMix; default 0.5
}

export type AugmentFn = (fixture: PublicBenchFixture, opts: AugmentOpts) => PublicBenchFixture;

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

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// entity-collision: rename a fraction of named entities to a small shared pool
// ---------------------------------------------------------------------------

const COLLISION_NAMES = ['Sarah', 'Alex', 'Project X', 'the project', 'the team', 'Jordan'];

/**
 * Heuristic: replace capitalized multi-word entities matching the regex
 * `\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b` in a sampled fraction of facts +
 * queries. Predictable, deterministic, and reuses the same collision pool
 * across scenarios so collisions actually overlap.
 */
export const entityCollision: AugmentFn = (fixture, opts) => {
  const rate = opts.collisionRate ?? 0.3;
  const rand = mulberry32(opts.seed);
  const next = deepClone(fixture);

  const entityRegex = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
  function maybeCollide(text: string): string {
    return text.replace(entityRegex, (m) => {
      if (rand() < rate) return COLLISION_NAMES[Math.floor(rand() * COLLISION_NAMES.length)]!;
      return m;
    });
  }

  for (const sc of next.scenarios) {
    sc.facts = sc.facts.map((f) => ({ ...f, claim: maybeCollide(f.claim) }));
    sc.queries = sc.queries.map((q) => ({ ...q, question: maybeCollide(q.question) }));
  }
  next.bench_id = `${next.bench_id}+entity-collision`;
  return next;
};

// ---------------------------------------------------------------------------
// four-hop: append bridging clauses to queries to extend multi-hop chains
// ---------------------------------------------------------------------------

export const fourHop: AugmentFn = (fixture, opts) => {
  const numHops = opts.numHops ?? 2;
  const next = deepClone(fixture);
  const rand = mulberry32(opts.seed);

  for (const sc of next.scenarios) {
    if (sc.facts.length < numHops + 1) continue;
    sc.queries = sc.queries.map((q) => {
      // Pick `numHops` distinct fact subjects from the scenario as bridges.
      const bridgeFacts: PublicBenchFact[] = [];
      const used = new Set<number>();
      for (let h = 0; h < numHops && bridgeFacts.length < numHops; h++) {
        const idx = Math.floor(rand() * sc.facts.length);
        if (used.has(idx)) continue;
        used.add(idx);
        bridgeFacts.push(sc.facts[idx]!);
      }
      const bridges = bridgeFacts.map((f) => `Given that "${f.claim}",`).join(' ');
      const augmented = bridges ? `${bridges} ${q.question}` : q.question;
      return { ...q, question: augmented };
    });
  }
  next.bench_id = `${next.bench_id}+four-hop`;
  return next;
};

// ---------------------------------------------------------------------------
// distractor-flood: seed N irrelevant memories per scenario
// ---------------------------------------------------------------------------

const DISTRACTOR_TEMPLATES = [
  'I went to the grocery store and bought {item}.',
  'My commute took {duration} this morning.',
  'I watched a documentary about {topic}.',
  'The weather forecast predicted {weather} for the weekend.',
  'I picked up a new book titled "{title}".',
  'The meeting room booking system glitched on {date}.',
  'I checked the {tool} dashboard and saw {value}.',
  'My laptop battery lasted {hours} hours yesterday.',
];

const SLOT_VALUES: Record<string, string[]> = {
  item: ['apples', 'oranges', 'bread', 'milk', 'cereal', 'a magazine', 'paper towels'],
  duration: ['28 minutes', '45 minutes', 'over an hour', '12 minutes', 'about 35 minutes'],
  topic: ['ancient Rome', 'deep-sea exploration', 'urban planning', 'jazz history', 'volcanism'],
  weather: ['rain', 'fog', 'a heat wave', 'a thunderstorm', 'unusually cold air', 'a clear sky'],
  title: ['The Quiet Year', 'Hidden Forecasts', 'Atlas of Mistakes', 'The Pattern Library'],
  date: ['Tuesday', 'last Friday', 'the 14th', 'mid-month'],
  tool: ['Datadog', 'Grafana', 'Sentry', 'Linear', 'Notion'],
  value: ['three new alerts', 'a clean dashboard', 'unusual latency', 'no incidents'],
  hours: ['three', 'six', 'nine', 'four', 'eight'],
};

function fillSlots(template: string, rand: () => number): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const opts = SLOT_VALUES[k];
    if (!opts) return `[${k}]`;
    return opts[Math.floor(rand() * opts.length)] ?? `[${k}]`;
  });
}

export const distractorFlood: AugmentFn = (fixture, opts) => {
  const numDistractors = opts.distractorsPerScenario ?? 50;
  const rand = mulberry32(opts.seed);
  const next = deepClone(fixture);
  for (const sc of next.scenarios) {
    const distractors: PublicBenchFact[] = [];
    for (let i = 0; i < numDistractors; i++) {
      const tpl = DISTRACTOR_TEMPLATES[Math.floor(rand() * DISTRACTOR_TEMPLATES.length)]!;
      distractors.push({
        claim: fillSlots(tpl, rand),
        subject: 'user',
        source: 'user',
        meta: { distractor: true },
      });
    }
    sc.facts = [...sc.facts, ...distractors];
  }
  next.bench_id = `${next.bench_id}+distractor-flood`;
  return next;
};

// ---------------------------------------------------------------------------
// paraphrase-mix: rephrase a fraction of seed memories
// ---------------------------------------------------------------------------

const PARAPHRASE_PREFIXES = [
  'It is the case that ',
  'Notably, ',
  'For the record, ',
  'Just to be clear: ',
  'As I mentioned: ',
  '',
];

const PARAPHRASE_SUFFIXES = [', that is what I told you.', ' (per my prior note)', ' (this is established)', ''];

export const paraphraseMix: AugmentFn = (fixture, opts) => {
  const rate = opts.paraphraseRate ?? 0.5;
  const rand = mulberry32(opts.seed);
  const next = deepClone(fixture);

  function rephrase(claim: string): string {
    if (rand() >= rate) return claim;
    const prefix = PARAPHRASE_PREFIXES[Math.floor(rand() * PARAPHRASE_PREFIXES.length)]!;
    const suffix = PARAPHRASE_SUFFIXES[Math.floor(rand() * PARAPHRASE_SUFFIXES.length)]!;
    // Lowercase the first letter when prefix is non-empty (sentence-flow).
    const inner = prefix && claim.length > 0 ? claim[0]!.toLowerCase() + claim.slice(1) : claim;
    return `${prefix}${inner}${suffix}`.trim();
  }

  for (const sc of next.scenarios) {
    sc.facts = sc.facts.map((f) => ({ ...f, claim: rephrase(f.claim) }));
  }
  next.bench_id = `${next.bench_id}+paraphrase-mix`;
  return next;
};

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export const AUGMENTERS: Record<AugmentationId, AugmentFn> = {
  'entity-collision': entityCollision,
  'four-hop': fourHop,
  'distractor-flood': distractorFlood,
  'paraphrase-mix': paraphraseMix,
};

export function applyAugmentations(
  fixture: PublicBenchFixture,
  augmentations: AugmentationId[],
  opts: AugmentOpts,
): PublicBenchFixture {
  let result = fixture;
  for (let i = 0; i < augmentations.length; i++) {
    const fn = AUGMENTERS[augmentations[i]!];
    if (!fn) throw new Error(`Unknown augmentation: ${augmentations[i]}`);
    // Salt seed per-augmentation so stacked augmenters don't collide.
    result = fn(result, { ...opts, seed: opts.seed + i * 1000 });
  }
  return result;
}

/**
 * Helper: shape-check a JSON blob as a PublicBenchFixture before passing
 * through the augmenters. Keeps the CLI honest.
 */
export function assertPublicBenchFixture(v: unknown): PublicBenchFixture {
  if (!v || typeof v !== 'object') throw new Error('fixture is not an object');
  const f = v as Partial<PublicBenchFixture>;
  if (typeof f.bench_id !== 'string') throw new Error('fixture.bench_id missing');
  if (!Array.isArray(f.scenarios)) throw new Error('fixture.scenarios missing');
  for (const sc of f.scenarios as PublicBenchScenario[]) {
    if (!Array.isArray(sc.facts) || !Array.isArray(sc.queries)) {
      throw new Error(`scenario ${sc.scenario_id} missing facts/queries`);
    }
    for (const q of sc.queries) {
      const qv = q as PublicBenchQuery;
      if (!qv.qid || typeof qv.question !== 'string') {
        throw new Error(`scenario ${sc.scenario_id} has malformed query`);
      }
    }
  }
  return v as PublicBenchFixture;
}
