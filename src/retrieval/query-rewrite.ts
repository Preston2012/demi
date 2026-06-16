/**
 * A4: multi-query rewrite for multi-hop retrieval.
 *
 * When `QUERY_REWRITE_ENABLED=true` and the query classifier returns
 * `multi-hop` or `temporal-multi-hop`, we generate N paraphrased variants
 * via a cached LLM call. The caller (src/retrieval/index.ts) runs lexical
 * search against each variant and unions the candidate pool so BM25 can
 * find facts that share variant wording but missed the original.
 *
 * Why lexical-only (vector stays on the original):
 *   Vector search already does semantic matching, embedding paraphrased
 *   queries would mostly hit the same chunks. The lift is for BM25 to
 *   reach facts whose phrasing differs from the original question.
 *
 * Why cached:
 *   Same query → same variants. `sha256(query)` is the cache key (via the
 *   shared CacheStore's extraction-cache table). Repeats are free.
 *
 * Failure mode:
 *   LLM call failure logs a warning and returns `[query]`. Retrieval
 *   degrades to "no rewrite," never crashes. Same for cache backend
 *   errors, they are swallowed; LLM is called instead.
 *
 * Flag: QUERY_REWRITE_ENABLED=true. Default OFF until bench mini
 * validates the lift. See AUDIT_FIXES_NOTES.md.
 */

import { callLLM } from '../llm/client.js';
import { getSharedCache } from '../cache/cache-store.js';
import { createLogger } from '../config.js';

const log = createLogger('query-rewrite');

const SYSTEM_PROMPT =
  "You generate alternative phrasings of the user's question. Keep the exact same meaning. Output one phrasing per line. No numbering, no bullet points, no markup, no commentary.";

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_VARIANTS = 2;
const CACHE_NAMESPACE = 'qrewrite';
const CACHE_VERSION = 'v1';

export function queryRewriteEnabled(): boolean {
  return process.env.QUERY_REWRITE_ENABLED === 'true';
}

export interface RewriteOptions {
  /** Number of paraphrase variants to request from the LLM. Default 2. */
  variants?: number;
  /** Override model. Falls back to QUERY_REWRITE_MODEL env, then DEFAULT_MODEL. */
  model?: string;
  /** Skip the persistent cache for tests that need a clean run. */
  noCache?: boolean;
}

/** Normalize for dedupe: lowercase + collapse internal whitespace + trim. */
function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse the LLM's raw output into a clean variants list.
 * - Strips numbering / bullets / quotes
 * - Drops empty lines
 * - Drops anything that, after normalization, equals the original
 * - Drops duplicates among the variants themselves
 * - Caps at `maxVariants` so a misbehaving LLM can't blow up the candidate pool
 */
function parseVariants(raw: string, original: string, maxVariants: number): string[] {
  const originalNorm = normalizeForDedupe(original);
  const seen = new Set<string>([originalNorm]);
  const out: string[] = [];
  for (const rawLine of raw.split('\n')) {
    // Strip common leading decorations: "1. ", "- ", "* ", '"', etc.
    const cleaned = rawLine
      .replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*|>\s*)/, '')
      .replace(/^["'`]|["'`]$/g, '')
      .trim();
    if (!cleaned) continue;
    const norm = normalizeForDedupe(cleaned);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(cleaned);
    if (out.length >= maxVariants) break;
  }
  return out;
}

/**
 * Generate paraphrased variants of a query for multi-hop retrieval.
 *
 * Returns:
 *   - `[]` when the flag is off (callers early-exit cleanly).
 *   - `[originalQuery, variant1, variant2, ...]` when on. Original is
 *     always position 0 so callers can iterate without a special case.
 *   - `[originalQuery]` (single element) when the LLM fails or the
 *     output has no usable variants, graceful degrade.
 */
export async function rewriteQuery(query: string, opts: RewriteOptions = {}): Promise<string[]> {
  if (!queryRewriteEnabled()) return [];

  const variants = Math.max(1, opts.variants ?? DEFAULT_VARIANTS);
  const model = opts.model ?? process.env.QUERY_REWRITE_MODEL ?? DEFAULT_MODEL;
  const promptVersion = `${CACHE_NAMESPACE}:${CACHE_VERSION}:n=${variants}`;

  // Cache lookup. Reuses the shared extraction-cache table -
  // promptVersion bumps invalidate the cache automatically, and the
  // shared cache already handles event recording / cost tracking.
  if (!opts.noCache) {
    try {
      const cache = getSharedCache();
      const cached = cache.getExtraction<string[]>(query, model, promptVersion);
      if (cached && Array.isArray(cached.facts)) {
        return cached.facts;
      }
    } catch (err) {
      // Cache failure must never break retrieval. Fall through to LLM.
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'qrewrite cache lookup failed');
    }
  }

  // LLM call. Temperature 0.7 gives genuine paraphrase diversity; lower
  // tends to echo the original. cacheKey is the per-prompt-class key for
  // OpenAI prompt-cache routing, separate from our content cache above.
  let raw: string;
  try {
    raw = await callLLM(model, SYSTEM_PROMPT, query, 200, 0.7, { cacheKey: 'demiurge:qrewrite:v1' });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'qrewrite LLM call failed; using original only',
    );
    return [query];
  }

  const parsed = parseVariants(raw, query, variants);
  const all = [query, ...parsed];

  // Best-effort cache write, same swallow-and-continue pattern. Don't
  // record cost (we'd need provider-specific pricing here).
  if (!opts.noCache && parsed.length > 0) {
    try {
      getSharedCache().putExtraction<string[]>(query, model, promptVersion, all, 0);
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'qrewrite cache write failed');
    }
  }

  return all;
}
