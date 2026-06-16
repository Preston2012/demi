/**
 * Recall@K (S51 / D8), deterministic fixture builder.
 *
 * Each cluster has 10 memories, K (3-5) labeled relevant=true, the rest false.
 * Templates parameterized by entity name to scale to the 50/200 cluster
 * targets without hand-curating each one. Pure function of (seed, mode).
 */

import type { RecallCluster, RecallFixture, RecallMemory } from '../types.js';

interface ClusterTemplate {
  questionTemplate: (entity: string) => string;
  /** Each entry: claim text + relevance label. */
  memoryTemplates: Array<{ claim: (e: string) => string; relevant: boolean }>;
}

const TEMPLATES: ClusterTemplate[] = [
  // 1. "What did I eat for breakfast last Tuesday?", temporal recall
  {
    questionTemplate: () => 'What did I eat for breakfast last Tuesday?',
    memoryTemplates: [
      { claim: () => 'I had eggs and toast for breakfast Tuesday morning.', relevant: true },
      { claim: () => 'Tuesday breakfast was scrambled eggs and toast.', relevant: true },
      { claim: () => 'I ate eggs around 8am Tuesday before work.', relevant: true },
      { claim: () => 'I had pizza for dinner Saturday.', relevant: false },
      { claim: () => 'Lunch on Tuesday was a chicken sandwich.', relevant: false },
      { claim: () => 'Wednesday breakfast was cereal.', relevant: false },
      { claim: () => 'I skipped breakfast Friday morning.', relevant: false },
      { claim: () => 'Sunday brunch was eggs benedict at the cafe.', relevant: false },
      { claim: () => 'I drink coffee every morning.', relevant: false },
      { claim: () => 'I ordered Thai food Monday night.', relevant: false },
    ],
  },
  // 2. "Who is the lead engineer on Project X?"
  {
    questionTemplate: (e) => `Who is the lead engineer on ${e}?`,
    memoryTemplates: [
      { claim: (e) => `Sarah Lin is the lead engineer on ${e}.`, relevant: true },
      { claim: (e) => `${e} is led by Sarah Lin.`, relevant: true },
      { claim: (e) => `Sarah Lin runs the engineering side of ${e}.`, relevant: true },
      { claim: (e) => `${e} uses PostgreSQL.`, relevant: false },
      { claim: (e) => `${e} ships in Q4.`, relevant: false },
      { claim: () => `I have a doctor's appointment next week.`, relevant: false },
      { claim: (e) => `${e}'s designer is Marcus Yi.`, relevant: false },
      { claim: () => `My favorite restaurant closed last month.`, relevant: false },
      { claim: () => `The team had a retreat in March.`, relevant: false },
      { claim: () => `Standup is at 10am daily.`, relevant: false },
    ],
  },
  // 3. "What is my favorite Y?", preference recall
  {
    questionTemplate: (e) => `What is my favorite ${e}?`,
    memoryTemplates: [
      { claim: (e) => `My favorite ${e} is the one I bought last spring.`, relevant: true },
      { claim: (e) => `I prefer the ${e} I keep mentioning, the spring one.`, relevant: true },
      { claim: (e) => `The spring ${e} is my top choice.`, relevant: true },
      { claim: () => `My commute is 28 minutes by bike.`, relevant: false },
      { claim: () => `I usually eat dinner at 7pm.`, relevant: false },
      { claim: (e) => `I have several ${e}s but the spring one is favored.`, relevant: true },
      { claim: () => `My laptop battery died yesterday.`, relevant: false },
      { claim: () => `I am attending a conference in October.`, relevant: false },
      { claim: () => `My budget for next quarter is set.`, relevant: false },
      { claim: () => `Linear is my issue tracker of choice.`, relevant: false },
    ],
  },
  // 4. "When did Anna start her PhD?"
  {
    questionTemplate: (e) => `When did ${e} start their PhD?`,
    memoryTemplates: [
      { claim: (e) => `${e} started their PhD in September 2022.`, relevant: true },
      { claim: (e) => `${e}'s PhD began in fall 2022.`, relevant: true },
      { claim: (e) => `${e} matriculated for the doctoral program in September 2022.`, relevant: true },
      { claim: (e) => `${e} had a baby in 2023.`, relevant: false },
      { claim: (e) => `${e}'s research is in computational neuroscience.`, relevant: false },
      { claim: (e) => `${e} graduated college in 2018.`, relevant: false },
      { claim: () => `My dog is named Rex.`, relevant: false },
      { claim: () => `My morning routine starts at 6am.`, relevant: false },
      { claim: (e) => `${e} works in the lab at Caltech.`, relevant: false },
      { claim: () => `The team retreat is in June.`, relevant: false },
    ],
  },
  // 5. "How many engineers on Atlas?"
  {
    questionTemplate: (e) => `How many engineers does ${e} have?`,
    memoryTemplates: [
      { claim: (e) => `${e} has 7 engineers in total.`, relevant: true },
      { claim: (e) => `${e}'s engineering team is seven people.`, relevant: true },
      { claim: (e) => `Headcount on ${e} is 7 engineers.`, relevant: true },
      { claim: (e) => `${e} ships features every two weeks.`, relevant: false },
      { claim: () => `My anniversary is in June.`, relevant: false },
      { claim: (e) => `${e} uses Linear for issues.`, relevant: false },
      { claim: () => `I run 5K twice a week.`, relevant: false },
      { claim: () => `The cafe near work has good espresso.`, relevant: false },
      { claim: (e) => `${e}'s budget runs through next year.`, relevant: false },
      { claim: () => `My partner's name is Maria.`, relevant: false },
    ],
  },
];

const ENTITY_POOL = [
  'Project Atlas',
  'Project Helios',
  'Project Mercury',
  'Project Apollo',
  'Project Phoenix',
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
  'Anna',
  'Marcus',
  'Theo',
  'Sarah',
  'Maria',
  'jacket',
  'book',
  'shoes',
  'pen',
  'mug',
  'watch',
  'notebook',
  'wallet',
  'bag',
  'phone case',
];

export function buildRecallFixture(seed: number, mode: 'mini' | 'full'): RecallFixture {
  // Mini: 50 clusters; full: 200 clusters.
  const target = mode === 'mini' ? 50 : 200;
  const clusters: RecallCluster[] = [];
  let counter = 0;
  // Cycle through (template × entity) until we hit target.
  // Avoid pure round-robin so identical templates don't all clump.
  const order = pickOrder(seed, target);
  for (const idx of order) {
    counter++;
    const tplIdx = idx % TEMPLATES.length;
    const entityIdx = Math.floor(idx / TEMPLATES.length) % ENTITY_POOL.length;
    const tpl = TEMPLATES[tplIdx]!;
    const entity = ENTITY_POOL[entityIdx]!;
    const baseId = `recall-${String(counter).padStart(3, '0')}`;
    const memories: RecallMemory[] = tpl.memoryTemplates.map((mt, mi) => ({
      memory_id: `${baseId}-m${mi}`,
      claim: mt.claim(entity),
      relevant: mt.relevant,
      validFrom: '2024-01-15T12:00:00Z',
    }));
    clusters.push({
      cluster_id: baseId,
      question: tpl.questionTemplate(entity),
      memories,
    });
  }
  return {
    bench_id: 'recall',
    mode,
    description:
      'Recall@K calibration with held-out relevance labels. Each cluster: 10 memories, 3-5 labeled relevant=true. Engine retrieves; we measure precision/recall/F1 at multiple K + AUPRC across the cluster.',
    clusters,
  };
}

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

function pickOrder(seed: number, count: number): number[] {
  const rand = mulberry32(seed);
  const arr: number[] = [];
  for (let i = 0; i < count; i++) arr.push(i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
