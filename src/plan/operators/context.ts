/**
 * Shared operator-invocation context. Passed by the executor to every
 * operator's executor function. `upstream` holds the materialized output
 * of every previously-executed operator in the plan, keyed by id.
 */

import type { IMemoryRepository } from '../../repository/interface.js';
import type { AssertionTriple, OperatorId } from '../types.js';

export interface OperatorContext {
  repo: IMemoryRepository;
  /** Outputs of upstream operators that have already executed in topo order. */
  upstream: Map<OperatorId, AssertionTriple[]>;
  /** Anchor for temporal operators (`asOf`). ISO 8601. */
  nowIso: string;
  /** Packet 0 user partition for read scoping. */
  userId: string;
}
