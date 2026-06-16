/**
 * S51 Confidence extraction for LLM answers.
 *
 * Three sources, in priority order:
 *   1. logprobs  , provider returns token log-probabilities (OpenAI, xAI).
 *                   Confidence = exp(mean(logprob)) over answer tokens.
 *   2. self-report, provider asked to emit `<confidence>0.X</confidence>`
 *                   trailer (Anthropic, Gemini, Mistral, DeepSeek).
 *                   Tag stripped from returned text.
 *   3. linguistic, small local heuristic over the answer text. A self-contained
 *                   signal with no env-gate, so it never short-circuits to 1.0.
 *
 * Default 0.5 on extraction failure, never 1.0. 1.0 hides bugs.
 */

export type ConfidenceSource = 'logprobs' | 'self-report' | 'linguistic-fallback';

export interface LogprobToken {
  token: string;
  logprob: number;
}

export interface ConfidenceExtraction {
  confidence: number;
  source: ConfidenceSource;
  logprobs?: LogprobToken[];
}

export const SELF_REPORT_INSTRUCTION =
  'At the very end of your response, output exactly ' +
  '<confidence>0.X</confidence> where 0.X is your confidence in [0.0, 1.0] ' +
  '(0.0 = no idea, 1.0 = certain). Output the tag on its own at the end. Do not explain.';

const SELF_REPORT_RE = /<confidence>\s*([01](?:\.\d+)?)\s*<\/confidence>/i;

export function confidenceFromLogprobs(logprobs: LogprobToken[]): number {
  if (logprobs.length === 0) return 0.5;
  let sum = 0;
  for (const lp of logprobs) sum += lp.logprob;
  const mean = sum / logprobs.length;
  const conf = Math.exp(mean);
  if (!Number.isFinite(conf)) return 0.5;
  return Math.max(0, Math.min(1, conf));
}

export function parseSelfReport(text: string): { confidence: number | null; textWithoutTag: string } {
  const m = text.match(SELF_REPORT_RE);
  if (!m || m[1] === undefined) return { confidence: null, textWithoutTag: text };
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    return { confidence: null, textWithoutTag: text.replace(SELF_REPORT_RE, '').trim() };
  }
  return { confidence: v, textWithoutTag: text.replace(SELF_REPORT_RE, '').trim() };
}

const HEDGE_RE =
  /\b(I'?m not sure|I do not know|I don'?t know|I cannot determine|unclear|uncertain|hard to say|not (?:explicitly|clearly|directly) (?:mentioned|stated|indicated))\b/i;
const REFUSAL_RE =
  /\b(I (?:cannot|can'?t|am unable to) (?:answer|determine|find|provide)|no (?:information|data|context|mention|record) (?:about|regarding|on|for)|the (?:memory|context) does ?n'?t (?:contain|include|mention|provide))\b/i;
const VAGUE_RE = /\b(?:various|several|some|many|multiple) (?:things|activities|events|items)\b/i;

/**
 * Local linguistic-signal confidence. Self-contained with no env-gate, so it
 * never short-circuits to 1.0.
 */
export function confidenceFromLinguistic(answer: string, query: string, retrievedFactCount: number): number {
  let conf = 1.0;
  if (HEDGE_RE.test(answer)) conf -= 0.25;
  if (REFUSAL_RE.test(answer)) conf -= 0.35;
  if (VAGUE_RE.test(answer)) conf -= 0.15;

  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  const isComplexQuery = /\b(when|how|why|what happened|describe|explain|compare)\b/i.test(query);
  if (isComplexQuery && wordCount < 8) conf -= 0.2;

  if (retrievedFactCount < 2) conf -= 0.2;

  const queryEntities = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) ?? [];
  if (queryEntities.length > 0) {
    const mentions = queryEntities.some((e) => answer.includes(e));
    if (!mentions) conf -= 0.15;
  }

  return Math.max(0, Math.min(1, conf));
}

/**
 * Combine the three sources. Caller has already attempted logprob extraction
 * (provider-dependent) and produced a raw `{text, logprobs?}` plus the
 * tentative source label. This function decides the final {confidence,
 * source, textWithoutTag}.
 */
export function extractConfidence(
  raw: { text: string; logprobs?: LogprobToken[] },
  opts: { query: string; retrievedFactCount: number },
): { confidence: number; source: ConfidenceSource; text: string; logprobs?: LogprobToken[] } {
  if (raw.logprobs && raw.logprobs.length > 0) {
    return {
      confidence: confidenceFromLogprobs(raw.logprobs),
      source: 'logprobs',
      text: raw.text,
      logprobs: raw.logprobs,
    };
  }
  const parsed = parseSelfReport(raw.text);
  if (parsed.confidence !== null) {
    return { confidence: parsed.confidence, source: 'self-report', text: parsed.textWithoutTag };
  }
  const conf = confidenceFromLinguistic(raw.text, opts.query, opts.retrievedFactCount);
  return { confidence: conf, source: 'linguistic-fallback', text: raw.text };
}
