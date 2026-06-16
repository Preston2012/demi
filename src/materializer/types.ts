/**
 * Wedge 3: Materializer type surface.
 *
 * Shapes are taken verbatim from WEDGE_3_DESIGN.md §4 so W4 can swap the
 * pre_adjudicate implementation (calibrated model with non-null score and
 * expanded reason_codes) without touching this file or the materializations
 * table column shape.
 *
 * S76 amendment (W4 Track A): AdjudicatorInput grows a `priorMemories`
 * field carrying pre-fetched top-K subject-scoped memories. Optional so
 * the W3 default detectInjection adapter is unaffected. Calibrated
 * teacher uses it to populate `contradicts_existing` reason code.
 * Pre-fetching (rather than passing a callback) keeps timeout + error
 * handling centralized in the materializer.
 */

import type { ExtractedClaim } from '../extract/index.js';

export type AdjudicationDecision = 'accept' | 'reject' | 'quarantine';

export interface AdjudicationResult {
  decision: AdjudicationDecision;
  /** Policy version label, e.g. 'v1.detectInjection' in W3, 'v2.calibrated' in W4. */
  policy: string;
  /** Null in W3 (binary detectInjection). 0..1 in W4 calibrated model. */
  score: number | null;
  /** Structured codes for UX surface ('prompt_injection', 'pii', ...). */
  reason_codes: string[];
  /** Human-readable rule names. Maps 1:1 to the regex labels in W3. */
  rule_hits: string[];
}

/**
 * Pre-fetched prior memory carried in `AdjudicatorInput.priorMemories`.
 * Minimal projection: only what the adjudicator prompt actually needs.
 * Trust class, confidence, and other storage metadata are intentionally
 * excluded so the adjudicator cannot condition on them.
 */
export interface PriorMemory {
  claim: string;
  subject: string;
  valid_from: string | null;
}

export interface AdjudicatorInput {
  rawText: string;
  extractedClaims: ExtractedClaim[];
  stoneWindow: { conversationId: string; seqStart: number; seqEnd: number };
  asOf: string;
  userId?: string;
  /** S76 W4 Track A: top-K prior memories matching the leading claim's
   *  subject for the requesting user. Materializer fetches this before
   *  invoking the hook, scoped by (user_id, subject) with a 50ms
   *  timeout. Empty when no userId, no subject, no matches, on timeout,
   *  or on DB error (failure is silent and degrades only
   *  contradicts_existing recall). Adjudicators that do not consume
   *  this field (e.g. W3 detectInjection) ignore it. */
  priorMemories?: PriorMemory[];
}

export type AdjudicatorFn = (input: AdjudicatorInput) => Promise<AdjudicationResult>;

export interface MaterializeOpts {
  /** ISO8601. Required; bi-temporal anchor. Truncated to minute for cache-key derivation. */
  asOf: string;
  conversationId: string;
  stoneWindow: { seqStart: number; seqEnd: number };
  /** Omit to use 'default' (single-speaker) or 'default-multispeaker' (caller chooses). */
  policyId?: string;
  userId?: string;
  /** W3 default = detectInjection adapter. W4 swaps in calibrated model. */
  pre_adjudicate?: AdjudicatorFn;
}

export interface MaterializedProjection {
  /** Empty when adjudication rejected. */
  assertions: ExtractedClaim[];
  adjudication: AdjudicationResult;
  policyId: string;
  policyVersion: number;
  stoneWindow: { conversationId: string; seqStart: number; seqEnd: number };
  asOf: string;
  fromCache: boolean;
  cacheKey: string;
}

export interface MaterializationPolicy {
  policyId: string;
  version: number;
  promptTemplate: string;
  modelId: string;
  params: Record<string, unknown> | null;
  createdAt: string;
  retiredAt: string | null;
}
