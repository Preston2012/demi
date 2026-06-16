/**
 * Temporal operator: bi-temporal slice or sort over `valid_from` / `valid_to`.
 *
 * Three modes:
 *
 *   - `as_of`: keep triples whose validity interval covers the given iso.
 *     "Validity interval covers iso" means `valid_from <= iso` AND
 *     (`valid_to` is null OR `valid_to >= iso`). Triples with both ends
 *     null are kept (timeless attribute claims like "Caroline is a potter"
 *     are considered valid at every point in time).
 *
 *   - `range`: keep triples whose validity interval overlaps `[from, to]`.
 *     Open ranges (either bound omitted) extend to ±∞.
 *
 *   - `order`: sort triples by `valid_from` or `valid_to`. Nulls sort last.
 *
 * No filtering on the underlying assertion's lifecycle (deletion etc.);
 * the upstream lookup already excluded soft-deleted rows.
 */

import type { Temporal, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { operatorSpan } from './operator-span.js';

export async function executeTemporal(node: Temporal, ctx: OperatorContext): Promise<AssertionTriple[]> {
  return operatorSpan(
    'plan.temporal',
    async () => {
      const input = ctx.upstream.get(node.input) ?? [];
      const op = node.op;
      if (op.type === 'as_of') return input.filter((t) => coversAsOf(t, op.iso));
      if (op.type === 'range') return input.filter((t) => overlapsRange(t, op.from, op.to));
      // order
      return sortByField(input, op.field, op.direction);
    },
    { operator_id: node.id, kind: node.kind, op_type: node.op.type },
  );
}

function coversAsOf(t: AssertionTriple, iso: string): boolean {
  if (t.valid_from !== null && t.valid_from > iso) return false;
  if (t.valid_to !== null && t.valid_to < iso) return false;
  return true;
}

function overlapsRange(t: AssertionTriple, from: string | undefined, to: string | undefined): boolean {
  // Two intervals do NOT overlap iff one ends strictly before the other begins.
  // Nulls on the triple represent ±∞ (timeless or open-ended); `undefined` on
  // the query bound represents the same. We can't encode ±∞ as a string
  // sentinel because lexicographic order breaks ('+' is below '0' in ASCII),
  // so we handle nulls/undefineds with explicit branches.
  if (from !== undefined && t.valid_to !== null && t.valid_to < from) return false;
  if (to !== undefined && t.valid_from !== null && t.valid_from > to) return false;
  return true;
}

function sortByField(
  input: AssertionTriple[],
  field: 'valid_from' | 'valid_to',
  direction: 'asc' | 'desc',
): AssertionTriple[] {
  const dir = direction === 'asc' ? 1 : -1;
  return input.slice().sort((a, b) => {
    const av = field === 'valid_from' ? a.valid_from : a.valid_to;
    const bv = field === 'valid_from' ? b.valid_from : b.valid_to;
    // Nulls sort last regardless of direction.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}
