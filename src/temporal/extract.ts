/**
 * Temporal event extraction from conversation text.
 * Builds LLM prompts and parses structured SVO responses.
 *
 * The caller provides the LLM completion function —
 * this module is model-agnostic.
 */

import { createLogger } from '../config.js';
import type { TemporalEvent, EventType, Granularity } from './index.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('temporal-extract');

/**
 * Build extraction prompt for temporal events from conversation text.
 */
export function buildTemporalExtractionPrompt(conversationText: string, _conversationId?: string): string {
  return `You are extracting temporal events from a conversation. For each event that has a time reference, output a structured line.

FORMAT (one per line, pipe-delimited):
EVENT: subject | verb | object | datetime | event_type | granularity | raw_expression

FIELDS:
- subject: WHO (person name, "user", "assistant")
- verb: WHAT action (past tense preferred: "visited", "started", "bought")
- object: target/recipient (can be empty if intransitive)
- datetime: ISO 8601 format (2024-03-15, 2024-03-15T14:30:00, 2024-03). Use best estimate. Leave empty if truly unknown.
- event_type: one of: event, state_change, preference, commitment, relationship, achievement
- granularity: one of: exact, day, week, month, year, relative
- raw_expression: the original time reference from the text ("last Tuesday", "in March", "two weeks ago")

RULES:
- Extract ONLY events with temporal context (explicit or inferable dates)
- Include state changes ("moved to NYC in June") and commitments ("plans to visit in December")
- Do NOT infer dates not supported by the text
- Do NOT extract generic facts without temporal anchoring
- Maximum 30 events per conversation
- If the conversation has no temporal events, output: NO_EVENTS

CONVERSATION:
${conversationText}

EVENTS:`;
}

/**
 * Parse the LLM response into structured TemporalEvent objects.
 */
export function parseTemporalExtractionResponse(
  response: string,
  conversationId?: string,
  messageSequence?: number,
): TemporalEvent[] {
  if (response.trim() === 'NO_EVENTS') return [];

  const events: TemporalEvent[] = [];
  const lines = response.split('\n');

  for (const line of lines) {
    const match = line.match(/^EVENT:\s*(.+)/);
    if (!match) continue;

    const parts = match[1]!.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;

    const [subject, verb, object, datetime, eventType, granularity, rawExpression] = parts;

    if (!subject || !verb) continue;

    // Validate event_type
    const validTypes: EventType[] = [
      'event',
      'state_change',
      'preference',
      'commitment',
      'relationship',
      'achievement',
    ];
    const parsedType = eventType && validTypes.includes(eventType as EventType) ? (eventType as EventType) : 'event';

    // Validate granularity
    const validGranularities: Granularity[] = ['exact', 'day', 'week', 'month', 'year', 'relative'];
    const parsedGranularity =
      granularity && validGranularities.includes(granularity as Granularity) ? (granularity as Granularity) : 'day';

    // Validate datetime (basic ISO 8601 check)
    const cleanDatetime = datetime && /^\d{4}/.test(datetime) ? datetime : undefined;

    events.push({
      id: randomUUID(),
      subject: subject,
      verb: verb,
      object: object || undefined,
      eventDatetime: cleanDatetime,
      eventType: parsedType,
      granularity: parsedGranularity,
      confidence: cleanDatetime ? 0.9 : 0.6,
      sourceConversationId: conversationId,
      sourceMessageSequence: messageSequence,
      rawTemporalExpression: rawExpression || undefined,
    });
  }

  log.info({ parsed: events.length }, 'Temporal events extracted');
  return events;
}

/**
 * Build conversation text from messages for extraction.
 */
export function formatMessagesForExtraction(
  messages: Array<{ role: string; content: string; sequenceNumber?: number }>,
  maxMessages = 100,
): string {
  const recent = messages.slice(-maxMessages);
  return recent
    .map((m) => `[${m.role}${m.sequenceNumber !== undefined ? ` #${m.sequenceNumber}` : ''}]: ${m.content}`)
    .join('\n');
}

/**
 * Prepare extraction requests for a set of conversations.
 * Returns prompts ready to send to an LLM.
 */
export interface TemporalExtractionRequest {
  conversationId: string;
  prompt: string;
  messageCount: number;
}

export function prepareTemporalExtractions(
  conversations: Array<{
    id: string;
    messages: Array<{ role: string; content: string; sequenceNumber?: number }>;
  }>,
  maxMessagesPerConv = 100,
): TemporalExtractionRequest[] {
  const requests: TemporalExtractionRequest[] = [];

  for (const conv of conversations) {
    if (conv.messages.length === 0) continue;

    const text = formatMessagesForExtraction(conv.messages, maxMessagesPerConv);
    const prompt = buildTemporalExtractionPrompt(text, conv.id);

    requests.push({
      conversationId: conv.id,
      prompt,
      messageCount: conv.messages.length,
    });
  }

  return requests;
}
