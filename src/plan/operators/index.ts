/**
 * Operator dispatch table. The executor calls `dispatchOperator` with the
 * node and shared context; the switch routes to the per-kind implementation.
 *
 * Every operator returns `AssertionTriple[]`. Aggregates emit a single
 * synthetic row (see `executeAggregate`). Refuse always returns `[]`; its
 * structured reason is read off the node itself by the executor.
 */

import type { Operator, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { executeLookup } from './lookup.js';
import { executeJoin } from './join.js';
import { executeFilter } from './filter.js';
import { executeAggregate } from './aggregate.js';
import { executeTemporal } from './temporal.js';
import { executeRefuse } from './refuse.js';

export { executeLookup, executeJoin, executeFilter, executeAggregate, executeTemporal, executeRefuse };
export { AGGREGATE_SUBJECT_SENTINEL } from './aggregate.js';
export type { OperatorContext } from './context.js';

export async function dispatchOperator(node: Operator, ctx: OperatorContext): Promise<AssertionTriple[]> {
  switch (node.kind) {
    case 'lookup':
      return executeLookup(node, ctx);
    case 'join':
      return executeJoin(node, ctx);
    case 'filter':
      return executeFilter(node, ctx);
    case 'aggregate':
      return executeAggregate(node, ctx);
    case 'temporal':
      return executeTemporal(node, ctx);
    case 'refuse':
      return executeRefuse(node);
  }
}
