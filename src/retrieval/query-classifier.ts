import { recordDecision } from '../telemetry/index.js';

export type QueryType =
  | 'temporal'
  | 'multi-hop'
  | 'temporal-multi-hop'
  | 'single-hop'
  | 'open-domain'
  | 'narrative'
  | 'synthesis'
  | 'summarization'
  | 'current-state'
  | 'coverage';

/**
 * Injection mode: which memory types to inject for each query type.
 * Double-gate: query type determines eligibility, cosine threshold confirms.
 */
export interface InjectionMode {
  facts: boolean;
  episodes: boolean;
  statePack: boolean;
  summaries: boolean;
  timeline: boolean;
  bridgeRetrieval: boolean;
  subjectBruteForce: boolean;
  /** If true, summaries REPLACE facts for matched subjects */
  summariesReplaceFacts: boolean;
}

const INJECTION_MODES: Record<QueryType, InjectionMode> = {
  'single-hop': {
    facts: true,
    episodes: false,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  narrative: {
    facts: true,
    episodes: true,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  temporal: {
    facts: true,
    episodes: true,
    statePack: false,
    summaries: false,
    timeline: true,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  synthesis: {
    facts: false,
    episodes: true,
    statePack: false,
    summaries: true,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: true,
  },
  summarization: {
    facts: true,
    episodes: false,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  'current-state': {
    facts: true,
    episodes: false,
    statePack: true,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  coverage: {
    facts: true,
    episodes: false,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: true,
    summariesReplaceFacts: false,
  },
  'multi-hop': {
    facts: true,
    episodes: false,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: true,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  'temporal-multi-hop': {
    facts: true,
    episodes: true,
    statePack: false,
    summaries: false,
    timeline: true,
    bridgeRetrieval: true,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
  'open-domain': {
    facts: true,
    episodes: false,
    statePack: false,
    summaries: false,
    timeline: false,
    bridgeRetrieval: false,
    subjectBruteForce: false,
    summariesReplaceFacts: false,
  },
};

/**
 * Get injection mode for a query type.
 * Determines which memory types are eligible for injection.
 * Cosine threshold is the secondary gate applied per-item.
 */
export function getInjectionMode(queryType: QueryType): InjectionMode {
  return INJECTION_MODES[queryType];
}

/**
 * Heuristic query classifier. No LLM calls.
 * Used for dynamic retrieval depth + per-category prompts + injection routing.
 *
 * V3: Remapped summarization → synthesis, event-ordering → temporal.
 * Added narrative, current-state, coverage types.
 */
export function classifyQuery(query: string): QueryType {
  const result = classifyQueryInner(query);
  recordDecision({
    decision_type: 'query_classify',
    branch_taken: result,
  });
  return result;
}

/**
 * S79 #12: detect a count/aggregation question and extract the category term
 * being counted. Returns the term (e.g. "weddings", "model kits") for queries
 * like "how many weddings have I attended", else null. Used to trigger an FTS
 * category-coverage retrieval channel so counts see all of a category's
 * instances, not just the vector top-K. Heuristic: validate and tune against
 * the real LME multi-session count questions (see VALIDATE).
 */
export function detectCountCategory(query: string): string | null {
  const q = query.trim();
  // Comparisons / rates / ages are not category counts; the coverage channel
  // does not help them and the extracted term would be junk. Suppress.
  if (
    /\bhow (?:much|many) (?:more|less|fewer|faster|slower|earlier|later|longer|older|younger|higher|lower)\b/i.test(q)
  )
    return null;
  if (/\bhow many years\b/i.test(q)) return null;

  const m =
    q.match(
      /\b(?:how many|(?:total )?number of)\s+(.+?)(?:\s+(?:have|has|had|did|do|does|are|is|was|were|will|in|this|last|over|across|that|i|my|to|when|by|per|each)\b|\?|$)/i,
    ) ||
    q.match(/\bcount of\s+(.+?)(?:\?|$)/i) ||
    q.match(/\bhow much\b.*?\b(?:on|for|towards?|into|from)\s+(.+?)(?:\?|$)/i) ||
    q.match(/\btotal (?:cost|amount|price|distance|time|weight|value|spending) (?:of|on|for)\s+(.+?)(?:\?|$)/i);
  if (!m) return null;
  const term = m[1]!
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|my)\s+/i, '');
  if (/^(?:years?|times?|days?|weeks?|months?|hours?|minutes?|miles?|points?)$/i.test(term)) return null;
  return term.length >= 2 ? term : null;
}

function classifyQueryInner(query: string): QueryType {
  const q = query.toLowerCase();

  // Coverage: broad listing/activity questions (4f: broadened).
  if (
    /\b(what activities|list all|what are all|everything .* done|all the (things|hobbies|activities|jobs)|every \w+ (he|she|they))\b/.test(
      q,
    )
  ) {
    return 'coverage';
  }

  // Current-state: present status questions
  // S4: Don't claim current-state if temporal keywords are also present
  // S4: Current-state yields to temporal when both match
  // S46: hasTemporalKeywords gates current-state. Adding historical-intent
  // markers (before, used to, list...over time, has changed, etc) so a query
  // like "What was the status of X before?" doesn't trip current-state via
  // the 'status' keyword. The historical-intent markers must mirror the ones
  // added to the temporal regex below.
  //
  // S63: removed `throughout` from this cluster. `throughout` is a span /
  // coverage marker ("throughout the day", "throughout our conversations",
  // "throughout my career") not a time-anchor marker. Treating it as a
  // temporal anchor mis-routes span-shaped queries to the temporal answer
  // route, whose suffix forces date-leading output. Span queries are better
  // served by synthesis/narrative/single-hop routes. The explicit time-anchor
  // markers (`when`, month names, years, `last/next/ago`, `before`, `past`,
  // `prior`, `used to`, etc.) still trigger temporal correctly.
  const hasTemporalKeywords =
    /\bwhen\b/.test(q) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q) ||
    /\b\d{4}\b/.test(q) ||
    /\b(last|next|recent|ago|summer|winter|spring|fall)\b/.test(q) ||
    /\b(before|previously|formerly|used to|past|earlier|prior|history|over time)\b/.test(q) ||
    /\b(has|have|did|hasn't|haven't)\b.*\b(changed?|moved?|switched?|relocated)\b/.test(q) ||
    /\bjobs?\s+over\b/.test(q) ||
    /\blist\b.*\b(over|past|history)\b/.test(q);
  // Open-domain: hypothetical / opinion markers (4b: broadened + moved ABOVE
  // current-state to de-starve it). Post-collapse this controls retrieval mode
  // (facts-only), not the answer model, so the placement is retrieval-only.
  if (
    /\b(would|might|likely|probably|do you (think|reckon)|predict|imagine|suppose|hypothetical(ly)?|opinion|in your (view|opinion)|believe|guess|expect)\b/.test(
      q,
    )
  ) {
    return 'open-domain';
  }

  // Current-state: fire ONLY on a currentness marker AND not temporal (4a).
  // The old present-tense pattern (caret-(what/who/which/where)...(is/are/does/
  // do)) caught almost any present-tense question and is removed. Stable-identity
  // attributes are NOT current-state: current-state triggers as-of age
  // annotation the answer prompt uses to refuse stale facts, which is wrong for
  // a stable attribute. The `status` keyword is dropped (it over-fired on
  // historical "status of X before?" questions).
  const isStableIdentityQuestion =
    /\b(identity|gender|ethnicity|nationality|birthplace|birthday|orientation|sexuality|religion|race)\b/.test(q);
  const hasCurrentnessMarker =
    /\b(current(ly)?|right now|now|today|still|at the moment|these days|at present|nowadays|as of (now|today))\b/.test(
      q,
    );
  if (hasCurrentnessMarker && !hasTemporalKeywords && !isStableIdentityQuestion) {
    return 'current-state';
  }

  // Synthesis: summarization / overview / evolution questions (4d: removed the
  // order/sequence cues, which overlapped temporal and pulled date-shaped
  // questions onto the facts-replacing synthesis route).
  if (
    /\b(summarize|summary|overview|recap|evolved|progression|journey|over time|developed over|walk\b.*\bthrough)\b/.test(
      q,
    )
  ) {
    return 'synthesis';
  }

  // Narrative: storytelling / descriptive questions (4g: tightened `describe`,
  // which was too broad as a bare word).
  if (/\b(describe what|describe how|tell me about|what happened|story of|how did .* go|what was .* like)\b/.test(q)) {
    return 'narrative';
  }

  // BULLSEYE: Proper noun extraction BEFORE temporal check.
  // Multi-hop queries with temporal words ("last", "recent", years) must route to multi-hop,
  // not temporal. Multi-hop gets 100 candidates + entity-split. Temporal gets 45 candidates.
  // Count proper nouns (capitalized words not at start)
  // Q4a: Filter common English words that appear capitalized but aren't proper nouns
  const COMMON_NON_PROPER = new Set([
    'about',
    'after',
    'also',
    'back',
    'been',
    'being',
    'both',
    'came',
    'come',
    'could',
    'each',
    'even',
    'every',
    'find',
    'first',
    'from',
    'gave',
    'give',
    'good',
    'great',
    'just',
    'keep',
    'kind',
    'know',
    'last',
    'like',
    'little',
    'live',
    'long',
    'look',
    'made',
    'make',
    'many',
    'might',
    'more',
    'most',
    'much',
    'must',
    'never',
    'new',
    'next',
    'now',
    'old',
    'only',
    'other',
    'over',
    'own',
    'part',
    'said',
    'same',
    'show',
    'since',
    'some',
    'still',
    'such',
    'sure',
    'take',
    'tell',
    'than',
    'that',
    'their',
    'them',
    'then',
    'there',
    'these',
    'they',
    'think',
    'this',
    'those',
    'through',
    'time',
    'too',
    'under',
    'upon',
    'very',
    'want',
    'way',
    'well',
    'went',
    'were',
    'will',
    'with',
    'work',
    'would',
    'year',
    'your',
    'best',
    'help',
    'need',
    'feel',
    'real',
    'try',
    'put',
    'run',
    'set',
    'turn',
    'move',
    'play',
    'point',
    'fact',
    'place',
    'right',
    'left',
    'high',
    'low',
    'end',
    'if',
    'im',
    'its',
    'ive',
    'ill',
    'weve',
    'youve',
    'theyre',
    'dont',
    'didnt',
    'doesnt',
    'cant',
    'wont',
    'shouldnt',
    'wouldnt',
    'couldnt',
    'isnt',
    'arent',
    'wasnt',
    'werent',
    'hasnt',
    'havent',
    'hadnt',
  ]);
  const words = query.split(/\s+/);
  const properNouns = new Set<string>();
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!.replace(/[^a-zA-Z]/g, '');
    if (w.length > 1 && w[0] === w[0]!.toUpperCase() && w[0] !== w[0]!.toLowerCase()) {
      if (!COMMON_NON_PROPER.has(w.toLowerCase())) {
        properNouns.add(w);
      }
    }
  }
  // First word if capitalized and not a question/common word
  const SENTENCE_STARTERS =
    /^(what|when|where|who|why|how|did|does|do|is|are|was|were|has|have|had|which|can|could|would|should|tell|describe|explain|list|show|give|name|find|compare|discuss)$/i;
  if (words[0]) {
    const first = words[0].replace(/[^a-zA-Z]/g, '');
    if (first.length > 1 && !SENTENCE_STARTERS.test(first) && !COMMON_NON_PROPER.has(first.toLowerCase())) {
      properNouns.add(first);
    }
  }

  // Relational cue: explicit comparison / relationship markers => multi-hop
  // (4c, checked before the proper-noun heuristic). These are 0/296 on LOCOMO
  // so they cannot regress LOCOMO; they help real and BEAM-style traffic that
  // the 2-proper-noun heuristic misses. temporal-multi-hop when also temporal.
  const hasRelationalCue =
    /\b(in common|compare\b|comparison|difference between|differ\b|relationship between|connection between|related to|both .{0,40} and\b|versus|\bvs\b)\b/.test(
      q,
    );
  if (hasRelationalCue) {
    return hasTemporalKeywords ? 'temporal-multi-hop' : 'multi-hop';
  }

  // Packet C (H4): explicit ordering-intent cues route to the temporal path so the
  // timeline + Packet A date surfacing fire for "which came first / order of" questions.
  // NARROW BY DESIGN (golden file, see c3f8585, which pulled order cues out of the
  // synthesis rule above): the cue set is restricted to forms that appear in real LME
  // ordering questions ("order of …", "first, A or B", "first … then", "chronological")
  // and deliberately EXCLUDES "in what order / list the order / sequence", those are how
  // BEAM phrases discourse-order ("list the order in which I brought up … across our
  // conversations"), and routing them to temporal would regress BEAM event_ordering.
  // Placed below synthesis (preserves c3f8585) and the relational cue (preserves
  // compare/difference → multi-hop), and above the multi-entity rule so ordering wins.
  // 2+ entities → temporal-multi-hop (keeps multi-hop bridge retrieval AND gains the
  // timeline); otherwise temporal.
  const hasOrderingCue =
    /\border of\b/.test(q) ||
    /\bfirst,/.test(q) ||
    /\bfirst\b[^.?!]*\bthen\b/.test(q) ||
    /\bchronological(ly)?\b/.test(q);
  if (hasOrderingCue) {
    return properNouns.size >= 2 ? 'temporal-multi-hop' : 'temporal';
  }

  // Multi-hop: 2+ distinct entities (checked BEFORE temporal).
  // S30: queries with 2+ proper nouns AND temporal keywords get compound type
  // `temporal-multi-hop` so they keep multi-hop bridge retrieval AND gain
  // timeline injection. Previously these lost timeline coverage (~-18pts).
  if (properNouns.size >= 2 && hasTemporalKeywords) {
    return 'temporal-multi-hop';
  }
  if (properNouns.size >= 2) {
    return 'multi-hop';
  }

  // Temporal: "when", date patterns, time words (checked AFTER multi-hop)
  // S67: reuse hasTemporalKeywords computed at the top of this function, it
  // tests the exact same 8 regexes. Was a duplicate compute on every classify()
  // call. The set of markers stays in sync because there's now one definition.
  // Historical context for the markers: S46 added historical-intent (before,
  // used to, over time, past, previously, formerly, has changed, did change,
  // list...over time) so superseded facts surface for bi-temporal queries.
  // S63 removed `throughout` since it's a span marker, not a time-anchor.
  if (hasTemporalKeywords) {
    return 'temporal';
  }

  // Open-domain is checked higher up now (4b). Default to single-hop, which
  // the answer path routes to the merged conversational cell.
  return 'single-hop';
}
