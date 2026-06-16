/**
 * Single source of truth for the assertion-triple grammar.
 *
 * Each entry produces TWO regexes:
 *   - `claimRegex`, matches the CLAIM TAIL (claim with subject prefix
 *     stripped) at write time. Used by src/plan/triples.ts decomposer to
 *     populate (subject, predicate, object) rows in `assertion_triples`.
 *   - `queryHintRegex`, matches the QUERY at read time. Used by
 *     src/plan/planner.ts to set `features.predicateHint`, which drives
 *     `lookup(subject, predicate)` operators in the emitted Plan.
 *
 * Claims are statements ("X works at Y") and queries are questions
 * ("Where does X work?"); the two regexes are intentionally distinct.
 * But they SHARE the same `predicate` symbol so the planner is
 * guaranteed by construction to ask only about predicates the
 * decomposer can populate. A future contributor who adds a pattern
 * updates ONE place and both sides pick it up.
 *
 * `queryHintRegex` may be `null` when a pattern is decomposer-only
 * (e.g. `is_a`, no useful single-keyword query hint maps to it).
 *
 * `populatesValidFrom` is true when the claimRegex includes a capture
 * group named `valid_from_capture` OR the future `when` group; the
 * planner uses this to decide whether a temporal operator's
 * valid_from filter has anything to filter against. Stage 1: only
 * `visited` populates valid_from.
 *
 * Patterns are ordered. The decomposer walks them in array order and
 * takes the first match (more specific shapes before broader ones).
 * The planner walks `queryHintRegex` for hint detection in the same
 * order, first hit wins, matches the legacy first-match-wins behavior
 * of the inline PREDICATE_HINTS table.
 */

export interface GrammarEntry {
  predicate: string;
  claimRegex: RegExp;
  /** Set to null for decomposer-only patterns that have no useful query-side hint. */
  queryHintRegex: RegExp | null;
  /**
   * True when the claimRegex captures a date into `valid_from_capture`
   * (or, post-P1, a `when` named group that gets resolved through
   * temporal-parse-ir). Drives planner gates that decide whether a
   * temporal operator can constrain the result usefully.
   */
  populatesValidFrom: boolean;
}

/**
 * The grammar. Entry order matches the legacy PATTERNS array in
 * triples.ts and the legacy PREDICATE_HINTS array in planner.ts so this
 * P0 commit is byte-equivalent to baseline. P1 adds new entries.
 */
export const GRAMMAR: GrammarEntry[] = [
  // 1. "X was/were born in Y" → born_in
  {
    predicate: 'born_in',
    claimRegex: /^(?:was|were)\s+born\s+in\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\bborn\b/,
    populatesValidFrom: false,
  },
  // 2. "X lives/lived in Y" → lives_in
  {
    predicate: 'lives_in',
    claimRegex: /^(?:lives?|lived)\s+in\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\blive[sd]?\b/,
    populatesValidFrom: false,
  },
  // 3. "X is/are located in Y" / "X is/are based in Y" → located_in
  {
    predicate: 'located_in',
    claimRegex: /^(?:is|are)\s+(?:located|based)\s+in\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:located|based)\b/,
    populatesValidFrom: false,
  },
  // 4. "X is/are from Y" → from
  {
    predicate: 'from',
    claimRegex: /^(?:is|are)\s+from\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\bfrom\b/,
    populatesValidFrom: false,
  },
  // 5. "X moved/relocated to Y" → moved_to
  {
    predicate: 'moved_to',
    claimRegex: /^(?:moved|relocated)\s+to\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:moved|relocated)\b/,
    populatesValidFrom: false,
  },
  // 6. "X works at/for Y" → works_at
  {
    predicate: 'works_at',
    claimRegex: /^works?\s+(?:at|for)\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\bwork(?:s|ed|ing)?\s+(?:at|for)\b/,
    populatesValidFrom: false,
  },
  // 7. "X works as Y" → works_as
  {
    predicate: 'works_as',
    claimRegex: /^works?\s+as\s+(?:a|an)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\bwork(?:s|ed|ing)?\s+as\b/,
    populatesValidFrom: false,
  },
  // 8. "X studied/graduated at/from Y" → studied_at
  {
    predicate: 'studied_at',
    claimRegex: /^(?:studied|graduated)\s+(?:at|from)\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:studied|graduated|alma\s+mater|university|college|school)\b/,
    populatesValidFrom: false,
  },
  // 9. "X is/was married to Y" → married_to
  {
    predicate: 'married_to',
    claimRegex: /^(?:is|was)\s+married\s+to\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\bmarried\b/,
    populatesValidFrom: false,
  },
  // 10. "X visited/went to/traveled to Y (on|in|during DATE)?" → visited
  //     P1: broadened from strict YYYY-MM-DD to a generic `when` group that
  //     resolveTemporal() in triples.ts will normalize to ISO date. Catches
  //     "on Tuesday" / "in November 2023" / "last week" / "yesterday" via
  //     the temporal-parse-ir module's existing patterns.
  {
    predicate: 'visited',
    claimRegex: /^(?:visited|went\s+to|traveled\s+to)\s+(?<object>.+?)(?:\s+(?:on|in|during|at)\s+(?<when>.+?))?\.?$/i,
    // queryHintRegex matches past, present, infinitive, and gerund forms
    // because questions naturally use "did X visit Y" (bare infinitive)
    // or "where has X visited" (past participle). Matching only the past
    // tense was the gap that left "When did Tim visit Berlin?" without
    // a hint and forced an unnecessary planner decline.
    queryHintRegex: /\b(?:visit(?:s|ed|ing)?|went\s+to|traveled\s+to|been\s+to)\b/,
    populatesValidFrom: true,
  },
  // 11. "X owns Y" / "X owned Y" → owns
  {
    predicate: 'owns',
    claimRegex: /^(?:owns?|owned)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:owns?|owned)\b/,
    populatesValidFrom: false,
  },
  // 12. "X likes/loves/enjoys/prefers Y" → likes
  //     P1: broadened to include prefers / is fond of / is into.
  {
    predicate: 'likes',
    claimRegex: /^(?:likes?|loves?|enjoys?|prefers?|is\s+fond\s+of|is\s+into|adores?)\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:likes?|loves?|prefers?|favorit(?:e|es)|fond)\b/,
    populatesValidFrom: false,
  },
  // 13. "X is a/an Y" → is_a   (kept last among "is" forms; broader)
  // No query hint, "is a" questions ("Who is Joe?") are too generic
  // to pin to a specific predicate without entity grounding.
  {
    predicate: 'is_a',
    claimRegex: /^(?:is|was|are|were)\s+(?:a|an)\s+(?<object>.+?)\.?$/i,
    queryHintRegex: null,
    populatesValidFrom: false,
  },

  // ====================================================================
  // P1 expansion (LOCOMO-shape-driven). 19 new patterns. Order matters:
  // more specific shapes go before broader ones so first-match-wins.
  // Patterns that capture a `when` group set populatesValidFrom=true so
  // the decomposer's temporal-parse-ir wiring resolves the prose to an
  // ISO date when present.
  // ====================================================================

  // 14. "X met / met with Y (on|in|at WHEN)?" → met
  {
    predicate: 'met',
    claimRegex: /^(?:met(?:\s+with)?)\s+(?<object>.+?)(?:\s+(?:on|in|at)\s+(?<when>.+?))?\.?$/i,
    // Includes bare-infinitive "meet" so "did X meet Y" hits.
    queryHintRegex: /\b(?:meet|meets|meeting|met)\b/,
    populatesValidFrom: true,
  },

  // 15. "X said/told/asked/spoke to Y" → communicated_with
  //     The "to|with" preposition is REQUIRED so "spoke X" (where X is a
  //     language) falls through to pattern 24 (speaks_language).
  //     "talked to Y" / "spoke with Y" / "told Y about Z" all match.
  {
    predicate: 'communicated_with',
    claimRegex:
      /^(?:said(?:\s+to)?|told|asked|spoke\s+(?:to|with)|talked\s+(?:to|with))\s+(?<object>.+?)(?:\s+(?:about|on|in|at)\s+(?<when>.+?))?\.?$/i,
    queryHintRegex: /\b(?:said|told|asked|spoke|talked|conversation)\b/,
    populatesValidFrom: true,
  },

  // 16. "X got into / was accepted by / joined Y" → accepted_by
  //     MUST come before the broader `got` pattern (#17) so "got into X"
  //     hits `accepted_by` and not `got` with object="into X". The order
  //     of GRAMMAR entries is enforced by the decomposer's first-match-
  //     wins loop in src/plan/triples.ts.
  {
    predicate: 'accepted_by',
    claimRegex: /^(?:got\s+into|was\s+accepted\s+(?:by|into|to)|joined)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:got\s+into|accepted\s+(?:by|into|to)|joined)\b/,
    populatesValidFrom: false,
  },

  // 17. "X got/received/obtained Y (from|on WHEN)?" → got
  {
    predicate: 'got',
    claimRegex:
      /^(?:got|received|obtained)\s+(?:a|an|the)?\s*(?<object>.+?)(?:\s+(?:from|on|in|at)\s+(?<when>.+?))?\.?$/i,
    queryHintRegex: /\b(?:got|received|obtained|gotten)\b/,
    populatesValidFrom: true,
  },

  // 18. "X adopted/rescued Y (from Z)?" → adopted
  //     The optional `from <source>` group is captured but we emit a
  //     single triple per match for now; a follow-up could emit a
  //     second linking triple (subject=Y, predicate=adopted_from,
  //     object=Z). Stage 1 keeps it simple.
  {
    predicate: 'adopted',
    claimRegex: /^(?:adopted|rescued)\s+(?:a|an|the)?\s*(?<object>.+?)(?:\s+from\s+(?<source>.+))?\.?$/i,
    queryHintRegex: /\b(?:adopted|rescued)\b/,
    populatesValidFrom: false,
  },

  // 19. "X bought/purchased Y" → bought
  {
    predicate: 'bought',
    claimRegex: /^(?:bought|purchased)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:bought|purchased)\b/,
    populatesValidFrom: false,
  },

  // 20. "X sold Y" → sold
  {
    predicate: 'sold',
    claimRegex: /^sold\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\bsold\b/,
    populatesValidFrom: false,
  },

  // 21. "X started/launched/founded/created/opened Y" → started
  {
    predicate: 'started',
    claimRegex: /^(?:started|launched|founded|created|opened)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:started|launched|founded|created|opened)\b/,
    populatesValidFrom: false,
  },

  // 22. "X finished/completed Y" → finished
  //     "graduated from" is intentionally LEFT to pattern 8 (studied_at)
  //     because the predicate join is more useful there.
  {
    predicate: 'finished',
    claimRegex: /^(?:finished|completed)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:finished|completed)\b/,
    populatesValidFrom: false,
  },

  // 23. "X dislikes/hates/avoids Y" → dislikes
  //     Sentiment opposite of likes. Separate predicate so retrieval
  //     can distinguish "X likes Y" from "X dislikes Y".
  {
    predicate: 'dislikes',
    claimRegex: /^(?:dislikes?|hates?|avoids?|can'?t\s+stand)\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:dislikes?|hates?|avoids?)\b/,
    populatesValidFrom: false,
  },

  // 24. "X speaks/spoke Y" (language) → speaks_language
  //     Narrow: only matches when followed by a single noun (language
  //     name). "spoke to Y" is already caught by pattern 15
  //     (communicated_with) because that pattern is listed earlier.
  {
    predicate: 'speaks_language',
    claimRegex: /^(?:speaks?|spoke)\s+(?<object>[A-Za-z][A-Za-z\s-]*?)\.?$/i,
    queryHintRegex: /\bspeaks?\b/,
    populatesValidFrom: false,
  },

  // 25. "X plays/played Y" (instrument or sport) → plays
  {
    predicate: 'plays',
    claimRegex: /^(?:plays?|played)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:plays?|played)\b/,
    populatesValidFrom: false,
  },

  // 26. "X drives/drove Y" → drives
  {
    predicate: 'drives',
    claimRegex: /^(?:drives?|drove)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:drives?|drove)\b/,
    populatesValidFrom: false,
  },

  // 27. "X is/was N years old" → age (literal)
  {
    predicate: 'age',
    claimRegex: /^(?:is|was)\s+(?<object>\d+)\s+years?\s+old\.?$/i,
    queryHintRegex: /\bage(?:d|s)?\b|\bold\b|\byears\s+old\b/,
    populatesValidFrom: false,
  },

  // 28. "has/had a Y" → has
  //     Broader than owns: rentals, possessions, body parts ("has a cat",
  //     "had a meeting"). Listed LAST among "has" forms; owns (#11)
  //     wins for permanent ownership.
  {
    predicate: 'has',
    claimRegex: /^(?:has|had)\s+(?:a|an|the)?\s*(?<object>.+?)\.?$/i,
    queryHintRegex: /\bhas\b|\bhad\b/,
    populatesValidFrom: false,
  },

  // 29-31. Family / social relations.
  //     LOCOMO claims often shape as "X's [relation] is Y" or
  //     "X is Y's [relation]". The relation word becomes the predicate
  //     directly; the join key for graph hops is the relation type.
  //     Order: most specific (parent/child) before generic (friend).
  //
  //     These patterns match TAIL where stripSubjectPrefix already
  //     removed "X" or "X's". The remaining text is the rest.
  {
    predicate: 'partner_of',
    claimRegex: /^(?:'s|s')?\s*(?:partner|spouse|husband|wife|fianc[eé]e?)\s+is\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:partner|spouse|husband|wife)\b/,
    populatesValidFrom: false,
  },

  // 30. "X's [parent|child|sibling] is Y" → family relation
  {
    predicate: 'family_of',
    claimRegex:
      /^(?:'s|s')?\s*(?:child|son|daughter|parent|mother|father|mom|dad|sibling|brother|sister)\s+is\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:child|son|daughter|parent|mother|father|sibling|brother|sister)\b/,
    populatesValidFrom: false,
  },

  // 31. "X's friend/colleague/coworker/boss is Y" → social_of
  {
    predicate: 'social_of',
    claimRegex:
      /^(?:'s|s')?\s*(?:friend|colleague|coworker|boss|manager|employee|teammate|neighbor)\s+is\s+(?<object>.+?)\.?$/i,
    queryHintRegex: /\b(?:friend|colleague|coworker|boss|manager|employee|teammate|neighbor)\b/,
    populatesValidFrom: false,
  },

  // 32. "X attended Y (on|in|at WHEN)?" → attended
  //     Events, meetings, conferences, shows.
  {
    predicate: 'attended',
    claimRegex: /^attended\s+(?:a|an|the)?\s*(?<object>.+?)(?:\s+(?:on|in|at)\s+(?<when>.+?))?\.?$/i,
    queryHintRegex: /\battend(?:s|ed|ing)?\b/,
    populatesValidFrom: true,
  },
];

/**
 * Lookup helper: find the GrammarEntry for a predicate symbol. Returns
 * null when the predicate isn't in the grammar (which means the planner
 * built a hint for a predicate the decomposer doesn't populate, a bug
 * the planner's gate logic should catch before plan emission).
 */
export function grammarFor(predicate: string): GrammarEntry | null {
  for (const entry of GRAMMAR) {
    if (entry.predicate === predicate) return entry;
  }
  return null;
}

/**
 * Returns whether the decomposer's pattern for `predicate` populates
 * `valid_from` from claim text. Drives planner's decision on whether a
 * temporal operator's filter can constrain results for that predicate.
 */
export function grammarPopulatesValidFrom(predicate: string | null): boolean {
  if (predicate === null) return false;
  const entry = grammarFor(predicate);
  return entry?.populatesValidFrom ?? false;
}
