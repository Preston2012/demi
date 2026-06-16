/**
 * D1 (S72): Write-time relative-date resolution + Temporal Parse IR.
 *
 * Deterministic temporal phrase resolver. Pure functions, no I/O.
 *
 * The Adjudicator's high-confidence deterministic branch (per
 * MASTER_EXECUTION_v4.md §8). Run at write-time on each extracted claim
 * before storage. If a relative temporal phrase is detected AND confidence
 * is high, mutate the claim to canonical form and return a TemporalAtom
 * describing what changed. If confidence is below threshold, return the
 * phrase as `unresolved` so callers can log telemetry (calibrator pickup
 * lives in Wedge 4 (not part of this build).
 *
 * Phrase coverage:
 *   - Relative day: yesterday, today, tomorrow, the day before yesterday
 *   - Relative span: last week, this week, next week, last month, this month,
 *     next month, last year, this year, next year
 *   - Numeric offset: N days ago, N weeks ago, N months ago, in N days,
 *     N years ago, last N days/weeks
 *   - Spelled-out offset: <a/an/one..twenty> days/weeks/months/years ago,
 *     in <a/an/one..twenty> days/weeks/months/years (e.g. "three weeks ago",
 *     "a week ago", "in two days")
 *   - Weekday anchor: (last|this|next) <weekday> (e.g. "last Saturday",
 *     "next Tuesday"). last = most recent past occurrence, next = next future
 *     occurrence, this = the occurrence in the current (Sunday-started) week.
 *     A bare weekday with no qualifier is intentionally left UNMATCHED, as it is
 *     too ambiguous to resolve safely (e.g. "Saturday Night Live").
 *   - Partial absolute: month-name + day + year (January 15, 2024),
 *     month-name + year (March 2024), month-name + day no year
 *     (resolves against anchor's year)
 *   - Full ISO already present: detected but not mutated (idempotent)
 *
 * Confidence policy:
 *   - Exact regex match on unambiguous phrase: 0.95
 *   - Match on phrase with one degree of ambiguity (no year on
 *     month-name+day): 0.80
 *   - Match on multiple phrases in one claim, only the first is resolved
 *     (the rest get logged as `unresolved` for telemetry): 0.50
 *   - No match: returns null (claim is fully absolute or unhandled)
 *
 * Threshold: 0.80 by default. Below threshold, the original claim text is
 * preserved and the resolver returns { ok: false, reason: 'low_confidence' }
 * so the write path can log telemetry without mutating.
 *
 * Idempotency: running the resolver twice on the same claim is safe.
 * If `claim` is already canonical (no relative phrases), returns
 * { ok: false, reason: 'no_relative_phrase' } and the original claim
 * is preserved unchanged.
 */

export interface TemporalAtom {
  /** The exact phrase from the original claim that was resolved. */
  phrase: string;
  /** The anchor date used as reference (typically conversation asserted_at). */
  anchorDate: string;
  /** The resolved absolute date in YYYY-MM-DD. */
  resolvedDate: string;
  /** Confidence in the resolution [0, 1]. Pattern-specific. */
  confidence: number;
  /** Which regex/method produced this resolution (for audit). */
  method: string;
}

export interface ResolveResult {
  /** True if a relative phrase was found AND resolved at or above threshold. */
  ok: boolean;
  /** When ok=false, why we didn't mutate. */
  reason?: 'no_relative_phrase' | 'low_confidence' | 'invalid_anchor';
  /** The mutated claim text. Equal to input when ok=false. */
  claim: string;
  /** The original claim text, always present. */
  rawClaim: string;
  /** Resolution metadata. Present iff ok=true. */
  atom?: TemporalAtom;
  /** Any additional phrases detected but not resolved (telemetry). */
  unresolved: string[];
}

export interface ResolveOpts {
  /** Confidence floor below which we do not mutate. Default 0.80. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.8;
const MS_PER_DAY = 86_400_000;

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Spelled-out cardinals for relative offsets ("three weeks ago", "a week ago").
// Covers a/an/one through twenty, the conversational range observed in the corpus.
const SPELLED_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

// Weekday names + common abbreviations, indexed to match JS Date.getUTCDay()
// (Sunday=0 … Saturday=6).
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Build a regex alternation from a word→value map, longest words first so that
 * a shorter word (e.g. "seven") cannot shadow a longer one ("seventeen").
 */
function alternation(map: Record<string, unknown>): string {
  return Object.keys(map)
    .sort((a, b) => b.length - a.length)
    .join('|');
}

const SPELLED_ALT = alternation(SPELLED_NUMBERS);
const WEEKDAY_ALT = alternation(WEEKDAYS);

function toISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseAnchor(anchorIso: string): Date | null {
  const ms = Date.parse(anchorIso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function shiftDays(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() + days * MS_PER_DAY);
}

function shiftMonths(anchor: Date, months: number): Date {
  const d = new Date(anchor);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function shiftYears(anchor: Date, years: number): Date {
  const d = new Date(anchor);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

/**
 * Resolve a weekday anchor relative to `anchor`.
 *   - 'last': the most recent occurrence strictly before the anchor.
 *   - 'next': the next occurrence strictly after the anchor.
 *   - 'this': the occurrence within the current (Sunday-started) week, which
 *     may fall before or after the anchor.
 * `weekday` is indexed Sunday=0 … Saturday=6 (matching getUTCDay()).
 */
function shiftToWeekday(anchor: Date, weekday: number, direction: 'last' | 'this' | 'next'): Date {
  const anchorDow = anchor.getUTCDay();
  if (direction === 'this') {
    const weekStart = shiftDays(anchor, -anchorDow);
    return shiftDays(weekStart, weekday);
  }
  if (direction === 'next') {
    let diff = (weekday - anchorDow + 7) % 7;
    if (diff === 0) diff = 7;
    return shiftDays(anchor, diff);
  }
  // 'last'
  let diff = (anchorDow - weekday + 7) % 7;
  if (diff === 0) diff = 7;
  return shiftDays(anchor, -diff);
}

// ---------------------------------------------------------------------------
// Pattern table. Order matters: first match wins per claim.
// ---------------------------------------------------------------------------

interface Pattern {
  name: string;
  regex: RegExp;
  confidence: number;
  resolve: (match: RegExpMatchArray, anchor: Date) => string | null;
}

const PATTERNS: Pattern[] = [
  // Day relative
  {
    name: 'day-before-yesterday',
    regex: /\bthe day before yesterday\b/i,
    confidence: 0.95,
    resolve: (_m, anchor) => toISODate(shiftDays(anchor, -2)),
  },
  {
    name: 'yesterday',
    regex: /\byesterday\b/i,
    confidence: 0.95,
    resolve: (_m, anchor) => toISODate(shiftDays(anchor, -1)),
  },
  {
    name: 'today',
    regex: /\btoday\b/i,
    confidence: 0.95,
    resolve: (_m, anchor) => toISODate(anchor),
  },
  {
    name: 'tomorrow',
    regex: /\btomorrow\b/i,
    confidence: 0.95,
    resolve: (_m, anchor) => toISODate(shiftDays(anchor, 1)),
  },
  // Numeric offset days. Regex allows up to 5 digits so the n > 36500
  // plausibility guard below has a chance to fire on implausible inputs
  // (e.g. "99999 days ago") instead of falling through to no-match.
  {
    name: 'n-days-ago',
    regex: /\b(\d{1,5}) days? ago\b/i,
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = parseInt(m[1] ?? '0', 10);
      if (!Number.isFinite(n) || n < 0 || n > 36500) return null;
      return toISODate(shiftDays(anchor, -n));
    },
  },
  {
    name: 'in-n-days',
    regex: /\bin (\d{1,4}) days?\b/i,
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = parseInt(m[1] ?? '0', 10);
      if (!Number.isFinite(n) || n < 0 || n > 36500) return null;
      return toISODate(shiftDays(anchor, n));
    },
  },
  // Numeric offset weeks
  {
    name: 'n-weeks-ago',
    regex: /\b(\d{1,3}) weeks? ago\b/i,
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = parseInt(m[1] ?? '0', 10);
      if (!Number.isFinite(n) || n < 0 || n > 5200) return null;
      return toISODate(shiftDays(anchor, -n * 7));
    },
  },
  // Numeric offset months
  {
    name: 'n-months-ago',
    regex: /\b(\d{1,3}) months? ago\b/i,
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = parseInt(m[1] ?? '0', 10);
      if (!Number.isFinite(n) || n < 0 || n > 1200) return null;
      return toISODate(shiftMonths(anchor, -n));
    },
  },
  // Numeric offset years
  {
    name: 'n-years-ago',
    regex: /\b(\d{1,3}) years? ago\b/i,
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = parseInt(m[1] ?? '0', 10);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      return toISODate(shiftYears(anchor, -n));
    },
  },
  // Spelled-out number offsets ("three weeks ago", "a week ago"). Mirror the
  // digit patterns above; confidence matches (0.95). The digit and spelled
  // regexes cannot shadow each other (digit needs \d, spelled needs letters).
  {
    name: 'spelled-n-unit-ago',
    regex: new RegExp(`\\b(${SPELLED_ALT})\\s+(days?|weeks?|months?|years?)\\s+ago\\b`, 'i'),
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = SPELLED_NUMBERS[(m[1] ?? '').toLowerCase()];
      if (n === undefined) return null;
      const unit = (m[2] ?? '').toLowerCase();
      if (unit.startsWith('day')) return toISODate(shiftDays(anchor, -n));
      if (unit.startsWith('week')) return toISODate(shiftDays(anchor, -n * 7));
      if (unit.startsWith('month')) return toISODate(shiftMonths(anchor, -n));
      if (unit.startsWith('year')) return toISODate(shiftYears(anchor, -n));
      return null;
    },
  },
  {
    name: 'spelled-in-n-unit',
    regex: new RegExp(`\\bin\\s+(${SPELLED_ALT})\\s+(days?|weeks?|months?|years?)\\b`, 'i'),
    confidence: 0.95,
    resolve: (m, anchor) => {
      const n = SPELLED_NUMBERS[(m[1] ?? '').toLowerCase()];
      if (n === undefined) return null;
      const unit = (m[2] ?? '').toLowerCase();
      if (unit.startsWith('day')) return toISODate(shiftDays(anchor, n));
      if (unit.startsWith('week')) return toISODate(shiftDays(anchor, n * 7));
      if (unit.startsWith('month')) return toISODate(shiftMonths(anchor, n));
      if (unit.startsWith('year')) return toISODate(shiftYears(anchor, n));
      return null;
    },
  },
  // Week spans
  {
    name: 'last-week',
    regex: /\blast week\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftDays(anchor, -7)),
  },
  {
    name: 'this-week',
    regex: /\bthis week\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(anchor),
  },
  {
    name: 'next-week',
    regex: /\bnext week\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftDays(anchor, 7)),
  },
  // Month spans
  {
    name: 'last-month',
    regex: /\blast month\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftMonths(anchor, -1)),
  },
  {
    name: 'this-month',
    regex: /\bthis month\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(anchor),
  },
  {
    name: 'next-month',
    regex: /\bnext month\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftMonths(anchor, 1)),
  },
  // Year spans
  {
    name: 'last-year',
    regex: /\blast year\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftYears(anchor, -1)),
  },
  {
    name: 'this-year',
    regex: /\bthis year\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(anchor),
  },
  {
    name: 'next-year',
    regex: /\bnext year\b/i,
    confidence: 0.85,
    resolve: (_m, anchor) => toISODate(shiftYears(anchor, 1)),
  },
  // Weekday anchors ("last Saturday", "this Tuesday", "next Tuesday"). A bare
  // weekday with no last/this/next qualifier is intentionally NOT matched: it is
  // too ambiguous and prone to false positives ("Saturday Night Live"). Weekday
  // words never overlap month names or "week/month/year", so placement here
  // neither shadows nor is shadowed by the span/month patterns.
  {
    name: 'weekday-anchor',
    regex: new RegExp(`\\b(last|this|next)\\s+(${WEEKDAY_ALT})\\b`, 'i'),
    confidence: 0.85,
    resolve: (m, anchor) => {
      const direction = (m[1] ?? '').toLowerCase() as 'last' | 'this' | 'next';
      const weekday = WEEKDAYS[(m[2] ?? '').toLowerCase()];
      if (weekday === undefined) return null;
      return toISODate(shiftToWeekday(anchor, weekday, direction));
    },
  },
  // Partial absolute: Month + day + year (full form, high confidence)
  {
    name: 'month-day-year',
    regex:
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
    confidence: 0.95,
    resolve: (m, _anchor) => {
      const monKey = (m[1] ?? '').toLowerCase();
      const mon = MONTH_NAMES[monKey];
      if (mon === undefined) return null;
      const day = parseInt(m[2] ?? '0', 10);
      const year = parseInt(m[3] ?? '0', 10);
      if (!Number.isFinite(day) || day < 1 || day > 31) return null;
      if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;
      const d = new Date(Date.UTC(year, mon, day));
      return toISODate(d);
    },
  },
  // Partial absolute: Month + day (no year, resolves against anchor year)
  {
    name: 'month-day-no-year',
    regex:
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
    confidence: 0.8,
    resolve: (m, anchor) => {
      const monKey = (m[1] ?? '').toLowerCase();
      const mon = MONTH_NAMES[monKey];
      if (mon === undefined) return null;
      const day = parseInt(m[2] ?? '0', 10);
      if (!Number.isFinite(day) || day < 1 || day > 31) return null;
      const d = new Date(Date.UTC(anchor.getUTCFullYear(), mon, day));
      return toISODate(d);
    },
  },
  // Partial absolute: Month + year (no day, first of month). Accepts both
  // full and short month names; MONTH_NAMES covers both spellings.
  {
    name: 'month-year',
    regex:
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/i,
    confidence: 0.85,
    resolve: (m, _anchor) => {
      const monKey = (m[1] ?? '').toLowerCase();
      const mon = MONTH_NAMES[monKey];
      if (mon === undefined) return null;
      const year = parseInt(m[2] ?? '0', 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;
      const d = new Date(Date.UTC(year, mon, 1));
      return toISODate(d);
    },
  },
];

// ISO date already present (detect for telemetry but do not mutate).
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

/**
 * Try to resolve a single relative temporal phrase in `claim`, anchored
 * against `anchorIso`. Returns a ResolveResult that callers can use to
 * decide whether to mutate the stored claim.
 *
 * Idempotent: if the claim contains no relative phrase, returns
 * { ok: false, reason: 'no_relative_phrase', claim, rawClaim: claim, ... }
 * and the caller stores the claim unchanged.
 */
export function resolveTemporal(claim: string, anchorIso: string, opts: ResolveOpts = {}): ResolveResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const anchor = parseAnchor(anchorIso);
  if (!anchor) {
    return {
      ok: false,
      reason: 'invalid_anchor',
      claim,
      rawClaim: claim,
      unresolved: [],
    };
  }

  // Find the first matching pattern.
  let firstMatch: { pattern: Pattern; match: RegExpMatchArray } | null = null;
  for (const p of PATTERNS) {
    const m = claim.match(p.regex);
    if (m) {
      firstMatch = { pattern: p, match: m };
      break;
    }
  }

  if (!firstMatch) {
    // Pure absolute ISO date or no temporal phrase at all. No mutation.
    return {
      ok: false,
      reason: 'no_relative_phrase',
      claim,
      rawClaim: claim,
      unresolved: [],
    };
  }

  const resolved = firstMatch.pattern.resolve(firstMatch.match, anchor);
  if (!resolved) {
    // Pattern matched syntactically but resolution failed (e.g. day=99).
    return {
      ok: false,
      reason: 'low_confidence',
      claim,
      rawClaim: claim,
      unresolved: [firstMatch.match[0] ?? firstMatch.pattern.name],
    };
  }

  if (firstMatch.pattern.confidence < threshold) {
    return {
      ok: false,
      reason: 'low_confidence',
      claim,
      rawClaim: claim,
      unresolved: [firstMatch.match[0] ?? firstMatch.pattern.name],
    };
  }

  // Resolve: substitute the matched phrase with `on YYYY-MM-DD`.
  const matchedText = firstMatch.match[0] ?? '';
  const mutatedClaim = claim.replace(matchedText, `on ${resolved}`);

  // Look for additional unresolved phrases (telemetry only).
  const unresolved: string[] = [];
  const remainder = mutatedClaim;
  for (const p of PATTERNS) {
    if (p === firstMatch.pattern) continue;
    const m = remainder.match(p.regex);
    if (m && m[0]) {
      unresolved.push(m[0]);
    }
  }

  const atom: TemporalAtom = {
    phrase: matchedText,
    anchorDate: toISODate(anchor),
    resolvedDate: resolved,
    confidence: firstMatch.pattern.confidence,
    method: firstMatch.pattern.name,
  };

  return {
    ok: true,
    claim: mutatedClaim,
    rawClaim: claim,
    atom,
    unresolved,
  };
}

/**
 * Detect whether a claim contains any temporal phrase the resolver knows
 * about. Cheap pre-check for write-path "skip resolver entirely" optimization.
 * Returns true if at least one pattern matches.
 */
export function hasTemporalPhrase(claim: string): boolean {
  for (const p of PATTERNS) {
    if (p.regex.test(claim)) return true;
  }
  if (ISO_DATE_RE.test(claim)) return true;
  return false;
}

/**
 * Build the normalization JSON blob stored alongside a mutated claim.
 * Shape: { type, anchorDate, rulesApplied: [method] }.
 */
export function buildNormalization(atom: TemporalAtom): string {
  return JSON.stringify({
    type: 'temporal-parse-ir-v1',
    anchorDate: atom.anchorDate,
    rulesApplied: [atom.method],
    confidence: atom.confidence,
    resolvedDate: atom.resolvedDate,
  });
}
