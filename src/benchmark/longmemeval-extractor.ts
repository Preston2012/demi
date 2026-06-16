/**
 * LongMemEval fact extractor.
 *
 * Extracts structured claims from raw chat sessions using an LLM.
 * Results are cached to disk so benchmark runs don't re-extract.
 *
 * Cost: ~$5-15 for the full S dataset (500 questions x ~40 sessions).
 * Run once, reuse indefinitely.
 *
 * S65 Phase 1B: prompt + extraction shape now live in src/extract/index.ts.
 * This module is a thin adapter that batches sessions, formats messages
 * for the bench, and writes a JSON cache for resumability. The actual
 * LLM call + persistent content cache delegate to extractClaims() in
 * src/extract/. Single source of truth for the prompt, no duplication.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { LongMemEvalEntry, ExtractedFacts, ExtractedFactsCache } from './longmemeval-types.js';
import { extractClaims, defaultExtractionModel } from '../extract/index.js';

export async function extractFactsFromSession(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string = defaultExtractionModel(),
): Promise<Array<{ claim: string; subject: string }>> {
  // Skip very short sessions (< 50 chars of user content), preserved
  // because LME has many trivial sessions and dispatch.ingest()'s 50-char
  // floor counts the full conversation, not just user turns. Keeping the
  // tighter LME-side filter avoids paying extraction cost on assistant-only
  // or near-empty-user sessions.
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');
  if (userContent.length < 50) return [];

  void apiKey; // S65: kept for back-compat; engine callLLM reads provider keys from env

  const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  // Phase 1B: delegate to canonical src/extract/. The bench-specific cacheKey
  // namespace ('demiurge:lme:extractor:v1') is preserved so existing LME
  // extraction caches stay valid across the refactor; new bench-paths and
  // production calls share the default ('demiurge:extract:v1') cache.
  // Preserve legacy LME local-cache namespace + OpenAI prompt-cache key.
  // The bench has hours of warm extraction cache under 'lme-extractor-v1'
  //, keep using it across the Phase 1B refactor.
  return extractClaims(conversationText, {
    model,
    cacheKey: 'demiurge:lme:extractor:v1',
    promptVersion: 'lme-extractor-v1',
  });
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
  const model = options.model ?? defaultExtractionModel();
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
