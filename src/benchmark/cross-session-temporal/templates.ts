/**
 * Bench 2 (Cross-Session Temporal), synthetic deterministic generator (S68 v2).
 *
 * REWRITE NOTE (S68 brain #2186):
 * Previous generator used 10 themes × 1 sentence template × small word pools
 * (e.g. 10 PEOPLE × 6 TOPICS = 60 unique work claims). With 350+ facts
 * in full mode, BGE-small embeddings of "I had a meeting with X about Y"
 * collided at cosine ≥0.95, the engine's dedup threshold, so the bench
 * historically ran with `BENCH_SKIP_DEDUP=true`. This silently invalidated
 * production behavior testing AND polluted retrieval rank with duplicates.
 *
 * v2 fixes this with three changes:
 *   1. Pool sizes expanded ~5× (vocabulary diversity)
 *   2. 3 sentence templates per theme (syntactic diversity)
 *   3. Generator runs offline (`bake.ts`), produces a fixture JSON the
 *      runner loads. Generation time uses BGE to verify pairwise cosine
 *      stays below MAX_PAIRWISE_COSINE for every fact pair. Rejected
 *      candidates are resampled. Generator FAILS if it can't produce a
 *      sufficiently-distinct fixture in BUDGET tries, that failure is the
 *      signal to expand pools further.
 *
 * Result: bench runs with `BENCH_SKIP_DEDUP=false` (production behavior),
 * retrieval candidates are genuinely distinguishable, and the score
 * actually measures cross-session temporal recall under semantic pressure.
 *
 * Bench premise (unchanged):
 *   Many sessions of facts accumulate in a single user's memory across
 *   ~70 days. Five question types test retrieval over time:
 *     - recent (last 5 sessions)
 *     - mid (10-25 sessions ago)
 *     - distant (30+ sessions ago)
 *     - time-anchored ("on YYYY-MM-DD")
 *     - order-aware (before/after pairs)
 *   Judge is deterministic; ground truth is the literal session_idx + fact_idx.
 */

// =============================================================================
// EXPANDED POOLS, 5× scale-up vs v1
// =============================================================================

const PEOPLE = [
  // 50 names (was 10)
  'Marcus',
  'Lena',
  'Devi',
  'Theo',
  'Anya',
  'Jules',
  'Pavel',
  'Mira',
  'Ren',
  'Sasha',
  'Imani',
  'Kenji',
  'Octavia',
  'Rashid',
  'Yuki',
  'Diego',
  'Priya',
  'Mateo',
  'Anika',
  'Soren',
  'Cassia',
  'Bram',
  'Elif',
  'Fenwick',
  'Halina',
  'Idris',
  'Joaquin',
  'Kallista',
  'Linnea',
  'Magnus',
  'Nadya',
  'Osric',
  'Petra',
  'Quinn',
  'Roan',
  'Saskia',
  'Tobias',
  'Ursa',
  'Viggo',
  'Wren',
  'Xiomara',
  'Yusra',
  'Zahir',
  'Aurelio',
  'Bashira',
  'Calix',
  'Dagny',
  'Eero',
  'Fioralba',
  'Galen',
];

const WORK_TOPICS = [
  // 30 topics (was 6, no leading "the")
  'budget',
  'timeline',
  'launch plan',
  'team morale',
  'new hire',
  'postmortem',
  'roadmap',
  'sprint goals',
  'staffing model',
  'vendor proposal',
  'compliance review',
  'security audit',
  'product strategy',
  'customer escalation',
  'incident response',
  'training program',
  'office move',
  'org redesign',
  'pricing study',
  'partner integration',
  'feature freeze',
  'release notes',
  'performance review',
  'scope cut',
  'risk register',
  'tooling refresh',
  'data migration',
  'API redesign',
  'capacity planning',
  'on-call rotation',
];

const HOBBIES = [
  // 20 hobbies (was 6)
  'hiking',
  'birding',
  'climbing',
  'sailing',
  'cycling',
  'kayaking',
  'foraging',
  'spelunking',
  'orienteering',
  'paragliding',
  'fly fishing',
  'archery',
  'horseback riding',
  'snowshoeing',
  'tide-pooling',
  'photography',
  'mushroom hunting',
  'ice climbing',
  'free diving',
  'astrophotography',
];

const HOBBY_PLACES = [
  // 30 places (was 6)
  'Mount Hood',
  'Crater Ridge',
  'Shadow Lake',
  'Pine Hollow',
  'Iron Bluff',
  'Foxglove Park',
  'Wrenwood Trail',
  'Bramble Creek',
  'Auric Falls',
  'Sequoia Heights',
  'Skyrim Mesa',
  'Verdant Ravine',
  'Coppermine Saddle',
  'Junegrass Meadow',
  'Granite Hollow',
  'Larkspur Pass',
  'Obsidian Spire',
  'Whisperwind Ridge',
  'Salt Marsh',
  'Driftwood Cove',
  'Hemlock Bowl',
  'Indigo Valley',
  'Nightingale Glen',
  'Rosethorn Cliffs',
  'Sapphire Bay',
  'Tanglewood Notch',
  'Umberwood Plateau',
  'Veridian Steppe',
  'Willowmere Pond',
  'Yarrow Heights',
];

const TRAVEL = [
  // 40 cities (was 8)
  'Lisbon',
  'Kyoto',
  'Reykjavik',
  'Marrakech',
  'Hanoi',
  'Prague',
  'Quito',
  'Tbilisi',
  'Porto',
  'Osaka',
  'Tallinn',
  'Fes',
  'Hoi An',
  'Bratislava',
  'Cusco',
  'Yerevan',
  'Cartagena',
  'Antwerp',
  'Helsinki',
  'Sarajevo',
  'Valletta',
  'Trondheim',
  'Plovdiv',
  'Bergen',
  'Cádiz',
  'Vilnius',
  'Ljubljana',
  'Lviv',
  'Kraków',
  'Riga',
  'Granada',
  'Bologna',
  'Rotterdam',
  'Aarhus',
  'Galway',
  'Lecce',
  'Tromsø',
  'Mostar',
  'Tashkent',
  'Almaty',
];

const RELATIVES = [
  'cousin',
  'aunt',
  'uncle',
  'sibling',
  'grandmother',
  'grandfather',
  'niece',
  'nephew',
  'godparent',
  'stepmother',
  'stepfather',
  'second cousin',
];

const RELATIVE_NAMES = [
  // 30 names (was 6)
  'Phoebe',
  'Walter',
  'Imogen',
  'Cyrus',
  'Helena',
  'Otto',
  'Beatrix',
  'Caspar',
  'Delphine',
  'Edmund',
  'Fenella',
  'Grover',
  'Hortense',
  'Ingmar',
  'Junia',
  'Krister',
  'Lavinia',
  'Mortimer',
  'Nessa',
  'Orvar',
  'Persephone',
  'Quincy',
  'Romola',
  'Sven',
  'Tabitha',
  'Ulric',
  'Vespera',
  'Wendell',
  'Xavier',
  'Ysolde',
];

const HEALTH_ISSUES = [
  // 30 issues
  'a sore knee',
  'allergies',
  'a routine checkup',
  'a sprained wrist',
  'an eye exam',
  'a flu shot',
  'a tetanus booster',
  'a bad cold',
  'plantar fasciitis',
  'recurrent migraines',
  'a dental cleaning',
  'a skin biopsy',
  'tendonitis',
  'persistent vertigo',
  'a thyroid panel',
  'a referral consult',
  'shoulder impingement',
  'a tooth extraction',
  'a hearing test',
  'lower back stiffness',
  'iron deficiency',
  'sciatica',
  'a sinus infection',
  'an ankle sprain',
  'a B12 panel',
  'a sleep study',
  'persistent fatigue',
  'a stress fracture',
  'a vision check',
  'a balance test',
];

const PROVIDERS = [
  // 25 providers (was 5)
  'Dr. Patel',
  'Dr. Okafor',
  'Dr. Yamamoto',
  'Dr. Morales',
  'Dr. Bauer',
  'Dr. Voss',
  'Dr. Beaumont',
  'Dr. Singh',
  'Dr. Hirsch',
  'Dr. Lefevre',
  'Dr. Kim',
  'Dr. Andersen',
  'Dr. Choudhury',
  'Dr. Esposito',
  'Dr. Petrovic',
  'Dr. Jorgensen',
  'Dr. Eriksen',
  'Dr. Khoury',
  'Dr. Zhang',
  'Dr. Rasmussen',
  'Dr. Najjar',
  'Dr. Park',
  'Dr. Quinones',
  'Dr. Suzuki',
  'Dr. Vasquez',
];

const FOODS = [
  // 50 foods (was 10)
  'pho',
  'ramen',
  'sushi',
  'lasagna',
  'shakshuka',
  'paella',
  'mole',
  'biryani',
  'pierogi',
  'gnocchi',
  'okonomiyaki',
  'feijoada',
  'tagine',
  'larb',
  'goulash',
  'jerk chicken',
  'banh mi',
  'arepas',
  'bobotie',
  'cassoulet',
  'kimchi stew',
  'mapo tofu',
  'shawarma',
  'jambalaya',
  'kibbeh',
  'manti',
  'bunny chow',
  'doro wat',
  'pad see ew',
  'rendang',
  'borscht',
  'risotto milanese',
  'churrasco',
  'pelmeni',
  'ceviche',
  'kebab platter',
  'massaman curry',
  'gazpacho',
  'fish and chips',
  'congee',
  'falafel wraps',
  'tom kha gai',
  'dosa',
  'spanakopita',
  'duck confit',
  'tonkatsu',
  'kottu roti',
  'asado',
  'puttanesca',
  'bibimbap',
];

const MEALS = ['breakfast', 'lunch', 'dinner', 'brunch', 'late-night snack'];

const BOOKS = [
  // 30 titles (was 8)
  '"Glass Houses"',
  '"The Iron Garden"',
  '"Salt Roads"',
  '"A Quiet Sea"',
  '"The Last Cartographer"',
  '"Northern Lights"',
  '"Ember Year"',
  '"The Owl Atlas"',
  '"Driftless"',
  '"The Hollow Forge"',
  '"Birds of the Borderlands"',
  '"Ash and Antler"',
  '"The Salt Witch"',
  '"Wireblood"',
  '"The Mineral Sky"',
  '"Brackishwater"',
  '"The Lacquered Box"',
  '"Velvet Tides"',
  '"The Quiet Ferryman"',
  '"Bone Compass"',
  '"The Indigo Letter"',
  '"Fishhook Bay"',
  '"The Lantern Keeper"',
  '"Sallow Hill"',
  '"Tin Roof Republic"',
  '"The Ember Riders"',
  '"Compass and Cinder"',
  '"The Marble Choir"',
  '"Sleepless Cartographers"',
  '"The Black Reed"',
];

const ARTISTS = [
  // 30 artists (was 8)
  'Brackish Tide',
  'Hollow Echoes',
  'Velvet Sparrow',
  'Cold Iron Choir',
  'Glass Mountain',
  'Russet Hare',
  'The Slow Train',
  'Indigo Forge',
  'Bramble Crown',
  'The Field Recorders',
  'Pale Lantern',
  'Ember Sister',
  'Northern Quartz',
  'The Chestnut Letter',
  'Driftwood Anthem',
  'Halcyon Tin',
  'Black Salt Quartet',
  'Twin Larch',
  'The Ophir Sessions',
  'Marigold Veil',
  'Sycamore Lull',
  'The Petrichor Council',
  'Trillium Drone',
  'Wildgrass Almanac',
  'Cinder Glade',
  'The Hawthorn Choir',
  'Flintwater',
  'Vesper Fern',
  'The Soft Gradient',
  'Slate Equinox',
];

const WEATHERS = [
  'fog',
  'a thunderstorm',
  'heavy snow',
  'a heat wave',
  'sleet',
  'a wind advisory',
  'a hailstorm',
  'lake-effect flurries',
  'an ice storm',
  'a dust haze',
  'a frost warning',
  'low cloud cover',
  'patchy drizzle',
  'a humid mist',
  'a polar plunge',
  'high gusts',
];

const NEWS_TOPICS = [
  'merger',
  'election',
  'climate report',
  'stadium proposal',
  'new bridge',
  'data breach',
  'trade deal',
  'rocket launch',
  'transit referendum',
  'rail strike',
  'archaeological find',
  'minimum wage debate',
  'spectrum auction',
  'submarine cable cut',
  'glacier retreat report',
  'ferry route change',
  'algorithmic-bias study',
  'reservoir levels report',
  'rare-earth standoff',
  'microplastics ruling',
];

// =============================================================================
// SENTENCE TEMPLATES, 3 per theme, varied syntax for embedding distinctness
// =============================================================================

import type { Theme as ThemeType } from './generator-types.js';
export type Theme = ThemeType;
export const THEMES: readonly Theme[] = [
  'work',
  'hobby',
  'travel',
  'family',
  'health',
  'food',
  'books',
  'music',
  'weather',
  'news',
];

interface BuiltFact {
  /** The full claim text. */
  claim: string;
  /** Distinctive nouns the judge looks for in answers (lowercased substrings). */
  distinctive: string[];
  /** A short keyword the question can target. */
  topic_token: string;
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rand() * arr.length)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
}

/** 3 sentence shapes per theme, picked uniformly at random per fact. */
export function buildFact(rand: () => number, theme: Theme): BuiltFact {
  switch (theme) {
    case 'work': {
      const p = pick(rand, PEOPLE);
      const t = pick(rand, WORK_TOPICS);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I had a meeting with ${p} about the ${t}.`
          : shape === 1
            ? `${p} pulled me into a quick sync on ${t}.`
            : `My one-on-one with ${p} ended up centered on ${t}.`;
      return { claim, distinctive: [p, t], topic_token: 'work' };
    }
    case 'hobby': {
      const a = pick(rand, HOBBIES);
      const place = pick(rand, HOBBY_PLACES);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I went ${a} at ${place}.`
          : shape === 1
            ? `Spent the morning ${a} out at ${place}.`
            : `${place} turned out to be a great spot for ${a}.`;
      return { claim, distinctive: [a, place], topic_token: 'hobby' };
    }
    case 'travel': {
      const t = pick(rand, TRAVEL);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I visited ${t}.`
          : shape === 1
            ? `Wrapped up a few days exploring ${t}.`
            : `${t} was the destination this time.`;
      return { claim, distinctive: [t], topic_token: 'travel' };
    }
    case 'family': {
      const r = pick(rand, RELATIVES);
      const n = pick(rand, RELATIVE_NAMES);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I called my ${r} ${n}.`
          : shape === 1
            ? `Got an unexpected call from my ${r} ${n} today.`
            : `${n}, my ${r}, and I caught up on the phone.`;
      return { claim, distinctive: [r, n], topic_token: 'family' };
    }
    case 'health': {
      const p = pick(rand, PROVIDERS);
      const i = pick(rand, HEALTH_ISSUES);
      const iClean = i.replace(/^(a |an )/, '');
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I went to ${p} for ${i}.`
          : shape === 1
            ? `${p} saw me about ${iClean}.`
            : `Booked time with ${p} to address ${iClean}.`;
      return { claim, distinctive: [p, iClean], topic_token: 'health' };
    }
    case 'food': {
      const f = pick(rand, FOODS);
      const m = pick(rand, MEALS);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I ate ${f} for ${m}.`
          : shape === 1
            ? `${m.charAt(0).toUpperCase() + m.slice(1)} today was ${f}.`
            : `Picked up ${f} on the way home, that was ${m}.`;
      return { claim, distinctive: [f, m], topic_token: 'food' };
    }
    case 'books': {
      const b = pick(rand, BOOKS);
      const bClean = b.replace(/"/g, '');
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I started reading ${b}.`
          : shape === 1
            ? `Cracked open ${b} this evening.`
            : `${b} arrived in the mail and I'm already a few chapters in.`;
      return { claim, distinctive: [bClean], topic_token: 'books' };
    }
    case 'music': {
      const a = pick(rand, ARTISTS);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I listened to ${a}.`
          : shape === 1
            ? `${a} has been on repeat.`
            : `Discovered ${a} via a friend's playlist.`;
      return { claim, distinctive: [a], topic_token: 'music' };
    }
    case 'weather': {
      const w = pick(rand, WEATHERS);
      const wClean = w.replace(/^(a |an )/, '');
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `There was ${w} in the morning.`
          : shape === 1
            ? `${wClean.charAt(0).toUpperCase() + wClean.slice(1)} rolled through overnight.`
            : `Had to delay everything because of ${wClean}.`;
      return { claim, distinctive: [wClean], topic_token: 'weather' };
    }
    case 'news': {
      const n = pick(rand, NEWS_TOPICS);
      const shape = Math.floor(rand() * 3);
      const claim =
        shape === 0
          ? `I read about the ${n} in the news.`
          : shape === 1
            ? `The ${n} story keeps developing.`
            : `Saw a long-read on the ${n} this morning.`;
      return { claim, distinctive: [n], topic_token: 'news' };
    }
  }
}
