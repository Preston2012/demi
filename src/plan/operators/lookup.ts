/**
 * Lookup operator: fetch assertion triples by (subject, predicate),
 * (object, predicate), or predicate-only.
 *
 * Probes assertion_triples directly via the repository interface so the
 * SQL layer stays at the migration seam. The choice of index is governed
 * by `node.direction`:
 *
 *   - 'sp' (default): subject + predicate → idx_triple_sp
 *   - 'op':           object + predicate → idx_triple_op
 *
 * `entity` is optional. When undefined and `direction = 'sp'` the operator
 * scans by predicate only via idx_triple_sp's predicate prefix. When
 * `predicate` is null all predicates for the entity are returned
 * (including fallback rows, where predicate is NULL in the row).
 */

import type { Lookup, AssertionTriple } from '../types.js';
import type { OperatorContext } from './context.js';
import { operatorSpan } from './operator-span.js';

const LOOKUP_LIMIT = 256;

export async function executeLookup(node: Lookup, ctx: OperatorContext): Promise<AssertionTriple[]> {
  return operatorSpan(
    'plan.lookup',
    async () => {
      const direction = node.direction ?? 'sp';
      const predicate = node.predicate ?? null;
      const entity = node.entity ? node.entity.trim().toLowerCase() : undefined;

      if (direction === 'op') {
        if (entity === undefined) {
          // predicate-only scan via the object/predicate index.
          if (predicate === null) return [];
          return ctx.repo.searchTriplesByPredicate(predicate, LOOKUP_LIMIT);
        }
        return ctx.repo.searchTriplesByObject(entity, predicate, LOOKUP_LIMIT);
      }

      // direction === 'sp'
      if (entity === undefined) {
        if (predicate === null) return [];
        return ctx.repo.searchTriplesByPredicate(predicate, LOOKUP_LIMIT);
      }
      return ctx.repo.searchTriplesBySubject(entity, predicate, LOOKUP_LIMIT);
    },
    {
      operator_id: node.id,
      kind: node.kind,
      entity: node.entity ?? null,
      predicate: node.predicate ?? null,
      direction: node.direction ?? 'sp',
    },
  );
}
