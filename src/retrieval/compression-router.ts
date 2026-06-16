/**
 * Token-budget compression router.
 * Build order #5 (council-reconciled).
 *
 * Insight from Mastra (94.87% LME, zero retrieval):
 * If the conversation is small enough, skip retrieval entirely
 * and pass raw conversation context to the answer model.
 *
 * This is the hybrid path: use STONE for small convos (direct context),
 * compiled state for medium/large (standard retrieval).
 *
 * Flag: COMPRESSION_ROUTER_ENABLED=true
 * Threshold: COMPRESSION_ROUTER_MAX_TOKENS (default: 8000)
 */

import { createLogger } from '../config.js';
import type { StoneStore } from '../stone/index.js';

const log = createLogger('compression-router');

export interface CompressionRouterResult {
  /** If true, skip retrieval and use this context directly */
  skipRetrieval: boolean;
  /** Direct conversation context (if skipRetrieval is true) */
  directContext?: string;
  /** Reason for the routing decision */
  reason: string;
  /** Token estimate of the context */
  tokenEstimate: number;
}

/**
 * Rough token estimation (4 chars per token average for English).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Decide whether to skip retrieval and use direct STONE context.
 *
 * Decision logic:
 * 1. STONE must be enabled and have conversations
 * 2. Total conversation text must fit in budget
 * 3. Only for conversations below the token threshold
 */
export function routeByBudget(
  stone: StoneStore | null,
  conversationId: string | undefined,
  maxTokens = 8000,
): CompressionRouterResult {
  if (process.env.COMPRESSION_ROUTER_ENABLED !== 'true') {
    return { skipRetrieval: false, reason: 'router disabled', tokenEstimate: 0 };
  }

  if (!stone || !conversationId) {
    return { skipRetrieval: false, reason: 'no stone or conversation id', tokenEstimate: 0 };
  }

  try {
    const messages = stone.getMessages(conversationId);
    if (messages.length === 0) {
      return { skipRetrieval: false, reason: 'no messages in conversation', tokenEstimate: 0 };
    }

    // Build direct context from all messages
    const contextParts = messages.map(m => `[${m.role}]: ${m.content}`);
    const fullContext = contextParts.join('\n');
    const tokenEstimate = estimateTokens(fullContext);

    if (tokenEstimate <= maxTokens) {
      log.info({
        conversationId,
        messages: messages.length,
        tokenEstimate,
        maxTokens,
      }, 'Compression router: using direct context (small conversation)');

      return {
        skipRetrieval: true,
        directContext: fullContext,
        reason: `${messages.length} messages, ~${tokenEstimate} tokens fits budget`,
        tokenEstimate,
      };
    }

    log.debug({
      conversationId,
      tokenEstimate,
      maxTokens,
    }, 'Compression router: too large, using standard retrieval');

    return {
      skipRetrieval: false,
      reason: `~${tokenEstimate} tokens exceeds ${maxTokens} budget`,
      tokenEstimate,
    };
  } catch (err) {
    log.warn({ err, conversationId }, 'Compression router error, falling back to retrieval');
    return { skipRetrieval: false, reason: 'error', tokenEstimate: 0 };
  }
}

/**
 * Get the configured max token budget.
 */
export function getMaxTokenBudget(): number {
  return parseInt(process.env.COMPRESSION_ROUTER_MAX_TOKENS || '8000', 10);
}
