/**
 * W4 Track B sensitive-content router seam (NULL impl for v1).
 *
 * Spec: docs/internal/WEDGE_4_TRACK_B_DESIGN.md §3.3.
 *
 * v1 ships the interface plus a NULL implementation that allows everything.
 * Real sensitive-content routing (which model, which retention) is W6+. When
 * invoked the NULL impl records a `read_defense_null_stub` decision so the seam
 * is observable in telemetry.
 */

import type { InjectionPayload } from '../../schema/memory.js';
import { recordDecision } from '../../telemetry/index.js';

export type RouteDecision = 'allow' | 'block';

export interface SensitiveContentRouter {
  /**
   * Given a payload classification, decide where it may go. The v1 NULL impl
   * returns 'allow' for everything. The real impl (W6+) blocks or reroutes
   * sensitive classifications.
   */
  route(payload: InjectionPayload, classification: string): RouteDecision;
}

export const NULL_ROUTER: SensitiveContentRouter = {
  route(_payload: InjectionPayload, classification: string): RouteDecision {
    recordDecision({
      decision_type: 'read_defense_null_stub',
      branch_taken: 'router_allow',
      outcome: 'allow',
      inputs: { classification },
    });
    return 'allow';
  },
};
