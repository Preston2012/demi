/**
 * Multi-provider LLM caller for benchmarks.
 * Routes by model name prefix: gpt→OpenAI, claude→Anthropic, gemini→Google, grok→xAI
 *
 * S27: Retry + provider fallback + session-level health tracking.
 * - 1 retry on failure, then fallback to gpt-4.1-mini
 * - Fallback strips routing prompt suffixes
 * - After 3 consecutive failures from a provider, marks it DOWN for the session
 * - Subsequent calls skip the down provider entirely (zero latency penalty)
 */

import { canonicalize, isCanonicalizeEnabled } from '../answer/canonicalizer.js';

// ---------------------------------------------------------------------------
// Provider Health Tracking
// ---------------------------------------------------------------------------

const FINAL_FALLBACK = 'gpt-4.1-mini';

// Cascading fallback chains per primary model (R18 council consensus)
// Complex queries: reasoning model -> strong general -> cheap general
// Simple queries: cheap general -> alt cheap -> reasoning non-reasoning
const FALLBACK_CHAINS: Record<string, string[]> = {
  'grok-4-1-fast-reasoning': ['claude-sonnet-4-20250514', 'gpt-4.1-mini'],
  'grok-4-1-fast-non-reasoning': ['gpt-4.1-mini', 'gemini-2.5-flash'],
  'claude-sonnet-4-20250514': ['gpt-4.1-mini', 'grok-4-1-fast-reasoning'],
  'gpt-4.1-mini': ['gemini-2.5-flash', 'grok-4-1-fast-non-reasoning'],
  'gpt-4o-mini': ['gpt-4.1-mini', 'gemini-2.5-flash'],
  'gemini-2.5-flash': ['gpt-4.1-mini', 'gpt-4o-mini'],
};

function getFallbackChain(primaryModel: string): string[] {
  return FALLBACK_CHAINS[primaryModel] || [FINAL_FALLBACK];
}
const PROVIDER_DOWN_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 60_000; // T3: Recover after 60s instead of permanent ban

interface ProviderHealth {
  consecutiveFailures: number;
  isDown: boolean;
  downSince: number | null;
  totalFallbacks: number;
}

const providerHealth: Record<string, ProviderHealth> = {};

function getHealth(provider: string): ProviderHealth {
  if (!providerHealth[provider]) {
    providerHealth[provider] = { consecutiveFailures: 0, isDown: false, downSince: null, totalFallbacks: 0 };
  }
  const h = providerHealth[provider]!;
  // T3: Half-open recovery after cooldown period
  if (h.isDown && h.downSince && Date.now() - h.downSince > PROVIDER_COOLDOWN_MS) {
    h.isDown = false;
    h.consecutiveFailures = 0;
    h.downSince = null;
  }
  return h;
}

function recordSuccess(provider: string): void {
  const h = getHealth(provider);
  h.consecutiveFailures = 0;
  if (h.isDown) {
    console.error(`  [HEALTH] ${provider} recovered after ${h.totalFallbacks} fallbacks`);
    h.isDown = false;
    h.downSince = null;
  }
}

function recordFailure(provider: string): void {
  const h = getHealth(provider);
  h.consecutiveFailures++;
  h.totalFallbacks++;
  if (!h.isDown && h.consecutiveFailures >= PROVIDER_DOWN_THRESHOLD) {
    h.isDown = true;
    h.downSince = Date.now();
    console.error(
      `  [HEALTH] ${provider} marked DOWN after ${h.consecutiveFailures} consecutive failures. Routing disabled for this provider.`,
    );
  }
}

function isProviderDown(provider: string): boolean {
  return getHealth(provider).isDown;
}

function getProviderName(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'xai';
  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Routing Suffix Management
// ---------------------------------------------------------------------------

const ROUTING_SUFFIXES_TO_STRIP = ['Be concise. Answer in 1-2 sentences max. Do not explain your reasoning.'];

function stripRoutingSuffixes(prompt: string): string {
  let cleaned = prompt;
  for (const suffix of ROUTING_SUFFIXES_TO_STRIP) {
    cleaned = cleaned.replace(suffix, '').trim();
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Output Cleaning
// ---------------------------------------------------------------------------

function stripGrokOutput(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\(M\d+[^)]*\)/g, '')
    .replace(/\[M\d+[^\]]*\]/g, '')
    .replace(/\n\nFrom the memory context[\s\S]*/g, '')
    .replace(/\n\n---[\s\S]*/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Provider Dispatch
// ---------------------------------------------------------------------------

async function callProvider(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return callOpenAI(model, systemPrompt, userMessage, maxTokens, temperature);
  } else if (model.startsWith('gemini')) {
    return callGemini(model, systemPrompt, userMessage, maxTokens, temperature);
  } else if (model.startsWith('grok')) {
    return stripGrokOutput(await callXAI(model, systemPrompt, userMessage, maxTokens, temperature));
  } else {
    return callAnthropic(model, systemPrompt, userMessage, maxTokens, temperature);
  }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function callLLM(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 150,
  temperature: number = 0,
  skipCanonicalize: boolean = false,
): Promise<string> {
  const chain = [model, ...getFallbackChain(model)];
  let raw: string | undefined;
  let lastErr: unknown;

  for (const candidateModel of chain) {
    const provider = getProviderName(candidateModel);

    // Skip providers marked DOWN (zero latency penalty)
    if (isProviderDown(provider)) continue;

    // For fallback models, strip routing suffixes from prompt
    const prompt = candidateModel === model ? systemPrompt : stripRoutingSuffixes(systemPrompt);

    try {
      raw = await callProvider(candidateModel, prompt, userMessage, maxTokens, temperature);
      recordSuccess(provider);
      if (candidateModel !== model) {
        console.error();
      }
      break;
    } catch {
      // Retry once after 500ms on first attempt
      try {
        await new Promise((r) => setTimeout(r, 500));
        raw = await callProvider(candidateModel, prompt, userMessage, maxTokens, temperature);
        recordSuccess(provider);
        if (candidateModel !== model) {
          console.error();
        }
        break;
      } catch (retryErr) {
        recordFailure(provider);
        lastErr = retryErr;
        // Continue to next model in chain
      }
    }
  }

  if (raw === undefined) {
    throw lastErr || new Error();
  }

  return isCanonicalizeEnabled() && !skipCanonicalize ? canonicalize(raw) : raw;
}

// ---------------------------------------------------------------------------
// Provider Implementations
// ---------------------------------------------------------------------------

async function callOpenAI(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as any;
  return d.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as { content: Array<{ text: string }> };
  return d.content?.[0]?.text ?? '';
}

async function callGemini(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const isNoThink = model.endsWith('-nothink');
  const actualModel = isNoThink ? model.replace('-nothink', '') : model;
  const adjustedMaxTokens = isNoThink ? maxTokens : Math.max(maxTokens * 3, 300);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: adjustedMaxTokens,
        temperature,
        ...(isNoThink ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as any;
  return d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callXAI(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY not set');
  const adjustedMaxTokens = model.includes('reasoning') ? Math.max(maxTokens * 3, 450) : maxTokens;
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: adjustedMaxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`xAI ${r.status}: ${body.substring(0, 200)}`);
  }
  const d = (await r.json()) as any;
  return d.choices?.[0]?.message?.content ?? '';
}
