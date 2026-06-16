import type { QueryType } from '../retrieval/query-classifier.js';

/**
 * Per-category answer prompts (V4).
 * Each category gets a prompt tuned to its failure mode.
 *
 * V4: R11 query types. Renamed summarization → synthesis.
 * Added narrative, current-state, coverage.
 * Event-ordering folded into temporal/synthesis.
 * V4 prompts (answer path only). Bench-chasing retired S80, so changes are no
 * longer gated on a full 3-bench retest. They still feed the answer path, so
 * re-check answerer-mode output when editing.
 */
export const CATEGORY_PROMPTS: Record<QueryType, string> = {
  'single-hop':
    'Answer directly from the memory context. Be specific and concise. ' +
    'If the answer is a name, date, number, or specific detail, quote it exactly as stated in the memory. ' +
    'IMPORTANT: Check that your answer refers to the CORRECT person or entity asked about, not a different one. ' +
    'If multiple memories mention similar topics, use the one most relevant to the question. ' +
    'Do not add information not present in the memory context. ' +
    // S66 cleanliness: extracted claims now carry inline "on YYYY-MM-DD" / "in MONTH YYYY" / "as of YYYY-MM-DD"
    // date stamps because the extractor (v4-dated-recall) resolves relative time references at write time.
    // For single-hop questions that did NOT ask about timing, answer with the bare fact and OMIT the date stamp.
    // Example: Q="What is John\'s cousin\'s dog\'s name?" memory="John\'s cousin\'s dog is named Luna as of 2022-11-07"
    // -> answer "Luna", NOT "Luna as of 2022-11-07". Only include dates when the question explicitly asks about
    // when something happened or asks for a date.
    'When the question does NOT ask about timing or dates, answer with only the asked-about fact. ' +
    'Do not echo "on YYYY-MM-DD", "as of YYYY-MM-DD", "in MONTH YYYY", or other date stamps from the memory text. ' +
    'Include dates ONLY when the question itself asks "when", "what date", "what year", or otherwise explicitly requests timing.',

  'multi-hop':
    'This question connects multiple people or events. ' +
    'Look for relationships and shared details across different memory entries before answering. ' +
    'Cross-reference facts about different subjects to find connections. ' +
    'If the question asks for opinions or preferences, infer from behavioral evidence in the memory context.',

  'temporal-multi-hop':
    'This question requires comparing multiple people or entities across time. ' +
    'For each entity mentioned, build a timeline from the memory context. ' +
    'Compare timelines to find ordering, duration, or relative timing, ' +
    'then state only your final answer with specific dates. ' +
    'If asked "who did X first", find the earliest date for each person. ' +
    'If asked about order, list chronologically with dates. ' +
    'Do not guess dates not present in the memory context.',

  temporal:
    'Build a mental timeline from the memory context before answering. ' +
    'Extract all dates and time references, arrange them chronologically, ' +
    'then state only your final answer. ' +
    'Match the date format used in the question when possible. ' +
    'For relative references (like "the Friday before July 15"), compute and state the actual date. ' +
    'For duration questions, calculate explicitly. ' +
    'State specific dates. Do not guess dates not in the context.',

  'open-domain':
    'This question asks about opinions, personality, preferences, or hypothetical scenarios. ' +
    'You ARE permitted to make reasonable inferences from the memory context. ' +
    'Use specific details from memory as evidence for your inferences. ' +
    'Do NOT refuse to answer just because the memory does not explicitly state the answer. ' +
    'If memory provides behavioral patterns, stated preferences, or described traits, use them to infer. ' +
    'Prefer specific details from memory over general statements.',

  narrative:
    'Tell the story using the memory context. ' +
    'Connect related facts into a coherent narrative rather than listing individual memories. ' +
    'Include specific details, dates, and names. ' +
    'Focus on what happened and why it matters.',

  synthesis:
    'Synthesize information across all relevant memories to provide a coherent overview. ' +
    'Connect related facts into a narrative rather than listing individual memories. ' +
    'Cover the full timeline of events, noting how things changed or developed over time. ' +
    'Include specific details, dates, and names from the memory context.',

  'current-state':
    'Focus on the most recent and current information about the subject. ' +
    'If information has been updated or superseded, use the latest version. ' +
    'State the current status clearly. Note if anything is marked as stale or conflicted. ' +
    // S65 council reconciliation: report stale facts WITH the date, do not refuse.
    // Prior wording ("prefer to say you do not have current information") caused the
    // model to refuse old-timestamp facts on benches with multi-year fixtures, costing
    // recall on every question with an as-of annotation. The honest behavior is to
    // report what we have and let the date inform the caller.
    'If a memory is annotated with [as-of YYYY-MM-DD], state the fact and include the date inline ' +
    'so the caller can judge whether it is still current. Do not refuse to answer just because the ' +
    'fact is old; the date itself communicates that.',

  summarization:
    'Summarize the key facts from memory context. ' +
    'Focus on atomic, verifiable details rather than narrative. ' +
    'Include specific names, dates, and numbers. ' +
    'Be thorough but concise. Do not add information not in the memory context.',

  coverage:
    'Provide a comprehensive listing of all activities, events, or items related to the subject. ' +
    'Be thorough. Do not omit entries to be concise. ' +
    'Group related items together when possible.',
};
/**
 * S66 OUTPUT_HYGIENE: appended to every category prompt so the answer
 * model writes plain user-facing prose instead of echoing context structure.
 *
 * Diagnosis: bench analysis at S66 v4.3 (commit 964620d) on counting
 * questions ("How many tournaments has Nate won?") showed engine
 * retrieved the relevant facts, but the answer model rendered them as
 * "1. tournament on date (M3 - superseded but still relevant)\n2. ..."
 *, echoing the [M1]/[M2] memory IDs, [CURRENT]/[SUPERSEDED]/[CONFLICT-
 * UNRESOLVED] conflict tags, and rank labels into the user-visible
 * answer. This (a) leaks scaffolding into the user reply, (b) chews the
 * 200-token answer budget and truncates counting/list answers mid-
 * enumeration, (c) confuses the LLM judge with markup it must ignore.
 *
 * The annotation tags ARE useful for the model to understand precedence
 *, keep them in the context. We just instruct the model to NOT include
 * them in its answer.
 */
export const OUTPUT_HYGIENE =
  ' Do not include memory IDs ([M1], [M2], M3, etc.), conflict tags ([CURRENT], [SUPERSEDED], [CONFLICT-UNRESOLVED]), rank labels, or any other annotation markup in your answer. Write your reply as plain prose using the facts directly.';

/**
 * Deterministic list-question detector (code logic, not prompt logic).
 * Used by getPromptForQuery for enumeration on list-type questions only.
 */
export function isListQuestion(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\b(what (are|were) (all |the )(different |various )?|list|name all|how many|which (ones|types|kinds))\b/.test(q) ||
    /\b(what|which)\b.{1,30}\b(hobbies|activities|interests|pets|friends|things|types|places|countries|books|sports|gifts|events|plans|goals|traits|attributes)\b/.test(
      q,
    ) ||
    /\bwhat\b.{1,10}\ball\b.{1,20}\b(does|did|has)\b.{1,30}\b(do|done|partake|participate|engage)\b/.test(q)
  );
}

/**
 * Get prompt for query, with code-logic list detection.
 * Returns enumeration prompt for list questions, V4 for everything else.
 */
export function getPromptForQuery(queryType: QueryType, query: string): string {
  if (queryType === 'single-hop' && isListQuestion(query)) {
    return (
      'Answer directly from the memory context. Enumerate EVERY relevant item from the memory context. ' +
      'Use a numbered list. Do not add information not present in the memory context.' +
      OUTPUT_HYGIENE
    );
  }
  return CATEGORY_PROMPTS[queryType] + OUTPUT_HYGIENE;
}
