/**
 * Intermediate Representation (IR) builder.
 *
 * Normalizes injected memories into structured NormalizedFacts.
 * Built once per query, consumed by all specialists.
 *
 * S25 Council R16: GPT proposed, CI endorsed as foundation.
 * S27 Council R17: Stage 1 fixes applied (negation, certainty, predicates, subject strip).
 *
 * Design:
 *   - Deterministic extraction (regex + pattern matching)
 *   - Uses existing memory fields (subject, createdAt) where available
 *   - Extracts predicate/object/negation/certainty from claim text
 *   - O(n) in number of memories, no pairwise operations
 *   - Target: <20ms for 50 memories on ARM
 */

import type { CompiledMemory } from '../schema/memory.js';
import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, FactCertainty, RequiredOperations } from './types.js';

// ---------------------------------------------------------------------------
// Entity Extraction Stopwords (S27 Council R17: 4/4 unanimous)
// ---------------------------------------------------------------------------

/**
 * Words that match /\b[A-Z][a-z]{2,}\b/ but are NOT entity names.
 * Used across ALL specialists for query subject extraction.
 * Exported so specialists use one shared list.
 */
export const ENTITY_STOPWORDS = new Set([
  // Question words (sentence-initial capitalization)
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'how', 'why',
  'does', 'did', 'has', 'have', 'had', 'was', 'were', 'are', 'can', 'could',
  'would', 'should', 'will', 'may', 'might', 'the', 'this', 'that', 'these',
  'those', 'some', 'any', 'each', 'every', 'both', 'all', 'many', 'much',
  // Days of week
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Months
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  // Common non-entity capitalized words
  'hello', 'hey', 'yes', 'not', 'also', 'very', 'just', 'then', 'than',
  'christmas', 'easter', 'thanksgiving', 'halloween',
  'new', 'old', 'big', 'small', 'great', 'good', 'best', 'most',
]);

/**
 * Extract entity names from text, filtering stopwords.
 * Use this instead of raw /\b[A-Z][a-z]{2,}\b/ everywhere.
 */
export function extractEntities(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]{2,}\b/g);
  if (!matches) return [];
  return [...new Set(matches.filter(m => !ENTITY_STOPWORDS.has(m.toLowerCase())))];
}

// ---------------------------------------------------------------------------
// Negation Detection (S27: whitelist approach, council R17 fix #2)
// ---------------------------------------------------------------------------

/**
 * Explicit negation phrases. No bare \bnot\b.
 * Council R17: "Nottingham", "notable", "nothing" matched bare \bnot\b.
 * Fix: whitelist of 30+ explicit negation phrases only.
 */
const NEGATION_PHRASES: RegExp[] = [
  // Contracted forms
  /\b(can't|don't|doesn't|didn't|hasn't|haven't|hadn't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|couldn't|mustn't|ain't)\b/i,
  // Explicit "not" + verb/adjective (requires following word)
  /\b(does not|do not|did not|has not|have not|had not|is not|are not|was not|were not|will not|would not|cannot|could not|should not|must not)\b/i,
  // Negation adverbs/phrases
  /\b(never|no longer|not anymore|stopped doing|quit|ceased|refused to|denied|lacks|without any)\b/i,
  // "nope" standalone
  /\bnope\b/i,
];

export function detectNegation(text: string): boolean {
  return NEGATION_PHRASES.some(p => p.test(text));
}

// ---------------------------------------------------------------------------
// Certainty Classification (S27: preference fix, council R17 fix #3)
// ---------------------------------------------------------------------------

/**
 * Preference patterns that look hypothetical but are actually asserted.
 * "would like", "would love", "would prefer" = stated preference, not hypothetical.
 * Must be checked BEFORE hypothetical patterns.
 */
const PREFERENCE_PATTERNS = /\b(would like|would love|would prefer|would enjoy|would rather)\b/i;

const PLANNED_PATTERNS = /\b(plans? to|planning to|wants? to|hoping to|intends? to|going to|will|considering|thinking about|looking into)\b/i;
const HYPOTHETICAL_PATTERNS = /\b(might|could|may|possibly|perhaps|would|potentially|theoretically)\b/i;
const CONDITIONAL_PATTERNS = /\b(if|unless|when.*then|provided that|as long as|in case)\b/i;
const SUPERSEDED_MARKERS = /\b(previously|formerly|used to|no longer|was replaced|updated|changed from|moved from)\b/i;

/**
 * Meta-question patterns that shouldn't trigger certainty classification.
 * "Could you tell me" is the user asking, not a hypothetical fact.
 */
const META_QUESTION_PATTERNS = /^(?:could you|can you|would you|will you|do you)\b/i;

export function classifyCertainty(text: string, negated: boolean): FactCertainty {
  // Superseded: negated + temporal markers
  if (negated && SUPERSEDED_MARKERS.test(text)) return 'superseded';
  if (negated) return 'negated';

  // Skip meta-question patterns (not actual fact certainty)
  if (META_QUESTION_PATTERNS.test(text)) return 'asserted';

  // Preferences look hypothetical but are asserted (S27 R17 fix)
  if (PREFERENCE_PATTERNS.test(text)) return 'asserted';

  if (CONDITIONAL_PATTERNS.test(text)) return 'conditional';
  if (HYPOTHETICAL_PATTERNS.test(text)) return 'hypothetical';
  if (PLANNED_PATTERNS.test(text)) return 'planned';
  return 'asserted';
}

// ---------------------------------------------------------------------------
// Date Extraction
// ---------------------------------------------------------------------------

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?)\b/;

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function extractDate(text: string): string | null {
  const iso = text.match(ISO_DATE);
  if (iso) return iso[1]!;

  const written = text.match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,?\s+(\d{4}))?\b|\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (written) {
    if (written[4]) {
      const month = MONTH_MAP[written[4]!.toLowerCase()];
      const day = written[5]!.padStart(2, '0');
      const year = written[6]!;
      if (month) return `${year}-${month}-${day}`;
    } else if (written[1]) {
      const day = written[1]!.padStart(2, '0');
      const month = MONTH_MAP[written[2]!.toLowerCase()];
      const year = written[3] || new Date().getFullYear().toString();
      if (month) return `${year}-${month}-${day}`;
    }
  }

  const my = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i
  );
  if (my) {
    const month = MONTH_MAP[my[1]!.toLowerCase()];
    if (month) return `${my[2]}-${month}-01`;
  }

  return null;
}

export function extractAllDates(text: string): string[] {
  const dates: string[] = [];

  const isoMatches = text.matchAll(/\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?)\b/g);
  for (const m of isoMatches) dates.push(m[1]!);

  const writtenMatches = text.matchAll(
    /\b(?:(\d{1,2})\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{1,2}))?(?:,?\s+(\d{4}))\b/gi
  );
  for (const m of writtenMatches) {
    const monthStr = m[2]!.toLowerCase();
    const month = MONTH_MAP[monthStr];
    if (!month) continue;
    const day = (m[1] || m[3] || '01').padStart(2, '0');
    const year = m[4]!;
    const d = `${year}-${month}-${day}`;
    if (!dates.includes(d)) dates.push(d);
  }

  return dates;
}

// ---------------------------------------------------------------------------
// Predicate / Object Extraction
// (S27: relationship moved above acquired, "got married" fix #4)
// (S27: added "got" disambiguation for common phrases)
// ---------------------------------------------------------------------------

interface PredicateObject {
  predicate: string;
  object: string;
}

const CLAIM_PATTERNS: Array<{ pattern: RegExp; extract: (m: RegExpMatchArray) => PredicateObject }> = [
  // "X lives in Y", "X moved to Y"
  {
    pattern: /(?:lives?|living|resides?|residing|moved?|relocated?|located)\s+(?:in|to|at)\s+(.+)/i,
    extract: (m) => ({ predicate: 'location', object: m[1]!.trim() }),
  },
  // "X works at/for Y"
  {
    pattern: /(?:works?|working|employed)\s+(?:at|for|with)\s+(.+)/i,
    extract: (m) => ({ predicate: 'employer', object: m[1]!.trim() }),
  },
  // "X's favorite Y is Z"
  {
    pattern: /(?:favorite|favourite|preferred)\s+(\w+)\s+(?:is|was|are|were)\s+(.+)/i,
    extract: (m) => ({ predicate: `favorite_${m[1]!.toLowerCase()}`, object: m[2]!.trim() }),
  },
  // "X has N Y" (count)
  {
    pattern: /\bhas\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(.+)/i,
    extract: (m) => ({ predicate: 'has_count', object: `${m[1]} ${m[2]}`.trim() }),
  },
  // S27 fix #4: "got married/engaged/divorced" BEFORE acquired
  {
    pattern: /\b(?:got|getting)\s+(married|engaged|divorced|separated)\b(?:\s+(?:to|from)\s+(.+))?/i,
    extract: (m) => ({ predicate: 'relationship', object: m[2] ? `${m[1]} ${m[2]}`.trim() : m[1]!.trim() }),
  },
  // "X married/engaged to Y" (general relationship)
  {
    pattern: /(?:married|engaged|dating|relationship with|partner is|spouse is|wife is|husband is)\s+(.+)/i,
    extract: (m) => ({ predicate: 'relationship', object: m[1]!.trim() }),
  },
  // "X owns/purchased Y"
  {
    pattern: /\b(?:owns?|purchased?|bought)\s+(.+)/i,
    extract: (m) => ({ predicate: 'owns', object: m[1]!.trim() }),
  },
  // "X adopted/got Y" (S27: moved after relationship to prevent "got married" collision)
  {
    pattern: /(?:adopted|got|received|obtained)\s+(.+)/i,
    extract: (m) => ({ predicate: 'acquired', object: m[1]!.trim() }),
  },
  // "X visited/went to Y"
  {
    pattern: /(?:visited|went to|traveled to|travelled to|trip to|been to)\s+(.+)/i,
    extract: (m) => ({ predicate: 'visited', object: m[1]!.trim() }),
  },
  // "X is a/an Y" (role)
  {
    pattern: /\bis\s+(?:a|an)\s+(.+)/i,
    extract: (m) => ({ predicate: 'role', object: m[1]!.trim() }),
  },
  // "X enjoys/likes Y"
  {
    pattern: /(?:enjoys?|likes?|loves?|passionate about|interested in)\s+(.+)/i,
    extract: (m) => ({ predicate: 'interest', object: m[1]!.trim() }),
  },
  // "X graduated from Y"
  {
    pattern: /(?:graduated|degree|diploma)\s+(?:from|at|in)\s+(.+)/i,
    extract: (m) => ({ predicate: 'education', object: m[1]!.trim() }),
  },
];

/**
 * S27 fix #5: expanded subject strip lookahead.
 * Original only handled "a"/"an". Now handles determiners and adverbs.
 * "Bob is the CEO" -> keeps "is the CEO" (role pattern matches "is a/an" not "is the")
 * "Bob is very smart" -> keeps "is very smart" 
 */
export function extractPredicateObject(claim: string, subject: string): PredicateObject {
  let text = claim;
  if (subject && claim.toLowerCase().startsWith(subject.toLowerCase())) {
    text = claim.slice(subject.length).trim();
    // Strip leading copula ONLY if NOT followed by determiner/adverb/negation
    // Preserves: "is a doctor", "is the CEO", "is very tall", "is not happy", "is also known"
    text = text.replace(/^(?:is|was|are|were|has|had|have)\s+(?!a\b|an\b|the\b|very\b|also\b|not\b|still\b|now\b|quite\b|really\b|so\b|too\b)/i, '');
  }

  for (const { pattern, extract } of CLAIM_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const result = extract(match);
      if (result.object.length > 200) result.object = result.object.substring(0, 200);
      return result;
    }
  }

  const fallbackObj = text.length > 200 ? text.substring(0, 200) : text;
  return { predicate: 'states', object: fallbackObj || claim.substring(0, 200) };
}

// ---------------------------------------------------------------------------
// Operation Inference (S27: added update/status patterns, council R17 fix #3)
// ---------------------------------------------------------------------------

export function inferOperations(query: string, queryType: QueryType): RequiredOperations {
  const q = query.toLowerCase();

  return {
    extractFact:
      queryType === 'single-hop' ||
      queryType === 'open-domain' ||
      queryType === 'current-state',

    resolveTime:
      queryType === 'temporal' ||
      /\b(when|before|after|first|last|order|sequence|timeline|date|month|year|ago|between|since|until|how long|how many (?:days|weeks|months|years))\b/.test(q),

    aggregateCount:
      /\b(how many|how much|count|total|number of|amount|how long|how often)\b/.test(q),

    enumerateSet:
      /\b(what (?:are|were) (?:all |the )?(?:different|various)?|list|name all|which (?:ones|types|kinds))\b/.test(q) ||
      /\b(what|which)\b.{1,30}\b(hobbies|activities|interests|pets|friends|things|types|places|countries|books|sports|gifts|events)\b/.test(q),

    resolveLatestState:
      queryType === 'current-state' ||
      /\b(current|now|still|latest|most recent|presently|today|anymore|changed|status|update|any new|any recent|vs (?:last|before|prior))\b/.test(q),

    synthesizeSummary:
      queryType === 'synthesis' ||
      queryType === 'summarization' ||
      queryType === 'narrative' ||
      /\b(summarize|overview|tell me about|describe|explain)\b/.test(q),
  };
}

// ---------------------------------------------------------------------------
// IR Builder
// ---------------------------------------------------------------------------

export function buildIR(
  memories: CompiledMemory[],
  query: string,
  queryType: QueryType,
): { facts: NormalizedFact[]; operations: RequiredOperations } {
  const operations = inferOperations(query, queryType);

  const facts: NormalizedFact[] = memories.map((mem) => {
    const negated = detectNegation(mem.claim);
    const certainty = classifyCertainty(mem.claim, negated);
    const { predicate, object } = extractPredicateObject(mem.claim, mem.subject);

    // S27 fix #6 partial: prefer extracted date from claim, then validFrom if available,
    // then createdAt as ASSERTION TIME (not event time). Council R17: never treat
    // createdAt as event time. It's when the memory was stored, not when the event happened.
    const extractedDate = extractDate(mem.claim);
    const validFrom = (mem as any).validFrom as string | undefined;
    const time = extractedDate || validFrom?.substring(0, 10) || null;
    // Note: createdAt intentionally NOT used as fallback for event time.
    // Undated facts get time=null. Specialists handle null time explicitly.

    return {
      memoryId: mem.id,
      subject: mem.subject,
      predicate,
      object,
      time,
      timeEnd: null,
      negated,
      certainty,
      score: mem.score,
      sourceText: mem.claim,
    };
  });

  return { facts, operations };
}
