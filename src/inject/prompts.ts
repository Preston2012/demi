import type { QueryType } from '../retrieval/query-classifier.js';

/**
 * Per-category answer prompts (V4).
 * Each category gets a prompt tuned to its failure mode.
 *
 * V4: R11 query types. Renamed summarization → synthesis.
 * Added narrative, current-state, coverage.
 * Event-ordering folded into temporal/synthesis.
 * GOLDEN CONFIG: V4 ALL prompts. Do not upgrade without full 3-bench retest.
 */
export const CATEGORY_PROMPTS: Record<QueryType, string> = {
  'single-hop':
    'Answer directly from the memory context. Be specific and concise. ' +
    'If the answer is a name, date, number, or specific detail, quote it exactly as stated in the memory. ' +
    'IMPORTANT: Check that your answer refers to the CORRECT person or entity asked about, not a different one. ' +
    'If multiple memories mention similar topics, use the one most relevant to the question. ' +
    'Do not add information not present in the memory context.',

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
    'State the current status clearly. Note if anything is marked as stale or conflicted.',

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
 * Map LOCOMO JSON category numbers to QueryType.
 * JSON: 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial
 */
export function locomoCategoryToQueryType(cat: number): QueryType {
  const map: Record<number, QueryType> = {
    1: 'multi-hop',
    2: 'temporal',
    3: 'open-domain',
    4: 'single-hop',
  };
  return map[cat] ?? 'single-hop';
}

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
      'Use a numbered list. Do not add information not present in the memory context.'
    );
  }
  return CATEGORY_PROMPTS[queryType];
}
