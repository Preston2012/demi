/**
 * Wedge 2: hybrid triple decomposer.
 *
 * `extractClaimsDetailed` (src/extract/index.ts:226) returns
 * `{claim: string, subject: string}`, no (predicate, object) split. To
 * populate `assertion_triples` at write time without adding new LLM calls,
 * this module decomposes the claim string deterministically against a small
 * grammar of high-frequency English assertion patterns. On a match we emit
 * one triple per pattern with `(subject, predicate, object)` populated. On
 * a miss we emit a single fallback row with `predicate = null`,
 * `object = null`, `object_literal = claim`.
 *
 * Every assertion produces at least one row. Predicate-typed joins work
 * where patterns hit; subject-only lookups always work (idx_triple_subject).
 *
 * The grammar grows in this file as new shapes earn their seat. Patterns
 * are tested in order, first match wins, so list more specific patterns
 * before more general ones.
 */

import type { AssertionTriple } from './types.js';
import { GRAMMAR } from './grammar.js';
import { resolveTemporal } from '../inject/temporal-parse-ir.js';

/** Inputs the decomposer fills in on each triple, copied from the memory row. */
export interface DecomposeMeta {
  assertion_id: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number | null;
  conflict_set_id: string | null;
}

/** Strip leading articles and trailing punctuation from a parsed object. */
function normalizeObject(raw: string): string {
  return raw
    .replace(/^(?:a|an|the)\s+/i, '')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .toLowerCase();
}

function normalizeSubject(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * P1: split a captured object phrase on conjunctions so a single
 * pattern hit emits one triple per object. LOCOMO shapes like
 * "Maria went to Spain and England" → two `visited` triples, one for
 * each country.
 *
 * Split tokens (case-insensitive, whitespace-bounded):
 *   - " and "
 *   - " & "
 *   - "; "
 *   - ", and "
 *
 * Bare ", " is NOT used as a split because plenty of legitimate single
 * objects contain commas ("San Francisco, California"). Operators can
 * always write "X and Y" explicitly.
 */
function splitObjects(raw: string): string[] {
  const parts = raw.split(/\s*(?:,\s*and\s+|;\s+|\s+and\s+|\s+&\s+)\s*/i);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * P1: resolve a captured `when` group through temporal-parse-ir so
 * prose like "on Tuesday" / "in November 2023" / "last week" turns
 * into an ISO date that the executor's temporal operator can filter on.
 *
 * Failure modes, all return the fallback (meta.valid_from):
 *   - empty / whitespace `when` group
 *   - resolveTemporal returns ok=false (no relative phrase / low conf)
 *   - missing anchor (no meta.valid_from to anchor against)
 *
 * The anchor is meta.valid_from when present, otherwise today's ISO.
 * For ingest-time triple writes the memory row's validFrom is already
 * resolved by the dispatch.ingest temporal-parse-ir step, so this is
 * a refinement on the resolved anchor.
 */
function resolveWhenPhrase(whenPhrase: string | undefined, fallback: string | null): string | null {
  if (typeof whenPhrase !== 'string') return fallback;
  const trimmed = whenPhrase.trim().replace(/[.,;:!?]+$/, '');
  if (trimmed.length === 0) return fallback;

  // Fast path: bare ISO date (YYYY-MM-DD) is already resolved. resolveTemporal
  // treats absolute dates as no-op (returns ok=false with reason
  // 'no_relative_phrase'), so we'd otherwise drop a perfectly good date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const anchor = fallback ?? new Date().toISOString();
  const r = resolveTemporal(trimmed, anchor);
  if (r.ok && r.atom && r.atom.resolvedDate) {
    return r.atom.resolvedDate;
  }
  return fallback;
}

/**
 * Strip the subject prefix from the claim, returning the remaining predicate
 * + object phrase. Returns null if the claim doesn't start with the subject
 * (e.g., the extractor used a different surface form). Falls back to running
 * patterns against the whole claim in that case.
 */
function stripSubjectPrefix(claim: string, subject: string): string {
  const trimmed = claim.trim();
  const lcClaim = trimmed.toLowerCase();
  const lcSubject = subject.trim().toLowerCase();
  if (lcSubject.length > 0 && lcClaim.startsWith(lcSubject)) {
    return trimmed.slice(lcSubject.length).replace(/^[\s,]+/, '');
  }
  // Possessive form: "Caroline's", strip subject + 's
  const possessive = `${lcSubject}'s`;
  if (lcSubject.length > 0 && lcClaim.startsWith(possessive)) {
    return trimmed.slice(possessive.length).replace(/^[\s]+/, '');
  }
  return trimmed;
}

/**
 * Decompose a claim string into one or more `AssertionTriple` rows.
 *
 * On pattern hit: emits one row with `(subject, predicate, object)` populated
 * and `object_literal` null. Some patterns (e.g., `visited X on YYYY-MM-DD`)
 * additionally override the row's `valid_from`.
 *
 * On miss: emits ONE fallback row with `predicate` and `object` null and
 * `object_literal` carrying the trimmed original claim.
 *
 * Deterministic, no I/O, no LLM calls.
 */
export function decomposeClaim(claim: string, subject: string, meta: DecomposeMeta): AssertionTriple[] {
  const normSubject = normalizeSubject(subject);
  const tail = stripSubjectPrefix(claim, subject);

  for (const entry of GRAMMAR) {
    const m = entry.claimRegex.exec(tail);
    if (!m || !m.groups) continue;
    const objectRaw = m.groups['object'];
    if (typeof objectRaw !== 'string' || objectRaw.trim().length === 0) continue;

    // P1: split conjunctions so "Spain and England" → two triples.
    const objects = splitObjects(objectRaw)
      .map(normalizeObject)
      .filter((o) => o.length > 0);
    if (objects.length === 0) continue;

    // valid_from priority (high to low):
    //   1. dateCapture from `valid_from_capture` group (legacy YYYY-MM-DD path)
    //   2. resolved date from `when` group via temporal-parse-ir
    //   3. meta.valid_from (the memory row's writeresolvedanchor)
    let valid_from: string | null = meta.valid_from;
    const dateCapture = m.groups['valid_from_capture'];
    if (typeof dateCapture === 'string' && dateCapture.length > 0) {
      valid_from = dateCapture;
    } else if (entry.populatesValidFrom) {
      valid_from = resolveWhenPhrase(m.groups['when'], meta.valid_from);
    }

    return objects.map((object) => ({
      assertion_id: meta.assertion_id,
      subject: normSubject,
      predicate: entry.predicate,
      object,
      object_literal: null,
      valid_from,
      valid_to: meta.valid_to,
      confidence: meta.confidence,
      conflict_set_id: meta.conflict_set_id,
    }));
  }

  // Fallback: subject-only row. Predicate joins skip these; subject lookups find them.
  return [
    {
      assertion_id: meta.assertion_id,
      subject: normSubject,
      predicate: null,
      object: null,
      object_literal: claim.trim(),
      valid_from: meta.valid_from,
      valid_to: meta.valid_to,
      confidence: meta.confidence,
      conflict_set_id: meta.conflict_set_id,
    },
  ];
}

/**
 * Compute the cluster anchor uuid for a triple write.
 *
 * `assertion_id` is the new memory row; `conflicts_with` is the array
 * already populated by trust-branching at write time. The anchor is the
 * lexicographically-lowest uuid in the cluster, so every member of the
 * cluster computes the same anchor and `idx_triple_conflict` becomes an
 * O(log n) equality lookup.
 */
export function computeConflictAnchor(assertion_id: string, conflicts_with: string[]): string {
  if (conflicts_with.length === 0) return assertion_id;
  const cluster = [assertion_id, ...conflicts_with].slice().sort();
  // cluster has length ≥ 1; sort() is in place but slice() guards the caller's array.
  return cluster[0] as string;
}
