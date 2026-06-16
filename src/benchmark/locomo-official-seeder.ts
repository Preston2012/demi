/**
 * Official LOCOMO benchmark seeder.
 *
 * S67 LOCKDOWN: single path. `seedConversationViaIngest` is the only seeder.
 * The legacy pre-extracted-facts seeder (seedConversationFacts) was removed
 * after it silently caused a -34pp catastrophic regression on 2026-05-09
 * by writing to the system user partition while the runner's
 * dispatch.answer() path queries with userId=locomo-conv-{ci}. Partition
 * mismatch → 0 retrieval → hallucinated answers.
 *
 * One path. No flags. No legacy.
 */

import type { CoreDispatch } from '../core/dispatch.js';

// =====================================================================
// LOCOMO ingest-mode seeder (S65 Phase 1B → S67 LOCKDOWN: only path)
// =====================================================================
/**
 * One LOCOMO dialogue turn.
 */
export interface LocomoMessage {
  speaker: string;
  dia_id: string;
  text: string;
}

/**
 * Shape of a LOCOMO `conversation` object as it appears in locomo10.json.
 * This is the raw dataset shape, NOT to be confused with the bench-runner's
 * local `LocomoConversation` interface (which only types the `qa` field).
 *
 * Sessions are indexed `session_1`, `session_2`, ..., `session_N`, with
 * matching `session_N_date_time` keys giving the session's wall-clock
 * timestamp in human-readable form ("1:56 pm on 8 May, 2023").
 */
export interface LocomoRawConversation {
  speaker_a: string;
  speaker_b: string;
  // Open-ended: session_<N> and session_<N>_date_time keys, plus speakers above.
  // TypeScript can't model the dynamic key structure precisely; callers
  // index by string and check shape at runtime.
  [key: string]: unknown;
}

export interface IngestSeedSummary {
  sessions_processed: number;
  sessions_skipped: number; // empty/missing/short
  total_extracted: number;
  total_written: number;
  total_rejected: number;
  total_errors: number;
  duration_ms: {
    extraction: number;
    memory_writes: number;
    total: number;
  };
}

/**
 * Format a LOCOMO session's messages into a chat-style string for extraction.
 * Each line is `<speaker>: <text>`. The multi-speaker extraction prompt then
 * extracts claims attributed to either speaker.
 */
export function formatLocomoSessionForExtraction(messages: LocomoMessage[]): string {
  return messages.map((m) => `${m.speaker}: ${m.text}`).join('\n');
}

/**
 * Seed one LOCOMO conversation via dispatch.ingest(), the engine-honest path.
 *
 * For each session in the conversation:
 *  1. Format messages into chat-style text.
 *  2. Resolve session_<N>_date_time → ISO 8601 asserted_at.
 *  3. Call dispatch.ingest() with multiSpeaker=true.
 *
 * Returns aggregate stats so the bench runner can log a one-line summary
 * comparable to the old seeder's `seeded` count.
 */
export async function seedConversationViaIngest(
  dispatch: CoreDispatch,
  rawConv: LocomoRawConversation,
  conversationIndex: number,
): Promise<IngestSeedSummary> {
  const t0 = Date.now();
  const summary: IngestSeedSummary = {
    sessions_processed: 0,
    sessions_skipped: 0,
    total_extracted: 0,
    total_written: 0,
    total_rejected: 0,
    total_errors: 0,
    duration_ms: { extraction: 0, memory_writes: 0, total: 0 },
  };

  // Discover session keys (session_1, session_2, ...) in numeric order.
  const sessionIndices = Object.keys(rawConv)
    .filter((k) => /^session_\d+$/.test(k))
    .map((k) => parseInt(k.slice(8), 10))
    .sort((a, b) => a - b);

  for (const n of sessionIndices) {
    const sessionKey = `session_${n}`;
    const dateKey = `session_${n}_date_time`;
    const messages = rawConv[sessionKey];
    if (!Array.isArray(messages) || messages.length === 0) {
      summary.sessions_skipped++;
      continue;
    }

    const sessionText = formatLocomoSessionForExtraction(messages as LocomoMessage[]);
    if (sessionText.length < 50) {
      summary.sessions_skipped++;
      continue;
    }

    const dateRaw = typeof rawConv[dateKey] === 'string' ? (rawConv[dateKey] as string) : undefined;
    const asserted_at = parseLocomoTimestamp(dateRaw);

    try {
      const result = await dispatch.ingest(sessionText, {
        user_id: `locomo-conv-${conversationIndex}`,
        conversation_id: `locomo-conv-${conversationIndex}-session-${n}`,
        asserted_at,
        source: 'imported',
        multiSpeaker: true,
        metadata: { bench: 'locomo', conversation_index: conversationIndex, session_index: n },
      });

      summary.sessions_processed++;
      summary.total_extracted += result.extracted_count;
      summary.total_written += result.written.length;
      summary.total_rejected += result.rejected_count;
      summary.total_errors += result.errors.length;
      summary.duration_ms.extraction += result.duration_ms.extraction;
      summary.duration_ms.memory_writes += result.duration_ms.memory_writes;
    } catch (err: unknown) {
      // dispatch.ingest is documented not to throw, but defend against future
      // breakage. Treat as a single error and continue with next session.
      summary.total_errors++;
      console.error(
        'INGEST_ERROR:',
        `conv ${conversationIndex} session ${n}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  summary.duration_ms.total = Date.now() - t0;
  return summary;
}

// =====================================================================
// Shared helpers
// =====================================================================

/**
 * Parse LOCOMO's human-readable timestamp format ("1:36 pm on 3 July, 2023")
 * into an ISO 8601 string. Returns undefined for missing or unparseable input.
 *
 * Mirrors scripts/benchmark-locomo-official.ts:parseLocomoTimestamp so seeder
 * + runner agree on what's a valid LOCOMO timestamp. Bug fixed S64: previous
 * impl used `new Date(fact.timestamp)` directly, which rejects every LOCOMO
 * timestamp because JS Date can't parse "X pm on Y, Z". Result: validFrom
 * was undefined on every seeded LOCOMO fact for every prior bench run,
 * silently breaking temporal reasoning at retrieval/answer time.
 */
function parseLocomoTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const onIdx = ts.toLowerCase().indexOf(' on ');
  const datePart = onIdx >= 0 ? ts.slice(onIdx + 4) : ts;
  const ms = new Date(datePart).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
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
