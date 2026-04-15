/**
 * LongMemEval fact extractor.
 *
 * Extracts structured claims from raw chat sessions using an LLM.
 * Results are cached to disk so benchmark runs don't re-extract.
 *
 * Cost: ~$5-15 for the full S dataset (500 questions x ~40 sessions).
 * Run once, reuse indefinitely.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { LongMemEvalEntry, ExtractedFacts, ExtractedFactsCache } from './longmemeval-types.js';

const EXTRACTION_PROMPT = `Extract all factual claims from this conversation that could be useful for answering future questions about the user. Output each fact as a JSON array of objects with "claim" and "subject" fields.

Rules:
- Each claim should be a single, self-contained factual statement
- Use the user's perspective: "User prefers X", "User works at Y"
- Include names, dates, numbers, preferences, relationships, locations
- Subject should be a short category: "workplace", "preferences", "relationships", "hobbies", "location", etc.
- Do NOT include assistant's opinions or suggestions
- Do NOT include conversation metadata
- Output ONLY the JSON array, no markdown or explanation

Conversation:
`;

export async function extractFactsFromSession(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string = 'claude-haiku-4-5-20251001',
): Promise<Array<{ claim: string; subject: string }>> {
  const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  // Skip very short sessions (< 50 chars of user content)
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');
  if (userContent.length < 50) return [];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [{ role: 'user', content: EXTRACTION_PROMPT + conversationText }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Extraction API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  const text = data.content?.[0]?.text ?? '[]';

  try {
    // Parse JSON, handle potential markdown wrapping
    const cleaned = text
      .replace(/^```json?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    const facts = JSON.parse(cleaned) as Array<{ claim: string; subject: string }>;
    return facts.filter((f) => f.claim && f.subject);
  } catch {
    console.warn('Failed to parse extraction result, skipping session');
    return [];
  }
}

/**
 * Extract facts for all questions in a dataset.
 * Caches to disk after each question for resumability.
 */
export async function extractAllFacts(
  entries: LongMemEvalEntry[],
  cachePath: string,
  apiKey: string,
  options: {
    model?: string;
    batchDelay?: number; // ms between API calls to avoid rate limits
    maxSessionsPerQuestion?: number; // limit for cost control
    startFrom?: number; // resume from question index
  } = {},
): Promise<ExtractedFactsCache> {
  const model = options.model ?? 'claude-haiku-4-5-20251001';
  const batchDelay = options.batchDelay ?? 200;
  const maxSessions = options.maxSessionsPerQuestion ?? 50;
  const startFrom = options.startFrom ?? 0;

  // Load existing cache if resuming
  let cache: ExtractedFactsCache;
  if (existsSync(cachePath) && startFrom > 0) {
    cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as ExtractedFactsCache;
  } else {
    cache = {
      dataset: 'longmemeval-s',
      model,
      extracted_at: new Date().toISOString(),
      entries: [],
    };
  }

  const existingIds = new Set(cache.entries.map((e) => e.question_id));

  for (let i = startFrom; i < entries.length; i++) {
    const entry = entries[i]!;

    if (existingIds.has(entry.question_id)) {
      continue; // Already extracted
    }

    console.log(
      `[${i + 1}/${entries.length}] Extracting facts for ${entry.question_id} (${entry.sessions.length} sessions)...`,
    );

    const facts: ExtractedFacts = {
      question_id: entry.question_id,
      facts: [],
    };

    // Process sessions (limit to maxSessions for cost control)
    const sessionsToProcess = entry.sessions.slice(0, maxSessions);

    for (const session of sessionsToProcess) {
      try {
        const sessionFacts = await extractFactsFromSession(session.messages, apiKey, model);

        for (const fact of sessionFacts) {
          facts.facts.push({
            claim: fact.claim,
            subject: fact.subject,
            session_id: session.session_id,
          });
        }

        // Rate limit
        if (batchDelay > 0) {
          await new Promise((r) => setTimeout(r, batchDelay));
        }
      } catch (err) {
        console.error(`  Error extracting session ${session.session_id}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`  Extracted ${facts.facts.length} facts`);
    cache.entries.push(facts);

    // Save cache after each question for resumability
    if ((i + 1) % 10 === 0 || i === entries.length - 1) {
      writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      console.log(`  Cache saved (${cache.entries.length} questions processed)`);
    }
  }

  // Final save
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return cache;
}
