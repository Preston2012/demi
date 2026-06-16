/**
 * Wedge 2 (S74): Stage 1 deterministic planner.
 *
 * Reads `classifyQuery` plus a small heuristic feature extractor
 * (proper nouns, temporal markers, predicate hints) and emits a Plan
 *, or null when the query is out of Stage 1 coverage. A null return
 * tells the shim to fall back to legacy retrieve().
 *
 * Coverage rules (packet §3 + §6.4):
 *
 *   single-hop / open-domain / narrative / synthesis / summarization /
 *     coverage     → DECLINE (legacy handles these well; lock §6 forbids
 *                    regressing single-hop or open-domain).
 *   multi-hop      → lookup(N1, hint1?) + lookup(*, hint2?) + join.
 *   temporal-multi-hop → multi-hop chain + temporal(as_of nowIso).
 *   current-state  → lookup(N1, hint?) + temporal(as_of nowIso).
 *   temporal       → lookup(N1, hint?) + temporal(range or order).
 *   anything else  → DECLINE.
 *
 * No LLM calls. No SQL. Pure function over the query string.
 *
 * Target: >80% planned on LOCOMO mini multi-hop + temporal-multi-hop
 * subsets (lock condition §6.4). The remaining <20% decline; the shim
 * falls back. Coverage grows as new patterns + cases are added.
 */

import { classifyQuery, type QueryType } from '../retrieval/query-classifier.js';
import { DEFAULT_MAX_ROUNDS, type Plan, type Operator, type OperatorId } from './types.js';
import { GRAMMAR, grammarPopulatesValidFrom } from './grammar.js';

/**
 * Feature signals the planner reads. Exported for tests and for the shim
 * to log per-plan diagnostics.
 */
export interface QueryFeatures {
  queryType: QueryType;
  properNouns: string[];
  temporalMarkers: string[];
  predicateHint: string | null;
  multiHopHint: boolean;
}

/**
 * Plan a query into a Stage 1 DSL plan, or return null to decline.
 *
 * Acceptance rules (P2, broadened post-decomposer-expansion):
 *
 *   multi-hop         , accept when predicateHint OR ≥2 proper nouns
 *                        (chain join can still work on subject-only rows
 *                        when both endpoints are named).
 *   temporal-multi-hop, accept when (predicateHint AND hint anchors a
 *                        date-capable predicate) OR query has an
 *                        explicit date marker. Decline otherwise; the
 *                        shim falls back to legacy retrieve.
 *   current-state     , accept when predicateHint set (legacy gate;
 *                        keeps single-hop identity questions in legacy).
 *   temporal          , accept when (predicateHint that anchors dates)
 *                        OR query has a date marker. Same gate as
 *                        temporal-multi-hop minus the chain requirement.
 *
 *   everything else   , decline. single-hop / open-domain / narrative /
 *                        synthesis / summarization / coverage stay in
 *                        legacy retrieve per the §6 lock.
 *
 * The shim's empty-execution fallback (P3) catches cases where the
 * planner accepts but the decomposer didn't populate enough triples for
 * the executor to find rows. User experience never worse than baseline.
 */
export function planQuery(query: string, nowIso: string): Plan | null {
  const features = extractFeatures(query);

  switch (features.queryType) {
    case 'multi-hop':
      return planMultiHop(features);
    case 'temporal-multi-hop':
      if (!hasUsableTemporalShape(features)) return null;
      return planTemporalMultiHop(features, nowIso);
    case 'current-state':
      return planCurrentState(features, nowIso);
    case 'temporal':
      if (!hasUsableTemporalShape(features)) return null;
      return planTemporal(features, nowIso);
    default:
      // single-hop, open-domain, narrative, synthesis, summarization, coverage → decline.
      return null;
  }
}

/**
 * Returns true when the planner can usefully constrain a temporal
 * query, i.e. either the predicate hint anchors a date-capable
 * predicate (decomposer can populate valid_from for it) OR the query
 * contains an explicit date marker (year, month, etc.) so the temporal
 * operator can build a range or as_of slice independent of triple
 * dates.
 *
 * `hasDateMarker` covers the two surface forms: a 4-digit year (1900-
 * 2099) or any month/weekday name from the existing TEMPORAL_RE
 * captures.
 */
function hasUsableTemporalShape(f: QueryFeatures): boolean {
  if (f.properNouns.length < 1) return false;
  if (hasDateMarker(f)) return true;
  if (f.predicateHint && grammarPopulatesValidFrom(f.predicateHint)) return true;
  return false;
}

function hasDateMarker(f: QueryFeatures): boolean {
  for (const m of f.temporalMarkers) {
    if (/^(?:19|20)\d{2}$/.test(m)) return true; // year
    if (/^(?:january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(m))
      return true; // month
  }
  return false;
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Words that show up capitalized in English questions but aren't proper
 * nouns. Mirrors the lexicon used in src/retrieval/query-classifier.ts so
 * Stage 1 proper-noun counting agrees with the classifier's heuristic.
 */
const COMMON_NON_PROPER = new Set([
  'about',
  'after',
  'also',
  'are',
  'back',
  'been',
  'before',
  'being',
  'both',
  'came',
  'come',
  'could',
  'did',
  'do',
  'does',
  'each',
  'every',
  'find',
  'first',
  'from',
  'give',
  'gave',
  'great',
  'has',
  'have',
  'how',
  'just',
  'keep',
  'know',
  'last',
  'like',
  'little',
  'made',
  'make',
  'may',
  'might',
  'most',
  'much',
  'next',
  'no',
  'now',
  'only',
  'other',
  'out',
  'over',
  'own',
  'same',
  'some',
  'still',
  'such',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'use',
  'used',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'yes',
]);

/**
 * Predicate keyword hint table, DERIVED from src/plan/grammar.ts. The
 * decomposer and the planner share `grammar.ts` so they cannot drift.
 * Each GRAMMAR entry with a non-null `queryHintRegex` contributes one
 * row here, preserving GRAMMAR's original order (first-hit-wins
 * semantics unchanged from the legacy hardcoded table).
 *
 * Adding a new predicate? Add a single entry to `GRAMMAR`, both this
 * planner table and the decomposer's pattern loop pick it up
 * automatically. No more two-file edits, no more silent grammar drift.
 *
 * Re-derived once at module load (top-level const). Stable across calls.
 */
const PREDICATE_HINTS: Array<[RegExp, string]> = GRAMMAR.filter(
  (entry): entry is typeof entry & { queryHintRegex: RegExp } => entry.queryHintRegex !== null,
).map((entry) => [entry.queryHintRegex, entry.predicate]);

/** ISO date / year / season / month markers, same detector as the classifier. */
const TEMPORAL_RE =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|autumn|winter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:19|20)\d{2}\b|\b(?:last|next|recent|ago|earlier|prior|previously|formerly|past)\b/i;

export function extractFeatures(query: string): QueryFeatures {
  const queryType = classifyQuery(query);
  const properNouns = extractProperNouns(query);
  const lower = query.toLowerCase();
  const temporalMarkers: string[] = [];
  for (const m of lower.matchAll(new RegExp(TEMPORAL_RE.source, 'gi'))) {
    if (m[0]) temporalMarkers.push(m[0]);
  }
  let predicateHint: string | null = null;
  for (const [re, pred] of PREDICATE_HINTS) {
    if (re.test(lower)) {
      predicateHint = pred;
      break;
    }
  }
  const multiHopHint = properNouns.length >= 2 || queryType === 'multi-hop' || queryType === 'temporal-multi-hop';
  return { queryType, properNouns, temporalMarkers, predicateHint, multiHopHint };
}

function extractProperNouns(query: string): string[] {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (!raw) continue;
    // Strip leading/trailing punctuation.
    const cleaned = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (cleaned.length === 0) continue;
    const isCapitalized = /^[A-Z]/.test(cleaned);
    if (!isCapitalized) continue;
    // Skip sentence-initial unless it's clearly a name (multi-token follow-up
    // is the usual signal; here we use a stop-list).
    if (COMMON_NON_PROPER.has(cleaned.toLowerCase())) continue;
    out.push(cleaned);
  }
  // Deduplicate, preserve first-seen order.
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// Per-query-type plan builders
// ---------------------------------------------------------------------------

function planMultiHop(f: QueryFeatures): Plan | null {
  if (f.properNouns.length < 2) return null;
  const n1 = f.properNouns[0]!;
  const n2 = f.properNouns[1]!;
  // Stage 1 two-hop chain: lookup N1's outgoing edge, lookup any triple
  // whose object is N2 (via idx_triple_op), then join on
  // left.object == right.subject. This catches the canonical Caroline →
  // Berlin → Germany shape: (Caroline, born_in, Berlin) joins with
  // (Berlin, located_in, Germany) on object=subject.
  const operators: Record<OperatorId, Operator> = {
    a: { kind: 'lookup', id: 'a', entity: n1, predicate: f.predicateHint },
    b: { kind: 'lookup', id: 'b', entity: n2, predicate: null, direction: 'op' },
    c: { kind: 'join', id: 'c', left: 'a', right: 'b', on: 'object=subject' },
  };
  return {
    version: 1,
    root: 'c',
    operators,
    maxRounds: DEFAULT_MAX_ROUNDS,
    queryType: f.queryType,
    queryFeatures: featuresShape(f),
  };
}

function planTemporalMultiHop(f: QueryFeatures, nowIso: string): Plan | null {
  if (f.properNouns.length < 1) return null;
  // 1-noun temporal-multi-hop: single subject + temporal slice.
  if (f.properNouns.length === 1) {
    return planTemporal(f, nowIso);
  }
  // 2+ noun temporal-multi-hop: chain + temporal slice on root.
  const n1 = f.properNouns[0]!;
  const n2 = f.properNouns[1]!;
  const operators: Record<OperatorId, Operator> = {
    a: { kind: 'lookup', id: 'a', entity: n1, predicate: f.predicateHint },
    b: { kind: 'lookup', id: 'b', entity: n2, predicate: null, direction: 'op' },
    c: { kind: 'join', id: 'c', left: 'a', right: 'b', on: 'object=subject' },
    t: { kind: 'temporal', id: 't', input: 'c', op: { type: 'order', field: 'valid_from', direction: 'asc' } },
  };
  return {
    version: 1,
    root: 't',
    operators,
    maxRounds: DEFAULT_MAX_ROUNDS,
    queryType: f.queryType,
    queryFeatures: featuresShape(f),
  };
}

function planCurrentState(f: QueryFeatures, nowIso: string): Plan | null {
  if (f.properNouns.length < 1) return null;
  // Stage 1 current-state path requires a predicate hint so legacy retrieve
  // keeps owning generic identity questions ("Who is Joe?", "What does X do?")
  // that the planner can't usefully constrain. Lock §6.6 forbids regressing
  // single-hop, declining here is the safety valve.
  if (f.predicateHint === null) return null;
  const n1 = f.properNouns[0]!;
  const operators: Record<OperatorId, Operator> = {
    a: { kind: 'lookup', id: 'a', entity: n1, predicate: f.predicateHint },
    t: { kind: 'temporal', id: 't', input: 'a', op: { type: 'as_of', iso: nowIso } },
  };
  return {
    version: 1,
    root: 't',
    operators,
    maxRounds: DEFAULT_MAX_ROUNDS,
    queryType: f.queryType,
    queryFeatures: featuresShape(f),
  };
}

function planTemporal(f: QueryFeatures, _nowIso: string): Plan | null {
  if (f.properNouns.length < 1) return null;
  const n1 = f.properNouns[0]!;
  const yearMatch = f.temporalMarkers.find((m) => /^(?:19|20)\d{2}$/.test(m));
  // Fix 3: a generic temporal query with no explicit year must NOT slice to
  // as_of(now). as_of keeps only triples whose validity covers the anchor, so
  // anchoring to today drops every fact whose valid_to is in the past and is
  // the cause of near-empty temporal recall. Default to chronological order so
  // all entity-scoped facts survive and event_ordering can reason over them.
  const temporalOp = yearMatch
    ? { type: 'range' as const, from: `${yearMatch}-01-01`, to: `${yearMatch}-12-31` }
    : { type: 'order' as const, field: 'valid_from' as const, direction: 'asc' as const };
  const operators: Record<OperatorId, Operator> = {
    a: { kind: 'lookup', id: 'a', entity: n1, predicate: f.predicateHint },
    t: { kind: 'temporal', id: 't', input: 'a', op: temporalOp },
  };
  return {
    version: 1,
    root: 't',
    operators,
    maxRounds: DEFAULT_MAX_ROUNDS,
    queryType: f.queryType,
    queryFeatures: featuresShape(f),
  };
}

function featuresShape(f: QueryFeatures): Plan['queryFeatures'] {
  return {
    properNouns: f.properNouns,
    temporalMarkers: f.temporalMarkers,
    multiHopHint: f.multiHopHint,
  };
}
