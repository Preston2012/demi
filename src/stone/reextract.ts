/**
 * On-demand re-extraction (Tier 3).
 *
 * When compiled state can't answer a query, goes back to STONE raw
 * conversation logs and re-extracts with a query-focused prompt.
 *
 * Trigger: retrieval returns <3 candidates above cosine 0.5 threshold,
 * AND STONE has relevant conversations.
 *
 * Flag: REEXTRACT_ENABLED=true (default: false)
 */

import { createLogger } from '../config.js';
import type { StoneStore, ConversationMessage } from '../stone/index.js';

const log = createLogger('reextract');

/** Check if re-extraction should trigger */
export function shouldReextract(
  topCandidateScore: number,
  candidateCount: number,
  threshold = 0.5,
  minCandidates = 3,
): boolean {
  if (process.env.REEXTRACT_ENABLED !== 'true') return false;
  return candidateCount < minCandidates || topCandidateScore < threshold;
}

/**
 * Build a query-focused extraction prompt.
 * Unlike generic write-time extraction, this targets facts
 * relevant to the specific failing query.
 */
export function buildReextractionPrompt(
  query: string,
  messages: ConversationMessage[],
  maxMessages = 50,
): string {
  // Take most recent messages up to limit
  const recent = messages.slice(-maxMessages);
  const transcript = recent
    .map(m => `[${m.role}]: ${m.content}`)
    .join('\n');

  return `You are extracting specific facts from a conversation that are relevant to answering a question.

QUESTION: ${query}

Extract ONLY facts from this conversation that could help answer the question above.
For each fact, output one line in this format:
FACT: [subject] | [specific claim with dates and details]

Rules:
- Include exact dates, numbers, names when present
- Include emotional states, opinions, and reactions
- Include specific objects, locations, and descriptions
- Do NOT infer or add information not in the conversation
- Do NOT extract facts unrelated to the question
- Maximum 20 facts

CONVERSATION:
${transcript}

FACTS:`;
}

/**
 * Parse extraction response into fact claims.
 */
export function parseExtractionResponse(response: string): Array<{ subject: string; claim: string }> {
  const facts: Array<{ subject: string; claim: string }> = [];
  const lines = response.split('\n');

  for (const line of lines) {
    const match = line.match(/^FACT:\s*(.+?)\s*\|\s*(.+)/);
    if (match) {
      facts.push({
        subject: match[1]!.trim(),
        claim: match[2]!.trim(),
      });
    }
  }

  return facts;
}

/**
 * Find relevant conversations in STONE for a query.
 * Uses keyword matching against conversation messages.
 */
export function findRelevantConversations(
  stone: StoneStore,
  query: string,
  maxConversations = 3,
): string[] {
  const conversations = stone.listConversations(50);
  const queryTerms = query.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  if (queryTerms.length === 0) return [];

  // Score conversations by keyword overlap with their messages
  const scored: Array<{ id: string; score: number }> = [];

  for (const conv of conversations) {
    const messages = stone.getMessages(conv.id);
    const text = messages.map(m => m.content).join(' ').toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score++;
    }
    if (score > 0) {
      scored.push({ id: conv.id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxConversations).map(s => s.id);
}

/**
 * Run on-demand re-extraction pipeline.
 *
 * 1. Find relevant conversations in STONE
 * 2. Build query-focused extraction prompt
 * 3. Call LLM to extract targeted facts
 * 4. Return new fact candidates for injection
 *
 * Note: The actual LLM call is deferred to the caller since
 * this module shouldn't depend on a specific LLM client.
 */
export interface ReextractionRequest {
  conversationId: string;
  prompt: string;
  messageCount: number;
}

export function prepareReextractions(
  stone: StoneStore,
  query: string,
  maxConversations = 3,
): ReextractionRequest[] {
  const convIds = findRelevantConversations(stone, query, maxConversations);
  const requests: ReextractionRequest[] = [];

  for (const convId of convIds) {
    const messages = stone.getMessages(convId);
    if (messages.length === 0) continue;

    const prompt = buildReextractionPrompt(query, messages);
    requests.push({
      conversationId: convId,
      prompt,
      messageCount: messages.length,
    });
  }

  log.info({
    query: query.substring(0, 80),
    conversationsFound: convIds.length,
    requestsPrepared: requests.length,
  }, 'Re-extraction requests prepared');

  return requests;
}
