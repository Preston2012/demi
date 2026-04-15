/**
 * Official LOCOMO benchmark seeder.
 *
 * Seeds pre-extracted facts into the Demiurge repository for a given
 * conversation. Uses the internal write pipeline for proper embedding
 * computation and indexing.
 */

import type { CoreDispatch } from '../core/dispatch.js';

export interface LocomoFact {
  claim: string;
  subject: string;
  session_id?: number;
  timestamp?: string;
  canonicalFactId?: string;
  isCanonical?: boolean;
}

export interface LocomoConversationFacts {
  conversation_index: number;
  facts: LocomoFact[];
}

/**
 * Seed facts for a single conversation into the Demiurge memory store.
 * Each fact is added via dispatch.addMemory for proper embedding + indexing.
 */
export async function seedConversationFacts(
  dispatch: CoreDispatch,
  facts: LocomoFact[],
  conversationIndex: number,
): Promise<number> {
  let seeded = 0;

  for (const fact of facts) {
    try {
      const result = await dispatch.addMemory({
        claim: fact.claim,
        subject: fact.subject || `locomo-conv-${conversationIndex}`,
        source: 'user',
        confidence: 0.95,
        canonicalFactId: fact.canonicalFactId,
        isCanonical: fact.isCanonical,
        validFrom:
          fact.timestamp && !isNaN(new Date(fact.timestamp).getTime())
            ? new Date(fact.timestamp).toISOString()
            : undefined,
      });
      if (result.action !== 'rejected') seeded++;
    } catch (seedErr: unknown) {
      console.error('SEED_ERROR:', seedErr instanceof Error ? seedErr.message : String(seedErr) || seedErr);
    }
  }

  return seeded;
}

/**
 * Compute token-level F1 score between predicted and expected answer.
 * Matches the original LOCOMO paper's evaluation methodology.
 */
export function computeF1(predicted: string, expected: string): number {
  const predTokens = String(predicted).toLowerCase().split(/\s+/).filter(Boolean);
  const expTokens = String(expected).toLowerCase().split(/\s+/).filter(Boolean);

  if (predTokens.length === 0 && expTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || expTokens.length === 0) return 0.0;

  const predSet = new Set(predTokens);
  const expSet = new Set(expTokens);

  let overlap = 0;
  for (const token of predSet) {
    if (expSet.has(token)) overlap++;
  }

  if (overlap === 0) return 0.0;

  const precision = overlap / predTokens.length;
  const recall = overlap / expTokens.length;
  return (2 * precision * recall) / (precision + recall);
}
