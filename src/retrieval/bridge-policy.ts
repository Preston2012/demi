/**
 * Classifier-collapse (S77): the RETRIEVAL_BRIDGE_ALL gate.
 *
 * Default OFF (on only when `=== 'true'`). When on, the bridge / entity-split
 * deeper candidate set applies to ALL conversational queryTypes, not just
 * multi-hop / temporal-multi-hop. Extracted as a pure, dependency-free helper
 * so it is unit-testable without standing up the full retrieval stack.
 */

import type { QueryType } from './query-classifier.js';

/** The conversational queryTypes the bridge extends to when the flag is on. */
export const BRIDGE_ALL_CONVERSATIONAL_TYPES: ReadonlySet<QueryType> = new Set([
  'single-hop',
  'current-state',
  'coverage',
  'open-domain',
  'multi-hop',
]);

/** True when RETRIEVAL_BRIDGE_ALL is explicitly on AND the type is conversational. */
export function bridgeAllEnabled(queryType: QueryType): boolean {
  return process.env.RETRIEVAL_BRIDGE_ALL === 'true' && BRIDGE_ALL_CONVERSATIONAL_TYPES.has(queryType);
}
