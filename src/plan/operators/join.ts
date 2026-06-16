/**
 * Join operator: relational join over two upstream assertion sets.
 *
 * Implements the four join modes:
 *
 *   - 'object=subject': left.object == right.subject  (graph hop forward)
 *   - 'subject=object': left.subject == right.object  (graph hop backward)
 *   - 'subject=subject': intersection on subject
 *   - 'object=object':   intersection on object
 *
 * The join result emits the RIGHT triples that matched, since the typical
 * use case is "given left as the bridge, what does the chained side reveal?"
 *, the right side carries the substantive answer in graph hops. Subjects
 * are normalized lowercase by the decomposer, so direct string equality
 * is the join condition.
 *
 * Fallback rows (predicate=null, object=null) participate only in joins
 * keyed on `subject` since the other fields are null.
 */

import type { Join, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { operatorSpan } from './operator-span.js';

export async function executeJoin(node: Join, ctx: OperatorContext): Promise<AssertionTriple[]> {
  return operatorSpan(
    'plan.join',
    async () => {
      const left = ctx.upstream.get(node.left) ?? [];
      const right = ctx.upstream.get(node.right) ?? [];
      if (left.length === 0 || right.length === 0) return [];

      const index = new Map<string, AssertionTriple[]>();
      const keyOnRight = rightKeyForMode(node.on);
      for (const r of right) {
        const k = keyOnRight(r);
        if (k === null) continue;
        const bucket = index.get(k);
        if (bucket) bucket.push(r);
        else index.set(k, [r]);
      }

      const out: AssertionTriple[] = [];
      const keyOnLeft = leftKeyForMode(node.on);
      for (const l of left) {
        const k = keyOnLeft(l);
        if (k === null) continue;
        const matches = index.get(k);
        if (!matches) continue;
        for (const m of matches) out.push(m);
      }
      return out;
    },
    { operator_id: node.id, kind: node.kind, on: node.on },
  );
}

function leftKeyForMode(mode: Join['on']): (t: AssertionTriple) => string | null {
  switch (mode) {
    case 'object=subject':
      return (t) => t.object;
    case 'subject=subject':
      return (t) => t.subject;
    case 'object=object':
      return (t) => t.object;
    case 'subject=object':
      return (t) => t.subject;
  }
}

function rightKeyForMode(mode: Join['on']): (t: AssertionTriple) => string | null {
  switch (mode) {
    case 'object=subject':
      return (t) => t.subject;
    case 'subject=subject':
      return (t) => t.subject;
    case 'object=object':
      return (t) => t.object;
    case 'subject=object':
      return (t) => t.object;
  }
}
