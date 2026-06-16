/**
 * W4 Track B L2: retrieval-time per-memory injection scanner.
 *
 * Spec: docs/internal/WEDGE_4_TRACK_B_DESIGN.md §3.1.
 *
 * Runs the existing write-time injection patterns over each retrieved memory at
 * read time, catching memories that bypassed L1 (write-time adjudication) - for
 * example a memory edited post-write or imported via a path that skipped the
 * write validators. Matching memories are dropped (refusal-equivalent: they do
 * not reach the answer model). v1 is a drop, not a rewrite; in-place redaction
 * is NULL_REDACTOR territory (W6+).
 *
 * Uses the pure {@link matchInjectionPatterns} predicate (not detectInjection)
 * so the read path records its own `read_injection_l2` decision and never emits
 * write-path `detect_injection` rows.
 */

import { matchInjectionPatterns } from '../../write/validators.js';
import { recordDecision } from '../../telemetry/index.js';
import type { CompiledMemory } from '../../schema/memory.js';

/**
 * Return the memories that survive L2 (clean). Drops and records any that match
 * an injection pattern. Pure with respect to its input array (returns a new
 * array; does not mutate).
 */
export function applyL2Defense(memories: CompiledMemory[]): CompiledMemory[] {
  const survivors: CompiledMemory[] = [];
  for (const mem of memories) {
    const hit = matchInjectionPatterns(mem.claim);
    if (hit.matched) {
      recordDecision({
        decision_type: 'read_injection_l2',
        branch_taken: 'drop',
        outcome: 'injection_detected',
        inputs: { pattern: hit.label, memoryId: mem.id, stage: 'retrieval-scan' },
      });
      continue; // drop: do not add to survivors
    }
    survivors.push(mem);
  }
  return survivors;
}
