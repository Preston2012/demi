/**
 * Golden Retrieval Stack default-ON helpers.
 *
 * The Tier-1 golden stack (EPISODES_ENABLED, ENTITY_SPLIT_TEMPORAL,
 * ENTITY_BOOST_ENABLED, BI_TEMPORAL_ENABLED, HYBRID_FUSION_MODE=additive) is
 * permanent-on in both the iteration baseline and prod. It used to default OFF
 * and had to be exported on every run; when forgotten the baseline silently
 * dropped ~4pp (an ENTITY_SPLIT_TEMPORAL miss reproduced 51.0 vs the 55.4
 * baseline twice in S77). These flags now default ON in code so neither bench
 * nor prod can silently miss them.
 *
 * The locked decision (I-277 / A-162) bans `=== 'false'` as a disable check.
 * The correct default-ON idiom is `!== 'false'`: on unless explicitly the
 * string 'false'. This is the single source of that truth: every default-on
 * flag site and the bench manifest read through these helpers, so the engine's
 * effective config and the recorded config cannot diverge.
 */

/** Default-ON boolean flag: true unless explicitly the string 'false'. */
export function onByDefault(v: string | undefined): boolean {
  return v !== 'false';
}

/** Default-OFF boolean flag (existing convention, for reference / symmetry). */
export function offByDefault(v: string | undefined): boolean {
  return v === 'true';
}

/**
 * Strict boolean env parse (R29-WC-1). z.coerce.boolean() maps
 * Boolean('false') === true, silently inverting the `X=false` escape hatch on
 * every coerced flag. This accepts ONLY 'true'/'false' (case-insensitive,
 * trimmed); unset or empty falls back to `defaultValue`. Returns `null` for any
 * other token so the caller rejects it loudly instead of guessing.
 */
export function parseStrictBool(v: string | undefined, defaultValue: boolean): boolean | null {
  if (v === undefined) return defaultValue;
  const s = v.trim().toLowerCase();
  if (s === '') return defaultValue;
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/**
 * Legacy z.coerce.boolean() semantics, kept ONLY so the boot audit log can diff
 * the old coercion against the strict parse (WC-1). Never use for live gating.
 */
export function legacyCoerceBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined) return defaultValue;
  return Boolean(v);
}
