/**
 * Aggregate operator: count / min / max / sum reducer.
 *
 * Stage 1 planner doesn't emit aggregates yet, the operator is in the
 * spec (packet §3) for completeness and lock-condition §6.3 (unit-test
 * coverage for every operator). Aggregates emit a single synthetic
 * AssertionTriple whose `object_literal` carries the stringified scalar
 * and whose `subject` is the sentinel `__aggregate__` so callers can
 * distinguish synthetic rows from real assertions. The other fields are
 * null.
 *
 * Keeping the executor's output type uniform (every operator returns
 * AssertionTriple[]) avoids a discriminated-union runtime contract that
 * would have to be checked everywhere a downstream operator reads
 * upstream output. The cost is a tiny synthetic row; the benefit is
 * type-uniform composition.
 */

import type { Aggregate, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { operatorSpan } from './operator-span.js';

export const AGGREGATE_SUBJECT_SENTINEL = '__aggregate__';

export async function executeAggregate(node: Aggregate, ctx: OperatorContext): Promise<AssertionTriple[]> {
  return operatorSpan(
    'plan.aggregate',
    async () => {
      const input = ctx.upstream.get(node.input) ?? [];
      const value = computeAggregate(node, input);
      return [
        {
          assertion_id: `${AGGREGATE_SUBJECT_SENTINEL}:${node.id}`,
          subject: AGGREGATE_SUBJECT_SENTINEL,
          predicate: node.fn,
          object: null,
          object_literal: String(value),
          valid_from: null,
          valid_to: null,
          confidence: null,
          conflict_set_id: null,
        },
      ];
    },
    { operator_id: node.id, kind: node.kind, fn: node.fn, field: node.field ?? null },
  );
}

function computeAggregate(node: Aggregate, input: AssertionTriple[]): number | string | null {
  if (node.fn === 'count') return input.length;
  if (input.length === 0) return null;

  // Numeric reducers operate on a field. Default field for non-count: confidence.
  const field = node.field ?? 'confidence';

  if (field === 'confidence') {
    const vals = input.map((t) => t.confidence).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    if (node.fn === 'min') return Math.min(...vals);
    if (node.fn === 'max') return Math.max(...vals);
    if (node.fn === 'sum') return vals.reduce((s, v) => s + v, 0);
  }

  // valid_from / valid_to are ISO strings; min/max do lexicographic compare.
  // 'sum' is meaningless on strings, return null (caller's plan was malformed).
  if (field === 'valid_from' || field === 'valid_to') {
    const vals = input
      .map((t) => (field === 'valid_from' ? t.valid_from : t.valid_to))
      .filter((v): v is string => v !== null);
    if (vals.length === 0) return null;
    if (node.fn === 'min') return vals.reduce((a, b) => (a < b ? a : b));
    if (node.fn === 'max') return vals.reduce((a, b) => (a > b ? a : b));
    if (node.fn === 'sum') return null;
  }

  return null;
}
