/**
 * Bench judge cache helper (S65 Sprint 1, M9).
 *
 * Wraps the judge call so deterministic (model, system, user, predicted)
 * tuples hit the persistent CacheStore before the LLM. This is the single
 * biggest free win on bench iteration: every re-run of a stable result set
 * skips the judge entirely, and benches that re-run with the same answer
 * model produce identical predicted strings → cache hits stack.
 *
 * Determinism contract: temperature 0 everywhere. The judge cache assumes
 * the LLM is deterministic for these inputs. If you ever flip a judge to
 * non-zero temperature you MUST bump the cacheTag to invalidate.
 *
 * Toggle: set DEMIURGE_JUDGE_CACHE=false to bypass entirely (e.g. when
 * deliberately re-judging with the same key to detect API drift).
 */

import { callLLM } from './llm-caller.js';
import { getSharedCache } from '../cache/cache-store.js';

export interface JudgeCallOpts {
  /** Model to call. Caller still owns model selection. */
  model: string;
  /** System prompt. Stable across calls of the same kind. */
  system: string;
  /** User prompt. Includes question, gold, predicted. */
  user: string;
  /** The predicted answer being judged. Folded into cache key. */
  predicted: string;
  /** Bench-level tag (e.g. 'locomo' / 'lme' / 'beam'). Folded into key. */
  cacheTag: string;
  /** Max output tokens. Default 10 for binary judges. */
  maxTokens?: number;
  /** Underlying callLLM cacheKey for OpenAI prefix-cache routing. */
  llmCacheKey?: string;
}

export interface JudgeCallResult {
  /** Lowercased trimmed verdict text. */
  verdict: string;
  /** True if the judge result came from the persistent cache. */
  cached: boolean;
}

function persistentJudgeCacheEnabled(): boolean {
  return process.env.DEMIURGE_JUDGE_CACHE !== 'false';
}

/**
 * Call the judge with a persistent cache layer. Returns the verdict and
 * whether it was a cache hit (for stats / cost telemetry).
 */
export async function callJudgeCached(opts: JudgeCallOpts): Promise<JudgeCallResult> {
  const cacheTag = `judge:${opts.cacheTag}`;
  const judgeModelTagged = `${cacheTag}:${opts.model}`;

  if (persistentJudgeCacheEnabled()) {
    try {
      const hit = getSharedCache().getJudgeResult(judgeModelTagged, opts.system, opts.user, opts.predicted);
      if (hit) {
        return { verdict: hit.verdict, cached: true };
      }
    } catch {
      // Fall through to live call. Cache must never break the bench.
    }
  }

  const raw = await callLLM(
    opts.model,
    opts.system,
    opts.user,
    opts.maxTokens ?? 10,
    0,
    opts.llmCacheKey ? { cacheKey: opts.llmCacheKey } : undefined,
  );
  const verdict = raw.toLowerCase().trim();

  if (persistentJudgeCacheEnabled()) {
    try {
      // Cost telemetry: 0 here since we don't have per-call token cost
      // visibility from llm-caller. Stats roll up rows × per-call cost
      // estimate at report time.
      getSharedCache().putJudgeResult(judgeModelTagged, opts.system, opts.user, opts.predicted, verdict, 0);
    } catch {
      // Best-effort; no-op on failure.
    }
  }

  return { verdict, cached: false };
}
