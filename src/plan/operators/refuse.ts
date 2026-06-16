/**
 * Refuse operator: terminating refusal. The executor short-circuits the
 * topological walk when this fires and surfaces the refusal in the
 * MemoryPacket. The returned triple list is always empty; the structured
 * refusal lives on the packet itself.
 */

import type { Refuse, AssertionTriple } from '../types.js';
import { operatorSpan } from './operator-span.js';

export async function executeRefuse(node: Refuse): Promise<AssertionTriple[]> {
  return operatorSpan('plan.refuse', async () => [], { operator_id: node.id, kind: node.kind, reason: node.reason });
}
