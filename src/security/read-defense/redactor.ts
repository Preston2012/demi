/**
 * W4 Track B redactor seam (NULL impl for v1).
 *
 * Spec: docs/internal/WEDGE_4_TRACK_B_DESIGN.md §3.3.
 *
 * v1 ships the interface plus a NULL implementation that returns the payload
 * unchanged. The real impl (W6+ Tier 2.5) rewrites offending spans in place.
 * The NULL impl exists so the W6 real-impl PR is a one-file swap, not a
 * re-architecture. When invoked it records a `read_defense_null_stub` decision
 * so the seam is observable in telemetry.
 */

import type { InjectionPayload } from '../../schema/memory.js';
import { recordDecision } from '../../telemetry/index.js';

/** A span that tripped a scanner, expressed against a specific memory. */
export interface DetectionSpan {
  memoryId: string;
  start: number;
  end: number;
  label: string | null;
}

export interface Redactor {
  /**
   * Given a payload + the spans that tripped a scanner, return a redacted
   * payload. The v1 NULL impl returns the payload unchanged. The real impl
   * (W6+) rewrites the offending spans.
   */
  redact(payload: InjectionPayload, spans: DetectionSpan[]): InjectionPayload;
}

export const NULL_REDACTOR: Redactor = {
  redact(payload: InjectionPayload, spans: DetectionSpan[]): InjectionPayload {
    recordDecision({
      decision_type: 'read_defense_null_stub',
      branch_taken: 'redactor_noop',
      outcome: 'noop',
      inputs: { spanCount: spans.length },
    });
    return payload;
  },
};
