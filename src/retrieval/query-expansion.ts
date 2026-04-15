import { createLogger } from '../config.js';

const log = createLogger('query-expansion');

/**
 * Deterministic query expansion. No LLM calls.
 * Generates additional search queries from the original to improve recall.
 * 
 * Strategies:
 * 1. Extract proper nouns (entity-focused sub-queries)
 * 2. Strip question words for keyword-focused search
 * 3. Temporal marker extraction
 */

const QUESTION_WORDS = new Set(['what', 'when', 'where', 'who', 'why', 'how', 'did', 'does', 'do', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'would', 'could', 'should', 'which']);
const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'and', 'or', 'but', 'not', 'that', 'this', 'their', 'her', 'his', 'its', 'she', 'he', 'they', 'about', 'been', 'being', 'some', 'than', 'also']);

/**
 * Extract proper nouns from a query (capitalized words that aren't at sentence start).
 */
function extractEntities(query: string): string[] {
  const words = query.split(/\s+/);
  const entities: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.replace(/[^a-zA-Z']/g, '');
    if (word.length < 2) continue;
    // Capitalized and not first word (or first word that's clearly a name)
    if (word[0] === word[0]!.toUpperCase() && word[0] !== word[0]!.toLowerCase()) {
      if (!QUESTION_WORDS.has(word.toLowerCase()) && !STOP_WORDS.has(word.toLowerCase())) {
        entities.push(word);
      }
    }
  }
  return [...new Set(entities)];
}

/**
 * Strip question scaffolding to get keyword core.
 */
function extractKeywords(query: string): string {
  const words = query.split(/\s+/)
    .map(w => w.replace(/[?.,!]/g, '').toLowerCase())
    .filter(w => w.length > 2 && !QUESTION_WORDS.has(w) && !STOP_WORDS.has(w));
  return words.join(' ');
}


/**
 * Normalize relative temporal expressions to approximate ISO dates.
 * Deterministic: uses current date as anchor.
 */
function normalizeTemporalExpression(query: string): string | null {
  const now = new Date();
  const lc = query.toLowerCase();

  // "last month" -> YYYY-MM
  if (/last\s+month/i.test(lc)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // "last year" -> YYYY
  if (/last\s+year/i.test(lc)) {
    return String(now.getFullYear() - 1);
  }
  // "last week" -> approximate date
  if (/last\s+week/i.test(lc)) {
    const d = new Date(now.getTime() - 7 * 86400000);
    return d.toISOString().split('T')[0]!;
  }
  // "yesterday" -> date
  if (/yesterday/i.test(lc)) {
    const d = new Date(now.getTime() - 86400000);
    return d.toISOString().split('T')[0]!;
  }
  // "X months ago"
  const monthsAgo = lc.match(/(\d+)\s+months?\s+ago/);
  if (monthsAgo) {
    const d = new Date(now.getFullYear(), now.getMonth() - parseInt(monthsAgo[1]!), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // "X weeks ago"
  const weeksAgo = lc.match(/(\d+)\s+weeks?\s+ago/);
  if (weeksAgo) {
    const d = new Date(now.getTime() - parseInt(weeksAgo[1]!) * 7 * 86400000);
    return d.toISOString().split('T')[0]!;
  }

  return null;
}

/**
 * Decompose multi-entity questions into sub-queries.
 * "What did Bob and Alice do at the park?" -> ["Bob park", "Alice park"]
 */
function decomposeMultiEntity(query: string): string[] {
  const entities = extractEntities(query);
  if (entities.length < 2) return [];

  // Extract the "context" (non-entity keywords)
  const keywords = extractKeywords(query);
  const contextWords = keywords.split(' ')
    .filter(w => !entities.map(e => e.toLowerCase()).includes(w));
  const context = contextWords.slice(0, 3).join(' ');

  if (!context) return [];

  // Generate per-entity sub-queries
  const decomposed: string[] = [];
  for (const entity of entities.slice(0, 3)) {
    decomposed.push(`${entity} ${context}`);
  }
  return decomposed;
}

/**
 * Generate expanded queries for better recall.
 * Returns array of additional queries to search (original query is always searched separately).
 */
export function expandQuery(query: string): string[] {
  const expanded: string[] = [];
  
  // Strategy 1: Entity-focused queries
  const entities = extractEntities(query);
  if (entities.length >= 2) {
    // Multi-entity query: search for each entity separately
    for (const entity of entities) {
      expanded.push(entity);
    }
    // Also search entity pairs
    expanded.push(entities.join(' '));
  }
  
  // Strategy 2: Keyword core (no question words)
  const keywords = extractKeywords(query);
  if (keywords && keywords !== query.toLowerCase().replace(/[?.,!]/g, '')) {
    expanded.push(keywords);
  }
  
  // Strategy 3: Temporal markers with entity
  const temporalMatch = query.match(/(\d{4}|January|February|March|April|May|June|July|August|September|October|November|December|last\s+\w+|summer|winter|spring|fall)/i);
  if (temporalMatch && entities.length > 0) {
    expanded.push(`${entities[0]} ${temporalMatch[1]}`);
  }

  // Strategy 4: Temporal normalization (relative -> absolute)
  const normalizedDate = normalizeTemporalExpression(query);
  if (normalizedDate && entities.length > 0) {
    expanded.push(`${entities[0]} ${normalizedDate}`);
  }

  // Strategy 5: Multi-entity decomposition
  const decomposed = decomposeMultiEntity(query);
  for (const dq of decomposed.slice(0, 3)) {
    expanded.push(dq);
  }

  if (expanded.length > 0) {
    log.debug({ query, expanded: expanded.length }, 'Query expanded');
  }
  
  return expanded;
}
