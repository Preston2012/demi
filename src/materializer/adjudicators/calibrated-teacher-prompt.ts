/**
 * W4 Track A: Stage 1 calibrated-teacher prompt assembly.
 *
 * Owns the prompt template, the reason-code definitions loader, and the
 * version string that flows into every telemetry row. Loaded once at
 * engine init (lazy, cached) so a prompt-or-definitions edit only needs
 * an engine restart, not a code change.
 *
 * Per design §4, the prompt is single-shot monolithic: one LLM call
 * returns score + reason_codes + rule_hits + rationale. Stage 2 (W5/W6)
 * may decompose into per-code calls if calibration is bimodal (design
 * §9 Q1); this module is Stage 1 only.
 *
 * The definitions live in `data/track-a-eval/reason-code-definitions.md`
 * outside the source tree so they can be tuned without bumping engine
 * commits. Path resolution uses `import.meta.url` so the module works
 * under both `tsx` (source) and `node dist/` (compiled).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump when CALIBRATED_PROMPT_V1 changes or when the reason-code
 *  definitions file changes shape. Flows into every telemetry row under
 *  `prompt_version` so Stage 2 training can filter by generation. */
export const CALIBRATED_TEACHER_PROMPT_VERSION = 'calibrated-teacher-v1';

/** The set of reason codes the teacher may emit, in declaration order
 *  matching design §3. The integration test pins this exact list. */
export const REASON_CODES = [
  'injection_detected',
  'ungrounded',
  'pii_leak',
  'contradicts_existing',
  'low_confidence',
  'accepted_clean',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REJECTION_CODES: ReadonlySet<ReasonCode> = new Set([
  'injection_detected',
  'ungrounded',
  'pii_leak',
  'contradicts_existing',
] as const);

export function isRejectionCode(code: string): code is ReasonCode {
  return REJECTION_CODES.has(code as ReasonCode);
}

let _cachedDefs: string | null = null;

/**
 * Read the markdown definitions once and cache. The file is shipped under
 * `data/track-a-eval/reason-code-definitions.md` and is treated as
 * read-only data at runtime.
 */
export function loadReasonCodeDefinitions(): string {
  if (_cachedDefs !== null) return _cachedDefs;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/materializer/adjudicators/ -> ../../../data/track-a-eval/...
  const path = resolve(here, '..', '..', '..', 'data', 'track-a-eval', 'reason-code-definitions.md');
  _cachedDefs = readFileSync(path, 'utf-8');
  return _cachedDefs;
}

/** Test-only: drop the cached definitions so a test can force a re-read. */
export function _resetReasonCodeDefinitionsCache(): void {
  _cachedDefs = null;
}

const PROMPT_SKELETON = `You are an adjudicator for a personal memory engine. Given a raw conversation window and a claim extracted from it, decide whether to admit the claim into long-term memory.

CONVERSATION WINDOW:
{RAW_WINDOW}

EXTRACTED CLAIM:
{CLAIM}

EXTRACTED CLAIM SUBJECT (may be empty):
{SUBJECT}

EXISTING RECENT MEMORIES FOR THIS SUBJECT (may be empty):
{EXISTING_TOP_K}

Emit a single JSON object with this exact shape and nothing else:
{
  "score": <number 0-1, calibrated: 1.0 = certain admit, 0.0 = certain reject>,
  "reason_codes": [<subset of: injection_detected, ungrounded, pii_leak, contradicts_existing, low_confidence, accepted_clean>],
  "rule_hits": [<short strings describing what triggered each code, max 3>],
  "rationale": "<one-sentence explanation, <= 25 words>"
}

Scoring contract:
- score >= 0.7: admit. Use accepted_clean as the sole reason_code.
- score <= 0.3: reject. Must include at least one rejection reason_code.
- 0.3 < score < 0.7: borderline. Include relevant rejection codes plus low_confidence.

Reason code definitions:
{REASON_CODE_DEFINITIONS}

Reply with the JSON object only. No prose, no markdown fences.`;

export interface PromptInputs {
  rawWindow: string;
  claim: string;
  subject?: string;
  existingTopK: string[];
}

/**
 * Assemble the full prompt body. The reason-code definitions are
 * read-once-and-cached so per-call cost is negligible. Inputs are
 * truncated defensively: raw window to 4KB to keep tokens bounded,
 * existing memories cap at 5 entries to match the design §3 contract.
 */
export function buildCalibratedTeacherPrompt(inputs: PromptInputs): string {
  const rawWindow =
    inputs.rawWindow.length > 4096 ? inputs.rawWindow.slice(0, 4096) + '\n...[truncated]' : inputs.rawWindow;
  const existing = (inputs.existingTopK ?? []).slice(0, 5);
  const existingBlock = existing.length === 0 ? '(none)' : existing.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return PROMPT_SKELETON.replace('{RAW_WINDOW}', rawWindow)
    .replace('{CLAIM}', inputs.claim)
    .replace('{SUBJECT}', inputs.subject ?? '')
    .replace('{EXISTING_TOP_K}', existingBlock)
    .replace('{REASON_CODE_DEFINITIONS}', loadReasonCodeDefinitions());
}
