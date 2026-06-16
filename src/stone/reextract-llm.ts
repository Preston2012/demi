/**
 * LLM adapter for on-demand re-extraction (Tier 3).
 *
 * Provides a minimal `(prompt: string) => Promise<string>` function shaped
 * for `executeReextraction` in ./reextract.ts.
 *
 * S65 Sprint 1: routes through `src/llm/client.ts` (engine callLLM) so the
 * reextract path picks up:
 *   - prompt_cache_key (OpenAI prefix-cache routing)
 *   - cached_tokens telemetry
 *   - retry/fallback chain (DeepSeek, gpt-4.1-mini, etc.) on transient failure
 *   - the consolidated provider abstraction
 *
 * Model: REEXTRACT_MODEL env var (default gpt-4o-mini). Matches judge-tier
 * pricing since this is a fact-extraction task on short conversation chunks.
 *
 * Feature gate: guarded upstream by REEXTRACT_ENABLED=true inside
 * executeReextraction. If OPENAI_API_KEY is unset when reextract fires,
 * the engine client throws and reextract.ts catches + logs per-request so
 * the overall query does not fail.
 */

import { createLogger } from '../config.js';
import { callLLM } from '../llm/client.js';

const log = createLogger('reextract-llm');

const DEFAULT_MODEL = 'gpt-4.1-nano';
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 30_000;

// S65 Sprint 1: system prompt aligned with buildReextractionPrompt's expected
// output format. Earlier draft told the model to reply with "an empty string"
// which would have broken parseExtractionResponse(), that parser matches
// `FACT: <subject> | <claim>` lines. The system prompt now reinforces the
// user prompt's format instead of overriding it.
const REEXTRACT_SYSTEM_PROMPT =
  'You are a precise fact extractor. Follow the format and rules in the user prompt exactly. ' +
  'Output only FACT: lines in the requested shape. Do not include preamble, explanation, or anything else.';

/**
 * Build a `callLLM` function bound to the configured reextract model.
 * Shape: `(prompt: string) => Promise<string>`.
 *
 * Returns null if OPENAI_API_KEY is not configured, so callers can skip
 * wiring rather than deferring the error to first-call.
 */
export function createReextractCallLLM(): ((prompt: string) => Promise<string>) | null {
  if (!process.env.OPENAI_API_KEY) {
    log.warn('OPENAI_API_KEY not set; reextract callLLM disabled');
    return null;
  }
  const model = process.env.REEXTRACT_MODEL || DEFAULT_MODEL;
  const maxTokens = parseInt(process.env.REEXTRACT_MAX_TOKENS || String(DEFAULT_MAX_TOKENS), 10);
  const timeoutMs = parseInt(process.env.REEXTRACT_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

  return async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const text = await callLLM(model, REEXTRACT_SYSTEM_PROMPT, prompt, maxTokens, 0, {
        cacheKey: 'demiurge:reextract:v1',
        signal: controller.signal,
      });
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  };
}
