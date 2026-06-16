/**
 * Bench 1 (Correction Propagation), synthetic deterministic generator.
 *
 * Plants a fact, then a correction. Asks 4 question types per trace:
 *   - current   : retrieves the latest value
 *   - historical: retrieves the prior (superseded) value
 *   - change    : asks whether anything changed
 *   - list      : asks for the full sequence
 *
 * Pure function of seed + mode. No LLM. Strings drawn from in-file pools.
 */

const NAMES = [
  'Alice',
  'Ben',
  'Carla',
  'Diego',
  'Eli',
  'Fiona',
  'Gabe',
  'Hana',
  'Ivan',
  'Jada',
  'Kira',
  'Leo',
  'Maya',
  'Noah',
  'Oren',
  'Priya',
  'Quinn',
  'Rita',
  'Samir',
  'Tess',
  'Uma',
  'Vince',
  'Wen',
  'Xio',
  'Yara',
  'Zev',
  'Anya',
  'Brett',
  'Cleo',
  'Dax',
  'Elena',
  'Felix',
  'Greta',
  'Hugo',
  'Iris',
  'Jack',
  'Kai',
  'Lina',
  'Marco',
  'Nia',
];

const COMPANIES = [
  'Acme Corp',
  'Beta Inc',
  'Cyrus Labs',
  'Dynamic Systems',
  'Echo Robotics',
  'Foundry Tech',
  'Glacier AI',
  'Helix Bio',
  'Ion Studios',
  'Juno Networks',
  'Kepler Aero',
  'Lumen Health',
  'Meridian Co',
  'Nova Sigma',
  'Orbit Press',
  'Pylon Group',
  'Quanta Forge',
  'Riftway',
  'Sable Industries',
  'Triton Marine',
  'Umbra Optics',
  'Vertex Bank',
  'Wraith Audio',
  'Xenon Foods',
  'Yarrow Pharma',
  'Zephyr Cloud',
  'Alder Build',
  'Brink Toys',
  'Crest Energy',
  'Daimon Press',
];

const CITIES = [
  'Portland',
  'Austin',
  'Boulder',
  'Madison',
  'Asheville',
  'Burlington',
  'Boise',
  'Reno',
  'Tacoma',
  'Spokane',
  'Tulsa',
  'Omaha',
  'Wichita',
  'Lincoln',
  'Fargo',
  'Toledo',
  'Akron',
  'Erie',
  'Syracuse',
  'Buffalo',
  'Albany',
  'Hartford',
  'Worcester',
  'Manchester',
  'Burlington VT',
  'Bangor',
  'Anchorage',
  'Juneau',
  'Honolulu',
  'Hilo',
];

const PROJECT_STATUSES = [
  'in planning',
  'in design review',
  'in active development',
  'in beta testing',
  'in production',
  'on hold',
  'cancelled',
  'archived',
  'on track',
  'delayed',
];

const PREFERENCE_CATEGORIES: Record<string, string[]> = {
  coffee: [
    'espresso',
    'cold brew',
    'pour over',
    'cappuccino',
    'latte',
    'macchiato',
    'americano',
    'mocha',
    'flat white',
    'turkish',
    'french press',
    'drip',
  ],
  music: [
    'jazz',
    'classical',
    'ambient',
    'techno',
    'folk',
    'metal',
    'hip-hop',
    'reggae',
    'punk',
    'opera',
    'country',
    'blues',
  ],
  book_genre: [
    'mystery',
    'sci-fi',
    'fantasy',
    'biography',
    'history',
    'philosophy',
    'poetry',
    'romance',
    'thriller',
    'horror',
    'memoir',
    'essay',
  ],
};

const POSSESSIONS = [
  ['bicycle', 'motorcycle'],
  ['kayak', 'canoe'],
  ['guitar', 'piano'],
  ['camera', 'drone'],
  ['telescope', 'microscope'],
  ['sailboat', 'rowboat'],
  ['typewriter', 'fountain pen'],
  ['record player', 'reel-to-reel'],
  ['accordion', 'mandolin'],
  ['unicycle', 'penny-farthing'],
  ['theremin', 'synthesizer'],
  ['kite', 'paraglider'],
];

// --- Mulberry32 PRNG (deterministic, no dep) ---

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

function pick<T>(rand: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rand() * arr.length)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
}

function pickPair<T>(rand: () => number, arr: readonly T[]): [T, T] {
  if (arr.length < 2) throw new Error('pickPair needs ≥2 items');
  const a = pick(rand, arr);
  let b = pick(rand, arr);
  while (b === a) b = pick(rand, arr);
  return [a, b];
}

// --- Templates ---

export type TemplateName =
  | 'job'
  | 'job_2'
  | 'location'
  | 'location_2'
  | 'status'
  | 'status_2'
  | 'preference'
  | 'preference_2'
  | 'possession'
  | 'possession_2';

export const ALL_TEMPLATES: TemplateName[] = [
  'job',
  'job_2',
  'location',
  'location_2',
  'status',
  'status_2',
  'preference',
  'preference_2',
  'possession',
  'possession_2',
];

export const MINI_TEMPLATES: TemplateName[] = ['job', 'location', 'status', 'preference'];

interface TemplateBuild {
  /** Subject string for the memory record. */
  subject: string;
  /** Old value (the superseded fact's value). */
  oldValue: string;
  /** New value (the current fact's value). */
  newValue: string;
  /** Original claim text (fact 1). */
  claim1: string;
  /** Correction claim text (fact 2). */
  claim2: string;
  /** Question text by type. */
  questions: {
    current: string;
    historical: string;
    change: string;
    list: string;
  };
}

function buildJob(rand: () => number, subject: string): TemplateBuild {
  const [c1, c2] = pickPair(rand, COMPANIES);
  return {
    subject,
    oldValue: c1,
    newValue: c2,
    claim1: `${subject} works at ${c1}.`,
    claim2: `${subject} works at ${c2}.`,
    questions: {
      current: `Where does ${subject} work now?`,
      historical: `Where did ${subject} work before?`,
      change: `Has ${subject}'s job changed?`,
      list: `List ${subject}'s jobs over time.`,
    },
  };
}

function buildLocation(rand: () => number, subject: string): TemplateBuild {
  const [c1, c2] = pickPair(rand, CITIES);
  return {
    subject,
    oldValue: c1,
    newValue: c2,
    claim1: `${subject} lives in ${c1}.`,
    claim2: `${subject} lives in ${c2}.`,
    questions: {
      current: `Where does ${subject} live now?`,
      historical: `Where did ${subject} live before?`,
      change: `Has ${subject} moved?`,
      list: `List ${subject}'s past and current cities.`,
    },
  };
}

function buildStatus(rand: () => number, subject: string): TemplateBuild {
  const [s1, s2] = pickPair(rand, PROJECT_STATUSES);
  return {
    subject: `${subject}'s project`,
    oldValue: s1,
    newValue: s2,
    claim1: `${subject}'s project is ${s1}.`,
    claim2: `${subject}'s project is ${s2}.`,
    questions: {
      current: `What is the status of ${subject}'s project now?`,
      historical: `What was the status of ${subject}'s project before?`,
      change: `Has the status of ${subject}'s project changed?`,
      list: `List the statuses of ${subject}'s project over time.`,
    },
  };
}

function buildPreference(rand: () => number, subject: string): TemplateBuild {
  const cats = Object.keys(PREFERENCE_CATEGORIES);
  const cat = pick(rand, cats);
  const items = PREFERENCE_CATEGORIES[cat]!;
  const [v1, v2] = pickPair(rand, items);
  return {
    subject: `${subject}'s ${cat}`,
    oldValue: v1,
    newValue: v2,
    claim1: `${subject}'s favorite ${cat} is ${v1}.`,
    claim2: `${subject}'s favorite ${cat} is ${v2}.`,
    questions: {
      current: `What is ${subject}'s favorite ${cat} now?`,
      historical: `What was ${subject}'s favorite ${cat} before?`,
      change: `Has ${subject}'s favorite ${cat} changed?`,
      list: `List ${subject}'s ${cat} preferences over time.`,
    },
  };
}

function buildPossession(rand: () => number, subject: string): TemplateBuild {
  const pair = pick(rand, POSSESSIONS);
  if (pair.length < 2) throw new Error('possession pair malformed');
  const item1 = pair[0]!;
  const item2 = pair[1]!;
  return {
    subject: `${subject}'s vehicle`,
    oldValue: item1,
    newValue: item2,
    claim1: `${subject} owns a ${item1}.`,
    claim2: `${subject} sold the ${item1} and bought a ${item2}.`,
    questions: {
      current: `What does ${subject} own now?`,
      historical: `What did ${subject} own before?`,
      change: `Has ${subject}'s possession changed?`,
      list: `List ${subject}'s vehicles over time.`,
    },
  };
}

const BUILDERS: Record<TemplateName, (rand: () => number, subject: string) => TemplateBuild> = {
  job: buildJob,
  job_2: buildJob,
  location: buildLocation,
  location_2: buildLocation,
  status: buildStatus,
  status_2: buildStatus,
  preference: buildPreference,
  preference_2: buildPreference,
  possession: buildPossession,
  possession_2: buildPossession,
};

// --- Trace and fixture types ---

export type QuestionType = 'current' | 'historical' | 'change' | 'list';

export interface TraceFact {
  fact_id: string;
  claim: string;
  valid_from: string;
  /** fact_id of the fact this supersedes (only on second-onward facts). */
  supersedes_id?: string;
}

export interface TraceQuestion {
  qid: string;
  type: QuestionType;
  question: string;
  /** All keywords must appear in answer (case-insensitive substring). */
  expected_keywords: string[];
  /** None of these keywords may appear in answer (current-question phantom check). */
  expected_excludes: string[];
  /** Old value, exposed for judge phantom detection. */
  old_value: string;
  /** New value, exposed for judge alternate-acceptance ("transition" semantics). */
  new_value: string;
}

export interface Trace {
  trace_id: string;
  subject: string;
  template: TemplateName;
  facts: TraceFact[];
  questions: TraceQuestion[];
}

export interface Fixture {
  version: string;
  seed: number;
  mode: 'mini' | 'full';
  traces: Trace[];
}

// --- Generation ---

const BASE_DATE = Date.UTC(2025, 0, 1); // 2025-01-01

function isoAt(dayOffset: number): string {
  return new Date(BASE_DATE + dayOffset * 86_400_000).toISOString();
}

export function generate(seed: number, mode: 'mini' | 'full'): Fixture {
  const rand = mulberry32(seed);
  const templates = mode === 'mini' ? MINI_TEMPLATES : ALL_TEMPLATES;
  const tracesPerTemplate = mode === 'mini' ? 2 : 5;
  const traces: Trace[] = [];

  let nameIdx = 0;
  let traceCounter = 0;

  for (const tmpl of templates) {
    for (let i = 0; i < tracesPerTemplate; i++) {
      const subjectName = NAMES[nameIdx % NAMES.length]!;
      nameIdx++;
      traceCounter++;

      const built = BUILDERS[tmpl](rand, subjectName);
      const traceId = `trace_${String(traceCounter).padStart(3, '0')}`;
      const fact1Id = `${traceId}_f1`;
      const fact2Id = `${traceId}_f2`;
      const t1Day = traceCounter * 30; // ~1 month spacing across traces
      const t2Day = t1Day + 200;

      const facts: TraceFact[] = [
        { fact_id: fact1Id, claim: built.claim1, valid_from: isoAt(t1Day) },
        { fact_id: fact2Id, claim: built.claim2, valid_from: isoAt(t2Day), supersedes_id: fact1Id },
      ];

      const questions: TraceQuestion[] = [
        {
          qid: `${traceId}_q_current`,
          type: 'current',
          question: built.questions.current,
          expected_keywords: [built.newValue],
          expected_excludes: [built.oldValue],
          old_value: built.oldValue,
          new_value: built.newValue,
        },
        {
          qid: `${traceId}_q_historical`,
          type: 'historical',
          question: built.questions.historical,
          expected_keywords: [built.oldValue],
          expected_excludes: [],
          old_value: built.oldValue,
          new_value: built.newValue,
        },
        {
          qid: `${traceId}_q_change`,
          type: 'change',
          question: built.questions.change,
          expected_keywords: [
            'changed',
            'moved',
            'switched',
            'different',
            'transitioned',
            'now',
            'used to',
            'previously',
            'yes',
          ],
          expected_excludes: [],
          old_value: built.oldValue,
          new_value: built.newValue,
        },
        {
          qid: `${traceId}_q_list`,
          type: 'list',
          question: built.questions.list,
          expected_keywords: [built.oldValue, built.newValue],
          expected_excludes: [],
          old_value: built.oldValue,
          new_value: built.newValue,
        },
      ];

      traces.push({
        trace_id: traceId,
        subject: built.subject,
        template: tmpl,
        facts,
        questions,
      });
    }
  }

  return { version: '1.0', seed, mode, traces };
}
