/**
 * Production extraction module.
 *
 * Owns the canonical extraction prompts and the LLM-call shape used by both
 * `dispatch.ingest()` (production write path) and `src/benchmark/longmemeval-extractor.ts`
 * (legacy bench path). Pre-Phase-1B both lived inside the LME extractor; Phase 1B
 * hoists the prompt + extraction shape into a production module so the public
 * `dispatch.ingest()` API can call the same pipeline a real user would.
 *
 * Two prompt families:
 *  - Single-user (EXTRACTION_PROMPT): for assistant-style chat where one
 *    participant is "the user" and the other is the assistant. Default.
 *  - Multi-speaker (MULTI_SPEAKER_EXTRACTION_PROMPT): for dialogues between
 *    two or more named human participants (e.g. LOCOMO Caroline ↔ Melanie).
 *    Subject becomes "<speaker>:<category>" so retrieval can filter by both
 *    who-the-claim-is-about and what-kind-of-claim.
 *
 * Selection is via opts.multiSpeaker. The two families maintain independent
 * cache namespaces so stored extractions never cross-contaminate.
 *
 * Design: stateless function. No I/O outside the LLM call + persistent cache.
 * Caller threads a model + opts; result is the parsed claim list.
 *
 * Cache namespace policy: callers pass a `promptVersion` string that controls
 * the local persistent extraction cache key. Existing callers (LME extractor)
 * keep their pre-Phase-1B namespace ('lme-extractor-v1') so warm caches remain
 * valid across the refactor. New callers (dispatch.ingest) default to
 * DEFAULT_EXTRACTION_PROMPT_VERSION ('extract-v1'). Multi-speaker callers
 * default to MULTI_SPEAKER_PROMPT_VERSION (bumped to 'multi-speaker-v4_3-minimal' after
 * S65 Phase 1B conv-0 smoke caught over-eager paraphrastic extraction in v1).
 */

import { runProviderChain } from '../llm/provider-chain.js';
import { chainForCell } from '../llm/cells.js';
import { getSharedCache } from '../cache/cache-store.js';
import { span } from '../telemetry/index.js';

/**
 * Default cache namespace for the single-user extraction prompt. Bump when
 * EXTRACTION_PROMPT changes to invalidate that namespace's persistent cache.
 * Don't bump for non-prompt code edits.
 *
 * Callers can override via opts.promptVersion. The LME bench extractor passes
 * 'lme-extractor-v1' to preserve its existing warm cache.
 */
export const DEFAULT_EXTRACTION_PROMPT_VERSION = 'extract-v3-speaker';

/**
 * Default cache namespace for the multi-speaker extraction prompt. Separate
 * from the single-user namespace so the two families never share cache rows.
 * Bump when MULTI_SPEAKER_EXTRACTION_PROMPT changes.
 *
 * v1 over-extracted (~50% paraphrastic noise). v2 tightened to atomic
 * claims (avg 10.2 facts/session). v3-dated added TEMPORAL RESOLUTION
 * but dropped recall to 7.6/session (lost concrete preferences like
 * favorite pizza toppings). v4-dated-recall over-extracted at 17.4/session
 * (paraphrase bloat). v4_1-tight killed paraphrase chains but still
 * 19+/session. v4_2-tight added ONE-EVENT-ONE-CLAIM rule but model still
 * produced 18/session with 9 facts on one painting. v4_3-minimal: revert
 * to v3-dated and add one bullet explicitly listing concrete attribute
 * categories to RETAIN. Target: ~10-12 facts/session.
 */
export const MULTI_SPEAKER_PROMPT_VERSION = 'multi-speaker-v4_3-minimal';

/**
 * Single-user extraction prompt. For assistant-style chat where one
 * participant is "the user" and the other is the assistant.
 *
 * Phase 1B note: this prompt was lifted from the LME extractor where it has
 * been validated since S43E. Do NOT use it for dialogues between two named
 * humans (e.g. LOCOMO), use MULTI_SPEAKER_EXTRACTION_PROMPT instead, or
 * facts about the second participant get filtered out as "assistant
 * opinions" and information is silently halved.
 */
export const EXTRACTION_PROMPT = `Extract factual claims that the USER states about themselves or their world, or that the user explicitly confirms. The conversation is between the user and an assistant; treat the assistant's turns as context only, never as facts about the user. Output each fact as a JSON array of objects with "claim" and "subject" fields.

Rules:
- Each claim should be a single, self-contained factual statement
- Use the user's perspective: "User prefers X", "User works at Y"
- Include names, dates, numbers, preferences, relationships, locations
- Subject should be a short category: "workplace", "preferences", "relationships", "hobbies", "location", etc.
- TEMPORAL RESOLUTION: when a CONVERSATION DATE is provided above, resolve every relative time reference in the claims to an absolute calendar date. Replace "yesterday" / "today" / "last week" / "last Friday" / "two months ago" / "next month" with the actual date. Format: "on YYYY-MM-DD" or "in MONTH YYYY" or "in YYYY". Do NOT keep relative phrases in claims.
- Extract ONLY facts the user asserts or explicitly confirms. Do NOT extract anything the assistant says as a fact about the user: not the assistant's statements, facts, analysis, opinions, suggestions, or questions. If the assistant introduces a fact the user did not affirm, omit it. (Example: if the assistant says "Postgres would be a good fit" and the user never said it, do NOT output "User thinks Postgres is a good fit".)
- Do NOT include conversation metadata
- Output ONLY the JSON array, no markdown or explanation

Conversation:
`;

/**
 * Multi-speaker extraction prompt v4_3-minimal. For dialogues between two
 * or more named human participants where neither is "the user" in the
 * assistant sense (e.g. LOCOMO conversations between Caroline and Melanie).
 *
 * v4_3 strategy: minimal delta from v3-dated. Three iterations of v4.x
 * prompt-engineering (v4-dated-recall, v4_1-tight, v4_2-tight) all hit
 * diminishing returns, the model rationalized around every new rule and
 * over-extracted at 17-19 facts/session vs v2 baseline 10.2.
 *
 * Brain note #2135 identifies the v3-dated regression precisely: the
 * LLM became "too conservative, prunes peripheral but useful single-hop
 * facts", concrete preferences (Hawaiian pizza, cheese pizza, favorite
 * books) got dropped. v3-dated produces 7.6 facts/session vs v2's 10.2.
 *
 * v4_3 fix: revert to v3-dated prompt verbatim, add ONE tight bullet
 * explicitly listing the concrete-attribute categories that should be
 * RETAINED. No few-shot. No ONE-EVENT-ONE-CLAIM. No expanded DROP rules.
 * Just attribute-retention as one extra bullet.
 *
 * Cache namespace: 'multi-speaker-v4_3-minimal'.
 * Target: avg 10-12 facts/session, match v2 baseline + recover the
 * specific concrete preferences v3-dated was dropping.
 */
export const MULTI_SPEAKER_EXTRACTION_PROMPT = `Extract distinct factual claims from this conversation between named speakers. Output each fact as a JSON array of objects with "claim" and "subject" fields.

Rules:
- Each claim must be a single, atomic, factual statement attributable to a specific speaker
- Phrase the claim with the speaker's name as the grammatical subject ("Caroline is a transgender woman", "Melanie has two children")
- COLLAPSE paraphrastic restatements, if a speaker says the same thing 3 different ways within a session, output ONE claim, not 3
- Subject must be "SpeakerName:category" where category is a SHORT topic tag like identity, family, work, location, hobbies, relationships, health, education, beliefs (e.g. "Caroline:identity", "Melanie:family")
- Prefer concrete facts: identity attributes, locations, relationships, occupations, dates, owned things, completed events, preferences, named entities
- RETAIN every concrete preference, named entity, and owned thing mentioned by a speaker, even if mentioned briefly. This includes: favorite foods (Hawaiian pizza, cheese pizza), favorite books / movies / songs / artists, owned items (instruments, vehicles, gifts received, pets by name), named people (children's names, mentor names), and short factual mentions of named items
- TEMPORAL RESOLUTION: when a CONVERSATION DATE is provided above, resolve every relative time reference in the claims to an absolute calendar date. Replace "yesterday" / "today" / "last week" / "last Friday" / "two months ago" / "next month" with the actual date. Format: "on YYYY-MM-DD" or "in MONTH YYYY" or "in YYYY". Do NOT keep relative phrases in claims. Example: if conversation date is 2023-07-15 and a speaker says "I went to a workshop yesterday", the claim is "Melanie went to a pottery workshop on 2023-07-14", NOT "Melanie went to a pottery workshop yesterday". Only attach a date when the source utterance referred to a specific moment in time; do NOT invent dates for timeless attribute claims like "John likes cheese pizza".
- DROP emotional reactions and sentiment ("Caroline finds X freeing", "Melanie feels grateful")
- DROP cross-speaker reaction-claims ("Melanie congratulated Caroline", "Caroline respects Melanie's process")
- DROP hypotheticals, questions, suggestions, and small-talk
- Extract claims about ALL speakers, not just one
- Output ONLY the JSON array, no markdown or explanation

Conversation:
`;

export interface ExtractedClaim {
  claim: string;
  subject: string;
}

export interface ExtractClaimsOpts {
  /** Override extraction model. Default: gpt-4.1-nano if OPENAI key, else deepseek-chat, else gpt-4o-mini. */
  model?: string;
  /** OpenAI server-side prompt-cache key (M11 from S65 Sprint 1). NOT the local persistent cache key. Default: 'demiurge:extract:v1'. */
  cacheKey?: string;
  /**
   * Local persistent extraction cache namespace. Bump per-caller to invalidate
   * just that namespace. Defaults: 'extract-v1' for single-user prompt,
   * 'multi-speaker-v4_3-minimal' for multi-speaker prompt.
   */
  promptVersion?: string;
  /** Skip the persistent extraction cache for this call. Default: false (cache enabled). */
  bypassCache?: boolean;
  /**
   * Use the multi-speaker extraction prompt (MULTI_SPEAKER_EXTRACTION_PROMPT)
   * instead of the default single-user prompt (EXTRACTION_PROMPT). For
   * dialogues between named human participants (e.g. LOCOMO).
   *
   * When true, promptVersion defaults to MULTI_SPEAKER_PROMPT_VERSION so the
   * two prompt families never share cache rows. Callers that pass an explicit
   * promptVersion override that default.
   *
   * Default: false (single-user prompt).
   */
  multiSpeaker?: boolean;
  /**
   * ISO timestamp the conversation took place. When provided, prepended to
   * the prompt as a CONVERSATION DATE anchor and the prompt instructs the
   * LLM to resolve relative time references ("last week", "yesterday",
   * "next month") to absolute calendar dates inline in claim text.
   *
   * Without an anchor the LLM has no idea what "yesterday" means. With an
   * anchor, claims become date-resolved and retrievable on temporal queries.
   *
   * Cache key includes assertedAt so different conversation dates produce
   * different cache rows; same date hits cache as expected.
   *
   * Default: undefined (no anchor, prior un-anchored prompt behavior).
   */
  assertedAt?: string;
}

/**
 * Default extraction model picker. Mirrors the LME extractor's logic so
 * benches and production agree on default behavior.
 *
 * S65 cost-mitigation finish: gpt-4.1-nano per R19 council lock + brain #614.
 * ~4× cheaper than gpt-4.1-mini, equal quality on structured JSON extraction.
 */
export function defaultExtractionModel(): string {
  if (process.env.EXTRACTION_MODEL) return process.env.EXTRACTION_MODEL;
  if (process.env.OPENAI_API_KEY) return 'gpt-4.1-nano';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek-chat';
  return 'gpt-4o-mini';
}

function persistentExtractionCacheEnabled(): boolean {
  return process.env.DEMIURGE_EXTRACTION_CACHE !== 'false';
}

/**
 * Extract structured claims from raw conversation text.
 *
 * Returns an array of `{ claim, subject }` objects. Empty array on any
 * failure (LLM error, parse error, all-providers-fail). The function does
 * NOT throw on extraction failure; the contract is "best-effort, never
 * blocks the caller." Callers that need strict mode should check for
 * empty arrays and decide their own policy.
 *
 * For very short input (< 50 chars) returns [] immediately.
 *
 * Persistent cache hits skip the LLM call entirely. Cache key includes
 * (promptVersion, model, raw-text) so any change invalidates cleanly.
 */
/**
 * B4 (S71): discriminated result for {@link extractClaimsDetailed}.
 *
 * Tagged union distinguishing successful extraction from the three
 * failure modes that previously all returned `[]`:
 *
 *   - `short_input`: rawText < 50 chars, no LLM call attempted
 *   - `llm_error`: all providers failed (timeout, rate-limit cascade, etc.)
 *   - `parse_error`: LLM returned non-JSON or malformed shape
 *   - `success`: LLM returned valid JSON, claims array (may be empty if no
 *     extractable claims in input)
 *
 * Callers that need to distinguish "no claims" from "extraction failed"
 * should use {@link extractClaimsDetailed} instead of {@link extractClaims}.
 */
export type ExtractClaimsResult =
  | { ok: true; reason: 'success'; claims: ExtractedClaim[] }
  | { ok: false; reason: 'short_input' | 'llm_error' | 'parse_error'; claims: [] };

/**
 * Extract claims with discriminated result. Same logic as {@link extractClaims}
 * but returns a tagged union allowing callers to distinguish "no claims found"
 * from "extraction failed."
 *
 * Cache, prompt, and model semantics identical to extractClaims.
 */
export async function extractClaimsDetailed(
  rawText: string,
  opts: ExtractClaimsOpts = {},
): Promise<ExtractClaimsResult> {
  if (!rawText || rawText.trim().length < 50) {
    return { ok: false, reason: 'short_input', claims: [] };
  }

  return span(
    'extract.run',
    async () => {
      const model = opts.model ?? defaultExtractionModel();
      const cacheKey = opts.cacheKey ?? 'demiurge:extract:v1';
      const useMultiSpeaker = opts.multiSpeaker === true;
      const promptVersion =
        opts.promptVersion ?? (useMultiSpeaker ? MULTI_SPEAKER_PROMPT_VERSION : DEFAULT_EXTRACTION_PROMPT_VERSION);
      const promptHeader = useMultiSpeaker ? MULTI_SPEAKER_EXTRACTION_PROMPT : EXTRACTION_PROMPT;
      const dateAnchor = opts.assertedAt ? `CONVERSATION DATE: ${opts.assertedAt.slice(0, 10)}\n\n` : '';
      const prompt = dateAnchor + promptHeader + rawText;

      // Persistent cache hit short-circuits live LLM call.
      if (!opts.bypassCache && persistentExtractionCacheEnabled()) {
        try {
          const hit = getSharedCache().getExtraction<ExtractedClaim[]>(prompt, model, promptVersion);
          if (hit) return { ok: true, reason: 'success', claims: hit.facts };
        } catch {
          // cache miss/failure → fall through to live call
        }
      }

      // Lock-routing (S77): route extraction through the provider chain so the
      // 'extraction' cell emits cell_primary_used + provider_failover and gets
      // cross-provider failover, matching adjudicator + injection-l3. Bench
      // pinning (opts.model / EXTRACTION_MODEL) collapses to a single-element
      // chain with NO failover so the unrouted sweep stays valid.
      const pinned = Boolean(opts.model) || Boolean(process.env.EXTRACTION_MODEL);
      const chain = pinned ? [model] : chainForCell('extraction');
      let rawResponse: string;
      // The model that actually produced the facts (a fallback may have fired);
      // assigned in the try, and the catch returns, so it is always set below.
      let producedModel: string;
      try {
        const r = await runProviderChain(
          'You are a precise fact extractor. Reply only with valid JSON matching the requested shape.',
          prompt,
          { cell: 'extraction', chain, noFallback: pinned, maxTokens: 1500, temperature: 0, cacheKey },
        );
        rawResponse = r.text.trim();
        producedModel = r.model;
      } catch {
        return { ok: false, reason: 'llm_error', claims: [] };
      }

      try {
        const cleaned = rawResponse
          .replace(/^```json?\n?/m, '')
          .replace(/\n?```$/m, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) {
          return { ok: false, reason: 'parse_error', claims: [] };
        }

        const claims = (parsed as unknown[]).filter((c): c is ExtractedClaim => {
          if (typeof c !== 'object' || c === null) return false;
          const obj = c as Record<string, unknown>;
          return (
            typeof obj.claim === 'string' &&
            typeof obj.subject === 'string' &&
            obj.claim.length > 0 &&
            obj.subject.length > 0
          );
        });

        if (!opts.bypassCache && persistentExtractionCacheEnabled() && claims.length > 0) {
          try {
            // Key the write by the model that actually produced the facts (a
            // fallback may have fired), so the model-keyed cache stays correct.
            getSharedCache().putExtraction(prompt, producedModel, promptVersion, claims, 0);
          } catch {
            // non-fatal
          }
        }

        return { ok: true, reason: 'success', claims };
      } catch {
        return { ok: false, reason: 'parse_error', claims: [] };
      }
    },
    { text_len: rawText.length },
  );
}

/**
 * Back-compat wrapper around {@link extractClaimsDetailed}. Returns just the
 * claims array, dropping the discriminated reason. Returns [] for all
 * failure modes, the original behavior.
 *
 * New code should prefer extractClaimsDetailed.
 */
export async function extractClaims(rawText: string, opts: ExtractClaimsOpts = {}): Promise<ExtractedClaim[]> {
  const result = await extractClaimsDetailed(rawText, opts);
  return result.claims;
}
