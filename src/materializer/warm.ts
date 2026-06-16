/**
 * Wedge 3: eager-warm primitive.
 *
 * Calls materialize() across a batch of (conversationId, window) pairs to
 * pre-populate the cache. Tuning (which windows to warm, how often) is W4
 * scope; this module ships only the primitive plus a simple concurrency
 * limiter. A failure in one window does NOT abort the rest -- each failure
 * is captured in the returned result list.
 *
 * No CLI script in W3 (a 10-line wrapper). Defer to a follow-up.
 */

import { materialize } from './index.js';
import type { MaterializeOpts, MaterializedProjection } from './types.js';

export interface WarmResult {
  opts: MaterializeOpts;
  ok: boolean;
  projection?: MaterializedProjection;
  error?: string;
}

export interface WarmOptions {
  /** Maximum concurrent extract calls. Default 2. */
  concurrency?: number;
}

/**
 * Run materialize() across `batch` with bounded concurrency. Returns one
 * result per input; errors are captured rather than thrown so a single
 * pathological window doesn't poison the batch.
 */
export async function warmCacheForRecentWindow(
  batch: MaterializeOpts[],
  opts: WarmOptions = {},
): Promise<WarmResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const out: WarmResult[] = new Array(batch.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batch.length) {
      const i = cursor++;
      const item = batch[i];
      if (!item) continue;
      try {
        const projection = await materialize(item);
        out[i] = { opts: item, ok: true, projection };
      } catch (err) {
        out[i] = { opts: item, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
