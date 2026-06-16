/**
 * S65 Sprint 1, smoke test for prompt-cache observability.
 *
 * Hits OpenAI / Mistral / DeepSeek with a tiny prompt, twice each with the
 * same cacheKey. Verifies:
 *   - call goes through callLLM
 *   - getLLMCacheStats() captures promptTokens
 *   - cachedTokens may or may not appear (≥1024 tokens needed for OpenAI hit)
 *
 * Not a benchmark of cache hit rate, just a wiring check. Run on CAX11
 * with .env loaded: `set -a && source .env && set +a && tsx scripts/smoke-cache-stats.ts`
 */
import { callLLM, getLLMCacheStats, resetLLMCacheStats } from '../src/llm/client.js';

async function main(): Promise<void> {
  resetLLMCacheStats();

  const system = 'You are a single-letter responder. Always reply with exactly one letter, no punctuation.';
  const user = 'Reply with the letter X.';

  const targets: Array<{ model: string; needsKey: string }> = [
    { model: 'gpt-4o-mini', needsKey: 'OPENAI_API_KEY' },
    { model: 'mistral-small-latest', needsKey: 'MISTRAL_API_KEY' },
    { model: 'deepseek-chat', needsKey: 'DEEPSEEK_API_KEY' },
  ];

  for (const { model, needsKey } of targets) {
    if (!process.env[needsKey]) {
      console.log(`SKIP ${model} (${needsKey} not set)`);
      continue;
    }
    try {
      const t0 = Date.now();
      const r1 = await callLLM(model, system, user, 5, 0, false, { cacheKey: 'demiurge:smoke:v1' });
      const t1 = Date.now();
      const r2 = await callLLM(model, system, user, 5, 0, false, { cacheKey: 'demiurge:smoke:v1' });
      const t2 = Date.now();
      console.log(
        `OK   ${model.padEnd(24)} call1=${t1 - t0}ms call2=${t2 - t1}ms reply1='${r1.trim().slice(0, 10)}' reply2='${r2.trim().slice(0, 10)}'`,
      );
    } catch (err) {
      console.log(`FAIL ${model}: ${(err as Error).message}`);
    }
  }

  const stats = getLLMCacheStats();
  console.log('\n--- LLM cache stats ---');
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
