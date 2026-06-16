/**
 * W4 Track E: shared provider-name resolver.
 *
 * Extracted from `client.ts` so the provider-availability layer and the
 * client can share a single prefix map without a circular import (the
 * availability layer needs the resolver, and the client needs the
 * availability filter). Behavior is identical to the original
 * `getProviderName` in client.ts, including the load-bearing default:
 * an unknown or typo'd model name maps to `anthropic`.
 */

export type Provider = 'openai' | 'anthropic' | 'xai' | 'deepseek' | 'google' | 'mistral';

/**
 * Map a model name to its provider by prefix.
 *
 *   gpt / o1 / o3 / o4 -> openai
 *   gemini             -> google
 *   grok               -> xai
 *   mistral            -> mistral
 *   deepseek           -> deepseek
 *   everything else    -> anthropic  (so a typo never silently routes to OpenAI)
 */
export function getProviderName(model: string): Provider {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('mistral')) return 'mistral';
  if (model.startsWith('deepseek')) return 'deepseek';
  return 'anthropic';
}
