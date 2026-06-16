/**
 * S51: Lifted to src/llm/client.ts so engine code (src/answer/answer.ts,
 * src/core/dispatch.ts) can import without crossing into src/benchmark/.
 * This file remains as a back-compat re-export, every existing bench runner
 * imports `callLLM` from this path and continues to work unchanged.
 */
export { callLLM, callLLMWithConfidence } from '../llm/client.js';
export type { LLMConfidenceResult, CallLLMWithConfidenceOpts } from '../llm/client.js';
