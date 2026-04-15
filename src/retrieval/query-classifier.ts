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
  const q = query.toLowerCase();

  // Coverage: broad listing/activity questions
  if (/\b(what activities|what has\b.*\bdone|list all|what are all|everything\b.*\bdone|all the things)\b/.test(q)) {
    return 'coverage';
  }

  // Current-state: present status questions
  // S4: Don't claim current-state if temporal keywords are also present
  // S4: Current-state yields to temporal when both match
  const hasTemporalKeywords =
    /\bwhen\b/.test(q) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q) ||
    /\b\d{4}\b/.test(q) ||
    /\b(last|next|recent|ago|summer|winter|spring|fall)\b/.test(q);
  if (
    /\b(current(ly)?|right now|status|still\b|at the moment|these days|at present|nowadays)\b/.test(q) &&
    !hasTemporalKeywords
  ) {
    return 'current-state';
  }

  // Synthesis: summarization/overview/evolution questions
  if (
    /\b(summarize|summary|overview|how has\b.*\bevolved|how have\b.*\bchanged|describe\b.*\bprogression|describe\b.*\bjourney|walk\b.*\bthrough|give\b.*\brecap|tell\b.*\babout\b.*\bover time|developed over|in what order|chronolog|first\b.*\bthen|what\b.*\bcame\b.*\bfirst|order\b.*\bsequence)\b/.test(
      q,
    )
  ) {
    return 'synthesis';
  }

  // Narrative: storytelling/descriptive questions
  if (/\b(tell me about|what happened|describe\b|story of|explain what|how did\b.*\bgo|what was\b.*\blike)\b/.test(q)) {
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
  if (
    /\bwhen\b/.test(q) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q) ||
    /\b\d{4}\b/.test(q) ||
    /\b(last|next|recent|ago|summer|winter|spring|fall)\b/.test(q)
  ) {
    return 'temporal';
  }

  // Open-domain: hypothetical/opinion markers
  if (/\b(would|likely|could|opinion|think|believe|consider|fields|pursue)\b/.test(q)) {
    return 'open-domain';
  }

  return 'single-hop';
}

/**
 * Get optimal retrieval depth for query type.
 * Based on ablation testing (sessions 5-12).
 */
export function getDepthForType(queryType: QueryType, _baseDepth: number): number {
  const depthMap: Record<QueryType, number> = {
    'single-hop': 35,
    temporal: 45,
    'multi-hop': 100,
    'temporal-multi-hop': 100,
    'open-domain': 50,
    narrative: 65,
    synthesis: 100,
    summarization: 100,
    'current-state': 45,
    coverage: 100,
  };
  return depthMap[queryType];
}
