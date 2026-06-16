/**
 * Filter operator: boolean filter over an upstream assertion set.
 *
 * Filter predicates are intentionally a small discriminated union so plans
 * stay JSON-serializable and the executor has no closures to deserialize.
 * Pattern matches on subject/predicate/object are string equality after
 * the decomposer's lowercased normalization; confidence_gte is numeric.
 */

import type { Filter, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { operatorSpan } from './operator-span.js';

export async function executeFilter(node: Filter, ctx: OperatorContext): Promise<AssertionTriple[]> {
  return operatorSpan(
    'plan.filter',
    async () => {
      const input = ctx.upstream.get(node.input) ?? [];
      const pred = node.predicate;
      return input.filter((t) => matches(t, pred));
    },
    { operator_id: node.id, kind: node.kind, predicate_type: node.predicate.type },
  );
}

function matches(t: AssertionTriple, pred: Filter['predicate']): boolean {
  switch (pred.type) {
    case 'predicate_eq':
      return t.predicate === pred.value;
    case 'subject_eq':
      return t.subject === pred.value;
    case 'object_eq':
      return t.object === pred.value;
    case 'confidence_gte':
      return t.confidence !== null && t.confidence >= pred.value;
  }
}
