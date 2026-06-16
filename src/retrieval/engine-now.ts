/**
 * S65 Sprint 1, engine "now" anchor with bench-mode pin.
 *
 * The engine has four wall-clock fallback points in retrieval (sql-first,
 * index) where `nowOverride ?? new Date().toISOString()` returns the live
 * server clock when no caller-supplied anchor is present. That wall-clock
 * leak busts retrieval-cache hits across iteration cycles, the cache key
 * derives from the prompt and the prompt embeds the "now" anchor in
 * bi-temporal filtering, RRF reference, freshness scoring, and reranker
 * recency math.
 *
 * `engineNow()` returns:
 *   1. `BENCH_NOW_ISO` env var if set (the bench-mode pin)
 *   2. Otherwise `new Date().toISOString()` (server wall-clock; production)
 *
 * Bench runners that don't already set per-conversation `nowIso` should
 * either:
 *   (a) pass `nowIso` through dispatch.search/dispatch.answer (preferred -
 *       per-conversation determinism), or
 *   (b) export `BENCH_NOW_ISO` once at the top of the runner so every
 *       fallback path resolves to the same anchor for the whole run.
 *
 * Production callers (MCP, REST) leave both unset → server wall-clock.
 *
 * Validation: an invalid BENCH_NOW_ISO falls back to wall-clock with a
 * one-time warning. We never throw on a bad env var because that would take
 * down a production process if someone accidentally exported it.
 */

let warned = false;

export function engineNow(): string {
  const pin = process.env.BENCH_NOW_ISO;
  if (pin && pin.length > 0) {
    // Cheap validity check: must be parseable as a Date.
    const parsed = Date.parse(pin);
    if (!Number.isNaN(parsed)) {
      return pin;
    }
    if (!warned) {
      // eslint-disable-next-line no-console
      console.error(
        `[engineNow] BENCH_NOW_ISO set to invalid value '${pin}', falling back to wall-clock. Fix or unset.`,
      );
      warned = true;
    }
  }
  return new Date().toISOString();
}

/**
 * Same as engineNow() but returns a Date object. For freshness scoring and
 * reranker recency math which want millis arithmetic, not ISO parsing every
 * candidate.
 */
export function engineNowDate(): Date {
  return new Date(engineNow());
}
