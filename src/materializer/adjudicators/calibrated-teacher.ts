/**
 * W4 Track A Stage 1: calibrated LLM teacher adjudicator.
 *
 * Drops into the W3 `AdjudicatorFn` hook. One LLM call per claim emits a
 * calibrated score plus structured reason codes (see design §2, §3, §4).
 * The hook signature is unchanged from W3 so flipping the
 * CALIBRATED_ADJUDICATOR_ENABLED flag is purely a runtime swap of the
 * adjudicator implementation; no schema or signature changes needed.
 *
 * Per design §10, Stage 2 (a local DistilBERT-scale classifier trained
 * on the telemetry corpus this module writes) is mandatory follow-up
 * work in W5 or W6. This Stage 1 teacher is scaffolding for Stage 2,
 * not the final product. Comments in the prompt module reiterate the
 * same.
 *
 * Failure mode (per design §5 + W3 doctrine): if the provider chain
 * exhausts, the adjudicator throws and the W3 materialize() wrapper
 * catches -> recordError(materializer.adjudicator_throw) -> fallback
 * accept with policy='fallback'. Availability over gating. The same
 * outcome applies if the response can't be parsed.
 *
 * S76 W4 Track A amendment: `contradicts_existing` retrieval is wired
 * by the materializer. The adjudicator consumes `input.priorMemories`
 * (pre-fetched top-K subject-scoped memories, see design §3) and
 * formats them into the prompt's EXISTING_RECENT_MEMORIES block.
 * Pre-fetching is owned by materialize() so timeout + error handling
 * stay centralized; the adjudicator just reads whatever the materializer
 * supplies (possibly empty when no userId, no subject, or on timeout).
 */

import { createHash } from 'node:crypto';

import { runProviderChain, ProviderChainExhaustedError } from '../../llm/provider-chain.js';
import { writeAdjudicationTelemetry } from '../../telemetry/adjudication-telemetry.js';
import { recordDecision, recordError } from '../../telemetry/index.js';

import {
  buildCalibratedTeacherPrompt,
  CALIBRATED_TEACHER_PROMPT_VERSION,
  isRejectionCode,
  REASON_CODES,
  type ReasonCode,
} from './calibrated-teacher-prompt.js';
import type { AdjudicatorFn, AdjudicationDecision, AdjudicationResult, PriorMemory } from '../types.js';

interface TeacherJsonResponse {
  score: number;
  reason_codes: string[];
  rule_hits: string[];
  rationale: string;
}

const SYSTEM_PROMPT =
  'You are a calibrated JSON-only adjudicator. Reply with exactly one JSON object matching the requested shape.';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseTeacherJson(raw: string): TeacherJsonResponse {
  // The chain may return text wrapped in markdown fences despite the
  // "reply with JSON only" instruction. Strip defensively.
  const cleaned = raw
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('teacher response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const score = clamp01(typeof obj.score === 'number' ? obj.score : Number(obj.score));
  const reason_codes = Array.isArray(obj.reason_codes)
    ? (obj.reason_codes.filter((c) => typeof c === 'string') as string[])
    : [];
  const rule_hits = Array.isArray(obj.rule_hits)
    ? (obj.rule_hits.filter((c) => typeof c === 'string') as string[]).slice(0, 3)
    : [];
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.split(/\s+/).slice(0, 25).join(' ') : '';
  return { score, reason_codes, rule_hits, rationale };
}

function filterReasonCodes(codes: string[]): ReasonCode[] {
  const known = new Set<string>(REASON_CODES);
  return codes.filter((c) => known.has(c)) as ReasonCode[];
}

/**
 * Map (score, reason_codes) to the W3 AdjudicationDecision contract.
 * Threshold band per design §4: score >= 0.7 admit, score <= 0.3 reject,
 * otherwise borderline (admit-with-caveat in v1). Rejection codes always
 * override score on the side of rejection - if the teacher flags
 * `pii_leak` at score 0.8, we still reject.
 */
function mapDecision(score: number, codes: ReasonCode[]): AdjudicationDecision {
  // Safety-first: if a rejection code fires, reject regardless of
  // score. The teacher's own scoring contract says it should not
  // produce (pii_leak at 0.85), but if it does, the rejection wins.
  if (codes.some(isRejectionCode)) return 'reject';
  if (score >= 0.7) return 'accept';
  if (score <= 0.3) return 'reject';
  return 'accept'; // v1 borderline (no rejection code) = accept-with-caveat
}

/**
 * Format a PriorMemory row as a single line for the EXISTING_RECENT_MEMORIES
 * block in the teacher prompt. Each line carries the claim text plus
 * the bi-temporal anchor (valid_from) so the teacher can ground the
 * `contradicts_existing` decision in time-ordered context. Lines stay
 * short to keep token cost bounded.
 *
 * Format: "<claim> [valid_from: <ISO date>]" or "<claim>" when valid_from
 * is null. Truncated to 200 chars per line so a chatty claim cannot
 * blow the prompt budget.
 */
function formatPriorMemory(m: PriorMemory): string {
  const head = m.claim.length > 200 ? m.claim.slice(0, 200) + '...' : m.claim;
  return m.valid_from ? `${head} [valid_from: ${m.valid_from.slice(0, 10)}]` : head;
}

/** Track A Stage 1 adjudicator implementation of the W3 hook. */
export const calibratedTeacherAdjudicator: AdjudicatorFn = async (input) => {
  const t0 = Date.now();
  const priorMemories = input.priorMemories ?? [];
  const existingTopK = priorMemories.map(formatPriorMemory);

  const prompt = buildCalibratedTeacherPrompt({
    rawWindow: input.rawText,
    claim: input.extractedClaims.map((c) => c.claim).join(' | '),
    subject: input.extractedClaims[0]?.subject,
    existingTopK,
  });

  let chain;
  try {
    chain = await runProviderChain(SYSTEM_PROMPT, prompt, {
      cacheKey: 'demiurge:track-a:calibrated-teacher:v1',
    });
  } catch (err) {
    const attempts = err instanceof ProviderChainExhaustedError ? err.attempts : [];
    recordError({
      error_type: 'materializer.provider_chain_exhausted',
      message: err instanceof Error ? err.message : String(err),
      tags: { source: 'calibrated-teacher', attempts: JSON.stringify(attempts) },
    });
    // Surface as throw so W3 materialize() applies its fallback-accept
    // policy with policy='fallback'. Availability over gating.
    throw err;
  }

  let parsed: TeacherJsonResponse;
  try {
    parsed = parseTeacherJson(chain.text);
  } catch (err) {
    recordError({
      error_type: 'materializer.calibrated_teacher_parse_fail',
      message: err instanceof Error ? err.message : String(err),
      tags: { source: 'calibrated-teacher', model_used: chain.model },
    });
    throw err;
  }

  const codes = filterReasonCodes(parsed.reason_codes);
  const acceptedClean = codes.includes('accepted_clean');
  const hasRejection = codes.some(isRejectionCode);

  // accepted_clean is mutually exclusive with rejection codes; drop it
  // if any rejection code fired. Per design §3.
  const finalCodes: ReasonCode[] = hasRejection
    ? codes.filter((c) => c !== 'accepted_clean')
    : acceptedClean
      ? ['accepted_clean']
      : codes;

  const decision = mapDecision(parsed.score, finalCodes);
  const latency = Date.now() - t0;

  const result: AdjudicationResult = {
    decision,
    policy: CALIBRATED_TEACHER_PROMPT_VERSION,
    score: parsed.score,
    reason_codes: finalCodes,
    rule_hits: parsed.rule_hits,
  };

  // recordDecision is also emitted inside materialize() with the W3
  // shape (decision_type='materializer.adjudication'); this extra
  // record carries the teacher-specific metadata for fast diagnostics
  // without joining against the JSONL corpus.
  recordDecision({
    decision_type: 'materializer.adjudication',
    branch_taken: decision,
    confidence: parsed.score,
    outcome: decision,
    inputs: {
      source: 'calibrated-teacher',
      model_used: chain.model,
      prompt_version: CALIBRATED_TEACHER_PROMPT_VERSION,
      reason_codes: finalCodes,
      attempts: chain.attempts.length,
      prior_memories_count: priorMemories.length,
    },
  });

  writeAdjudicationTelemetry({
    ts: new Date().toISOString(),
    engine_commit: process.env.DEMIURGE_GIT_COMMIT ?? 'unknown',
    prompt_version: CALIBRATED_TEACHER_PROMPT_VERSION,
    model_used: chain.model,
    raw_window_sha256: sha256Hex(input.rawText),
    raw_window_text: input.rawText.slice(0, 4096),
    claim_text: input.extractedClaims.map((c) => c.claim).join(' | '),
    claim_subject: input.extractedClaims[0]?.subject ?? '',
    existing_memory_count: priorMemories.length,
    existing_memory_subjects: priorMemories.map((m) => m.subject),
    teacher_score: parsed.score,
    reason_codes: finalCodes,
    rule_hits: parsed.rule_hits,
    rationale: parsed.rationale,
    latency_ms: latency,
    provider_chain_attempts: chain.attempts,
  });

  return result;
};
