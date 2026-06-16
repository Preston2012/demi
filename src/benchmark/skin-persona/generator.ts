/**
 * Bench 4 (Skin Persona Consistency), synthetic deterministic generator.
 *
 * A "persona trace" = one strong constraint about the user + 8-12 ordinary
 * facts + 12 questions across three categories:
 *   - direct-relevant: the persona constraint should drive the answer
 *   - adjacent-relevant: the persona should be considered in the answer
 *   - unrelated control: the persona should NOT appear in the answer
 *
 * Pure function of seed. No LLM. Strings drawn from in-file pools.
 */

// --- Mulberry32 (no dep) ---

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

// --- Persona templates ---

export type PersonaName =
  | 'vegetarian'
  | 'sober'
  | 'peanut_allergy'
  | 'pediatric_oncologist'
  | 'kosher'
  | 'type1_diabetic'
  | 'planner'
  | 'single_parent_autism';

export const ALL_PERSONAS: PersonaName[] = [
  'vegetarian',
  'sober',
  'peanut_allergy',
  'pediatric_oncologist',
  'kosher',
  'type1_diabetic',
  'planner',
  'single_parent_autism',
];

export const MINI_PERSONAS: PersonaName[] = ['vegetarian', 'sober', 'peanut_allergy', 'planner'];

interface PersonaSpec {
  /** Constraint claims (3-5 facts establishing the persona). */
  constraintFacts: string[];
  /** Persona keywords that should appear in retrieved set on relevant Qs but NEVER in unrelated Qs. */
  personaKeywords: string[];
  /** Question packs by category. */
  directRelevant: PersonaQuestion[];
  adjacentRelevant: PersonaQuestion[];
  unrelatedControl: PersonaQuestion[];
}

interface PersonaQuestion {
  question: string;
  /** All keywords case-insensitive substring required (≥1). */
  expected_keywords: string[];
  /** None of these may appear in answer (e.g. for vegetarian: "steak"). */
  expected_excludes: string[];
}

const NEUTRAL_FACTS = [
  'I live in a small apartment downtown.',
  'I have a cat named Olive.',
  'I usually walk to work.',
  'I read mystery novels before bed.',
  'I learned to play piano as a child.',
  'I have a sister who lives in Denver.',
  'I broke my left wrist when I was 12.',
  'I prefer cold weather to hot.',
  'I keep a small herb garden on the balcony.',
  'I subscribe to a weekly local newspaper.',
  'I started knitting last winter.',
  'I have a fear of public speaking.',
];

const PERSONAS: Record<PersonaName, PersonaSpec> = {
  vegetarian: {
    constraintFacts: [
      'I have been a strict vegetarian for ten years.',
      'I find the smell of meat unappetizing.',
      'I always check menus for vegetarian options before going to a restaurant.',
    ],
    personaKeywords: ['vegetarian', 'no meat', 'plant-based', 'meatless'],
    directRelevant: [
      {
        question: 'What should I have for dinner tonight?',
        expected_keywords: ['vegetarian', 'plant', 'vegetable', 'pasta', 'tofu', 'beans', 'salad', 'risotto', 'curry'],
        expected_excludes: ['steak', 'chicken', 'pork', 'bacon', 'beef', 'salmon'],
      },
      {
        question: 'Pick a recipe for a quick weeknight meal.',
        expected_keywords: ['vegetarian', 'plant', 'vegetable', 'pasta', 'tofu', 'lentils', 'chickpeas'],
        expected_excludes: ['steak', 'chicken', 'pork', 'bacon', 'beef'],
      },
      {
        question: 'What protein should I cook this week?',
        expected_keywords: ['tofu', 'tempeh', 'beans', 'lentils', 'chickpeas', 'eggs', 'paneer'],
        expected_excludes: ['steak', 'chicken', 'pork', 'bacon', 'beef'],
      },
      {
        question: 'Plan my grocery list for the week.',
        expected_keywords: ['vegetable', 'vegetarian', 'tofu', 'beans', 'lentils', 'plant'],
        expected_excludes: ['steak', 'chicken breast', 'pork', 'bacon', 'ground beef'],
      },
    ],
    adjacentRelevant: [
      {
        question: 'Recommend a restaurant for my anniversary.',
        expected_keywords: ['vegetarian', 'plant', 'options', 'menu'],
        expected_excludes: ['steakhouse', 'BBQ', 'meat'],
      },
      {
        question: 'What snacks should I bring on a road trip?',
        expected_keywords: ['nuts', 'fruit', 'hummus', 'crackers', 'trail mix', 'vegetable', 'plant'],
        expected_excludes: ['jerky', 'pepperoni', 'salami'],
      },
      {
        question: 'What should I order at the airport?',
        expected_keywords: ['salad', 'wrap', 'vegetable', 'vegetarian', 'plant'],
        expected_excludes: ['burger', 'chicken sandwich', 'steak'],
      },
      {
        question: 'What dish should I bring to the potluck?',
        expected_keywords: ['vegetable', 'vegetarian', 'salad', 'pasta', 'tofu', 'plant'],
        expected_excludes: ['chicken', 'steak', 'meat'],
      },
    ],
    unrelatedControl: [
      { question: 'What time is it in Tokyo?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the capital of Australia?", expected_keywords: [], expected_excludes: [] },
      { question: 'How do I convert Celsius to Fahrenheit?', expected_keywords: [], expected_excludes: [] },
      { question: 'Who painted the Mona Lisa?', expected_keywords: [], expected_excludes: [] },
    ],
  },
  sober: {
    constraintFacts: [
      'I have been sober for five years and I do not drink alcohol.',
      'I attend a weekly recovery meeting on Tuesday evenings.',
      'I avoid bars and restaurants that center around alcohol.',
    ],
    personaKeywords: ['sober', 'alcohol', 'recovery', 'non-alcoholic'],
    directRelevant: [
      {
        question: 'What should I order at the restaurant?',
        expected_keywords: ['non-alcoholic', 'sparkling water', 'mocktail', 'soda', 'tea', 'no alcohol'],
        expected_excludes: ['wine', 'beer', 'cocktail', 'whiskey', 'vodka'],
      },
      {
        question: 'Plan a fun Friday night.',
        expected_keywords: ['movie', 'walk', 'game', 'coffee', 'concert', 'no alcohol', 'sober'],
        expected_excludes: ['bar', 'wine', 'beer', 'cocktails', 'happy hour'],
      },
      {
        question: 'What should I bring as a host gift?',
        expected_keywords: ['flowers', 'chocolate', 'candle', 'tea', 'bread', 'non-alcoholic'],
        expected_excludes: ['wine', 'champagne', 'whiskey', 'beer'],
      },
      {
        question: 'Recommend a drink to celebrate the news.',
        expected_keywords: ['mocktail', 'sparkling', 'kombucha', 'tea', 'lemonade', 'non-alcoholic'],
        expected_excludes: ['wine', 'champagne', 'beer', 'cocktail'],
      },
    ],
    adjacentRelevant: [
      {
        question: 'Recommend a vacation destination for me.',
        expected_keywords: ['hiking', 'museum', 'beach', 'park', 'culture'],
        expected_excludes: ['wine country', 'beer tour', 'pub crawl', 'distillery'],
      },
      {
        question: 'What restaurant should I pick for a first date?',
        expected_keywords: ['cafe', 'restaurant', 'options'],
        expected_excludes: ['wine bar', 'cocktail bar', 'pub'],
      },
      {
        question: 'Suggest activities for my upcoming birthday.',
        expected_keywords: ['dinner', 'museum', 'concert', 'walk', 'park'],
        expected_excludes: ['bar crawl', 'wine tasting', 'brewery tour'],
      },
      {
        question: 'Plan a weekend getaway with friends.',
        expected_keywords: ['hike', 'beach', 'museum', 'cafe', 'park', 'nature'],
        expected_excludes: ['wine tasting', 'brewery', 'cocktail bar'],
      },
    ],
    unrelatedControl: [
      { question: "What's the population of Iceland?", expected_keywords: [], expected_excludes: [] },
      { question: 'How do solar panels work?', expected_keywords: [], expected_excludes: [] },
      { question: 'Who wrote War and Peace?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the boiling point of water?", expected_keywords: [], expected_excludes: [] },
    ],
  },
  peanut_allergy: {
    constraintFacts: [
      'I have a severe peanut allergy and carry an EpiPen at all times.',
      'I cannot eat anything that may contain peanuts or peanut oil.',
      'I always ask restaurants about cross-contamination before ordering.',
    ],
    personaKeywords: ['peanut', 'allergy', 'EpiPen', 'allergic'],
    directRelevant: [
      {
        question: 'What snack should I pack for the flight?',
        expected_keywords: ['fruit', 'crackers', 'cheese', 'pretzels', 'no peanut', 'peanut-free'],
        expected_excludes: ['peanut', 'trail mix', 'PB', 'satay'],
      },
      {
        question: 'Recommend a Thai restaurant for dinner.',
        expected_keywords: ['ask', 'check', 'allergy', 'careful', 'avoid peanut'],
        expected_excludes: ['pad thai', 'satay', 'peanut sauce'],
      },
      {
        question: 'What candy should I buy for the office?',
        expected_keywords: ['chocolate', 'fruit', 'mint', 'check label', 'peanut-free'],
        expected_excludes: ['Reese', 'peanut butter cup', 'M&M with peanut', 'PayDay'],
      },
      {
        question: 'Plan a kids birthday party menu.',
        expected_keywords: ['pizza', 'fruit', 'cake', 'check label', 'no peanut', 'peanut-free'],
        expected_excludes: ['PB&J', 'peanut butter', 'satay'],
      },
    ],
    adjacentRelevant: [
      {
        question: 'What gift basket should I send a friend?',
        expected_keywords: ['fruit', 'cheese', 'tea', 'chocolate', 'check ingredients'],
        expected_excludes: ['peanut brittle', 'mixed nuts'],
      },
      {
        question: 'Pick a granola bar to keep in my bag.',
        expected_keywords: ['oat', 'fruit', 'check label', 'peanut-free', 'allergy'],
        expected_excludes: ['peanut butter', 'PB'],
      },
      {
        question: 'Suggest a quick breakfast.',
        expected_keywords: ['oatmeal', 'yogurt', 'eggs', 'toast', 'fruit'],
        expected_excludes: ['peanut butter toast', 'PB'],
      },
      {
        question: 'What should I order for the team lunch?',
        expected_keywords: ['salad', 'sandwich', 'pizza', 'check ingredients', 'allergy'],
        expected_excludes: ['pad thai', 'satay', 'peanut sauce'],
      },
    ],
    unrelatedControl: [
      { question: "What's the speed of light?", expected_keywords: [], expected_excludes: [] },
      { question: 'When was the printing press invented?', expected_keywords: [], expected_excludes: [] },
      { question: 'How long is the Nile River?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the chemical symbol for gold?", expected_keywords: [], expected_excludes: [] },
    ],
  },
  pediatric_oncologist: {
    constraintFacts: [
      'I am a pediatric oncologist at Memorial Hospital.',
      'I have been practicing pediatric oncology for fifteen years.',
      'My work involves treating children with cancer and supporting their families.',
    ],
    personaKeywords: ['oncologist', 'pediatric', 'hospital', 'cancer'],
    directRelevant: [
      {
        question: 'Suggest a continuing education topic for me.',
        expected_keywords: ['oncology', 'pediatric', 'medical', 'clinical', 'cancer', 'treatment'],
        expected_excludes: [],
      },
      {
        question: 'What conference should I attend this year?',
        expected_keywords: ['oncology', 'pediatric', 'medical', 'clinical', 'cancer'],
        expected_excludes: [],
      },
      {
        question: 'Recommend a podcast for my commute.',
        expected_keywords: ['medical', 'oncology', 'pediatric', 'clinical', 'health'],
        expected_excludes: [],
      },
      {
        question: 'Help me draft an out-of-office message.',
        expected_keywords: ['patient', 'clinic', 'hospital', 'colleague', 'pediatric', 'oncology'],
        expected_excludes: [],
      },
    ],
    adjacentRelevant: [
      {
        question: 'Suggest a charity to donate to this year.',
        expected_keywords: ['pediatric', 'children', 'oncology', 'cancer', 'hospital', 'health'],
        expected_excludes: [],
      },
      {
        question: 'Plan an overnight bag for travel.',
        expected_keywords: ['pager', 'badge', 'on-call', 'hospital', 'comfortable shoes', 'scrubs'],
        expected_excludes: [],
      },
      {
        question: 'What book should I read on vacation?',
        expected_keywords: ['memoir', 'medicine', 'doctor', 'fiction', 'history', 'science'],
        expected_excludes: [],
      },
      {
        question: 'Pick a hobby I might enjoy.',
        expected_keywords: ['low-stress', 'gardening', 'painting', 'walking', 'reading', 'meditation'],
        expected_excludes: [],
      },
    ],
    unrelatedControl: [
      { question: "What's the largest desert in the world?", expected_keywords: [], expected_excludes: [] },
      { question: 'How do tides work?', expected_keywords: [], expected_excludes: [] },
      { question: 'Who composed the Four Seasons?', expected_keywords: [], expected_excludes: [] },
      { question: 'What language is spoken in Mongolia?', expected_keywords: [], expected_excludes: [] },
    ],
  },
  kosher: {
    constraintFacts: [
      'I keep kosher and only eat foods prepared according to kosher law.',
      'I observe Shabbat from Friday sundown to Saturday sundown.',
      'I do not mix meat and dairy in any meal.',
    ],
    personaKeywords: ['kosher', 'Shabbat', 'kashrut'],
    directRelevant: [
      {
        question: 'What restaurant should I pick for dinner?',
        expected_keywords: ['kosher', 'certified', 'check certification'],
        expected_excludes: ['shellfish', 'pork', 'cheeseburger'],
      },
      {
        question: 'Plan a Friday evening.',
        expected_keywords: ['Shabbat', 'home', 'family', 'before sundown', 'candles'],
        expected_excludes: ['concert Friday night', 'late dinner Friday'],
      },
      {
        question: 'Suggest a pizza topping combo for tonight.',
        expected_keywords: ['vegetable', 'cheese', 'kosher', 'pareve'],
        expected_excludes: ['pepperoni', 'sausage', 'pork', 'shrimp'],
      },
      {
        question: 'What dish should I make for a holiday meal?',
        expected_keywords: ['kosher', 'brisket', 'challah', 'matzo', 'roast', 'vegetable'],
        expected_excludes: ['cheeseburger', 'pork', 'shellfish'],
      },
    ],
    adjacentRelevant: [
      {
        question: 'Pick a vacation rental for next month.',
        expected_keywords: ['kosher kitchen', 'kosher market nearby', 'synagogue nearby', 'check kosher'],
        expected_excludes: [],
      },
      {
        question: 'Recommend an airline for my next trip.',
        expected_keywords: ['kosher meal', 'pre-order', 'special meal'],
        expected_excludes: [],
      },
      {
        question: 'Plan a date night out.',
        expected_keywords: ['kosher', 'restaurant', 'options', 'before Shabbat'],
        expected_excludes: ['cheeseburger', 'shellfish'],
      },
      {
        question: 'What gift should I bring my hosts?',
        expected_keywords: ['kosher', 'wine', 'flowers', 'certified'],
        expected_excludes: [],
      },
    ],
    unrelatedControl: [
      { question: 'How tall is Mount Everest?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the largest planet in our solar system?", expected_keywords: [], expected_excludes: [] },
      { question: 'Who invented the telephone?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the currency of Japan?", expected_keywords: [], expected_excludes: [] },
    ],
  },
  type1_diabetic: {
    constraintFacts: [
      'I have type 1 diabetes and use a continuous glucose monitor.',
      'I count carbohydrates carefully at every meal and dose insulin accordingly.',
      'I always carry fast-acting glucose tablets in case of low blood sugar.',
    ],
    personaKeywords: ['diabetes', 'insulin', 'glucose', 'blood sugar', 'carb'],
    directRelevant: [
      {
        question: 'What should I have for breakfast?',
        expected_keywords: ['low-carb', 'protein', 'eggs', 'yogurt', 'measured carbs', 'insulin'],
        expected_excludes: ['sugary cereal', 'pastry', 'pancakes with syrup'],
      },
      {
        question: 'Recommend a dessert.',
        expected_keywords: ['small portion', 'measured carbs', 'sugar-free', 'fruit', 'insulin dose'],
        expected_excludes: ['large slice of cake', 'unlimited sweets'],
      },
      {
        question: 'Plan a hike for this Saturday.',
        expected_keywords: ['glucose tablets', 'snack', 'CGM', 'monitor', 'check sugar'],
        expected_excludes: [],
      },
      {
        question: 'What should I order at the coffee shop?',
        expected_keywords: ['unsweetened', 'sugar-free', 'low-carb', 'measure carbs'],
        expected_excludes: ['frappuccino with whip', 'large pastry'],
      },
    ],
    adjacentRelevant: [
      {
        question: 'Pack for a weekend trip.',
        expected_keywords: ['insulin', 'CGM', 'glucose', 'snacks', 'medical supplies'],
        expected_excludes: [],
      },
      {
        question: 'Suggest a date-night activity.',
        expected_keywords: ['dinner', 'movie', 'walk', 'museum', 'check carbs'],
        expected_excludes: [],
      },
      {
        question: 'Help me plan a long flight.',
        expected_keywords: ['insulin', 'snacks', 'glucose tablets', 'doctor letter', 'medical'],
        expected_excludes: [],
      },
      {
        question: 'What should I keep in my desk drawer at work?',
        expected_keywords: ['glucose tablets', 'snacks', 'insulin', 'CGM'],
        expected_excludes: [],
      },
    ],
    unrelatedControl: [
      { question: "What's the smallest country in Europe?", expected_keywords: [], expected_excludes: [] },
      { question: 'How do rainbows form?', expected_keywords: [], expected_excludes: [] },
      { question: 'Who discovered penicillin?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the freezing point of mercury?", expected_keywords: [], expected_excludes: [] },
    ],
  },
  planner: {
    constraintFacts: [
      'I dislike surprises and prefer extensive planning before any decision.',
      'I keep detailed checklists for trips, projects, and even social outings.',
      'I always want to know the agenda in advance.',
    ],
    personaKeywords: ['planning', 'checklist', 'agenda', 'plan ahead', 'detail'],
    directRelevant: [
      {
        question: 'Recommend a way to celebrate my birthday.',
        expected_keywords: ['planned', 'agenda', 'reservation', 'itinerary', 'in advance'],
        expected_excludes: ['surprise party', 'spontaneous'],
      },
      {
        question: 'Suggest a vacation style for me.',
        expected_keywords: [
          'itinerary',
          'planned',
          'agenda',
          'reservations',
          'schedule',
          'preparation',
          'organized',
          'plan',
          'detailed',
          'cabin',
        ],
        expected_excludes: ['spontaneous', 'unplanned road trip'],
      },
      {
        question: 'How should I approach this work project?',
        expected_keywords: ['plan', 'checklist', 'phases', 'schedule', 'agenda', 'milestones'],
        expected_excludes: [],
      },
      {
        question: 'Help me prepare for a difficult conversation.',
        expected_keywords: ['outline', 'plan', 'notes', 'agenda', 'rehearse'],
        expected_excludes: [],
      },
    ],
    adjacentRelevant: [
      {
        question: 'What gift should I buy my partner?',
        expected_keywords: ['list', 'wishlist', 'planned', 'preferences'],
        expected_excludes: ['random surprise gift'],
      },
      {
        question: 'Suggest a hobby I might pick up.',
        expected_keywords: ['structured', 'plan', 'class', 'curriculum', 'milestones'],
        expected_excludes: [],
      },
      {
        question: 'What should I do with a free Saturday?',
        expected_keywords: ['plan', 'list', 'errands', 'projects', 'schedule'],
        expected_excludes: [],
      },
      {
        question: 'Recommend a productivity tool.',
        expected_keywords: ['checklist', 'planner', 'calendar', 'agenda', 'task'],
        expected_excludes: [],
      },
    ],
    unrelatedControl: [
      { question: 'How many bones are in the human body?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the longest river in South America?", expected_keywords: [], expected_excludes: [] },
      { question: 'Who wrote Hamlet?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the chemical formula for table salt?", expected_keywords: [], expected_excludes: [] },
    ],
  },
  single_parent_autism: {
    constraintFacts: [
      'I am a single parent of a six-year-old who has autism.',
      "Daily routines and predictability are critical to my child's wellbeing.",
      "I plan around my child's school schedule and therapy appointments.",
    ],
    personaKeywords: ['autism', 'single parent', 'child', 'routine', 'therapy'],
    directRelevant: [
      {
        question: 'Plan a weekend trip for my family.',
        expected_keywords: ['routine', 'predictable', 'quiet', 'child-friendly', 'short drive'],
        expected_excludes: ['loud nightclub', 'crowded music festival'],
      },
      {
        question: 'Suggest a restaurant for dinner with my kid.',
        expected_keywords: ['kid-friendly', 'quiet', 'familiar', 'routine', 'sensory-friendly'],
        expected_excludes: ['loud bar', 'fancy adults-only'],
      },
      {
        question: 'Recommend a vacation activity.',
        expected_keywords: ['quiet', 'routine', 'predictable', 'sensory-friendly', 'child-friendly'],
        expected_excludes: ['loud concert', 'crowded'],
      },
      {
        question: 'Help me schedule my workweek.',
        expected_keywords: ['school', 'therapy', 'pickup', 'routine', 'predictable'],
        expected_excludes: [],
      },
    ],
    adjacentRelevant: [
      {
        question: 'What gift should I get my child for the holidays?',
        expected_keywords: ['sensory', 'quiet', 'routine', 'familiar', 'low-stimulation'],
        expected_excludes: ['loud toy', 'overstimulating'],
      },
      {
        question: 'Suggest a self-care activity for me.',
        expected_keywords: ['quiet', 'short', 'home', 'when child is asleep', 'when child is at school'],
        expected_excludes: ['weekend retreat away'],
      },
      {
        question: 'Pick a TV show for our evening.',
        expected_keywords: ['kid-friendly', 'familiar', 'gentle', 'calm'],
        expected_excludes: ['scary movie', 'horror'],
      },
      {
        question: 'Plan a birthday party for my child.',
        expected_keywords: ['small', 'quiet', 'familiar', 'sensory-friendly', 'predictable', 'routine'],
        expected_excludes: ['big loud party', 'crowded venue'],
      },
    ],
    unrelatedControl: [
      { question: "What's the deepest ocean?", expected_keywords: [], expected_excludes: [] },
      { question: 'Who painted The Starry Night?', expected_keywords: [], expected_excludes: [] },
      { question: 'How many continents are there?', expected_keywords: [], expected_excludes: [] },
      { question: "What's the highest-grossing film of all time?", expected_keywords: [], expected_excludes: [] },
    ],
  },
};

// --- Fixture types ---

export type SkinPersonaQuestionType = 'direct-relevant' | 'adjacent-relevant' | 'unrelated-control';

export interface SkinPersonaQuestion {
  qid: string;
  type: SkinPersonaQuestionType;
  question: string;
  expected_keywords: string[];
  expected_excludes: string[];
  /** Persona keywords (lowercased substrings), for unrelated controls these must NOT appear. */
  persona_keywords: string[];
}

export interface SkinPersonaTrace {
  trace_id: string;
  persona: PersonaName;
  facts: string[];
  questions: SkinPersonaQuestion[];
}

export interface SkinPersonaFixture {
  version: string;
  seed: number;
  mode: 'mini' | 'full';
  traces: SkinPersonaTrace[];
}

// --- Generation ---

export function generate(seed: number, mode: 'mini' | 'full'): SkinPersonaFixture {
  const rand = mulberry32(seed);
  const personas = mode === 'mini' ? MINI_PERSONAS : ALL_PERSONAS;
  const tracesPerPersona = mode === 'mini' ? 1 : 3;
  const questionsPerCategory = mode === 'mini' ? 2 : 4; // mini = 2 each = 6 per trace; full = 4 each = 12 per trace

  const traces: SkinPersonaTrace[] = [];
  let traceCounter = 0;

  for (const personaName of personas) {
    const spec = PERSONAS[personaName];
    for (let t = 0; t < tracesPerPersona; t++) {
      traceCounter++;
      const traceId = `persona_${String(traceCounter).padStart(3, '0')}`;

      // Build facts: all constraint facts + a sample of neutral facts.
      const factCount = 8;
      const sampledNeutral: string[] = [];
      const used = new Set<number>();
      let safety = factCount * 5;
      while (sampledNeutral.length < factCount && safety-- > 0) {
        const idx = Math.floor(rand() * NEUTRAL_FACTS.length);
        if (used.has(idx)) continue;
        used.add(idx);
        sampledNeutral.push(NEUTRAL_FACTS[idx]!);
      }
      const facts = [...spec.constraintFacts, ...sampledNeutral];

      const questions: SkinPersonaQuestion[] = [];
      let qCounter = 0;
      function add(category: SkinPersonaQuestionType, source: PersonaQuestion[], n: number): void {
        const taken = source.slice(0, n);
        for (const q of taken) {
          qCounter++;
          questions.push({
            qid: `${traceId}_q${String(qCounter).padStart(2, '0')}`,
            type: category,
            question: q.question,
            expected_keywords: q.expected_keywords,
            expected_excludes: q.expected_excludes,
            persona_keywords: spec.personaKeywords,
          });
        }
      }
      add('direct-relevant', spec.directRelevant, questionsPerCategory);
      add('adjacent-relevant', spec.adjacentRelevant, questionsPerCategory);
      add('unrelated-control', spec.unrelatedControl, questionsPerCategory);

      traces.push({ trace_id: traceId, persona: personaName, facts, questions });
    }
  }

  return { version: '1.0', seed, mode, traces };
}
