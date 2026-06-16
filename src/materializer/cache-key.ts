/**
 * Wedge 3: cache-key derivation for the materializations table.
 *
 * Contract (design §3.2):
 *   cache_key = sha256(
 *     "<conv_id>:<seq_start>:<seq_end>",
 *     policy_id,
 *     asof_anchor_truncated_to_minute,
 *   )
 *
 * Same minute → same key (two ingests in the same minute share work).
 * Different policy or different STONE window → different key (A/B native).
 *
 * Mirrors the length-prefix separator pattern from src/cache/cache-store.ts
 * to avoid trivial concatenation collisions (e.g. "ab|c" vs "a|bc").
 */

import { createHash } from 'node:crypto';

const SEP = '\x1f';

export interface CacheKeyInput {
  conversationId: string;
  seqStart: number;
  seqEnd: number;
  policyId: string;
  asOf: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
  const window = `${input.conversationId}:${input.seqStart}:${input.seqEnd}`;
  const minute = truncateToMinute(input.asOf);
  const h = createHash('sha256');
  h.update(window);
  h.update(SEP);
  h.update(input.policyId);
  h.update(SEP);
  h.update(minute);
  return h.digest('hex');
}

/**
 * Truncate an ISO8601 timestamp to minute resolution.
 *
 * "2026-05-18T12:34:56.789Z" -> "2026-05-18T12:34:00.000Z"
 *
 * Uses minute floor (not rounding) so 12:34:59.999 and 12:34:00.000 collapse
 * to the same key, but 12:35:00.000 starts a fresh row. See packet §3 test
 * cases "minute truncation pair" and "minute truncation distinct".
 */
export function truncateToMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Materializer: invalid asOf timestamp "${iso}"`);
  }
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}
