/**
 * Fact Facets: deterministic annotation layer for memory records.
 * No LLM calls. Pure keyword/regex classification.
 * Populates fact_facets table after every fact write.
 * 
 * Consumed by: episodes (grouping), state packs (slot mapping),
 * bridge retrieval (mentioned_subjects), feature reranker (topic_match).
 */

import type Database from 'better-sqlite3';
import type { MemoryRecord } from '../schema/memory.js';
import { createLogger } from '../config.js';

const log = createLogger('facets');

export interface FactFacet {
  fact_id: string;
  primary_subject: string;
  mentioned_subjects: string; // JSON array
  fact_kind: string;
  topic_key: string | null;
  slot_group: string | null;
  slot_key: string | null;
  event_time: string | null;
  turn_span_start: number | null;
  turn_span_end: number | null;
}

// --- Fact kind classification ---

const KIND_PATTERNS: [RegExp, string][] = [
  [/\b(married|divorced|dating|engaged|sibling|parent|child|friend|partner|spouse|boyfriend|girlfriend|husband|wife|mother|father|sister|brother|son|daughter|roommate|colleague|boss|mentor)\b/i, 'relationship'],
  [/\b(born|age|name is|goes by|identifies as|nationality|ethnicity|gender|pronouns|lives in|moved to|from|grew up|raised in|hometown|citizen)\b/i, 'identity'],
  [/\b(wants to|plans to|planning|goal|aspir|dream|intend|aim|hoping to|working toward|target|objective|ambition)\b/i, 'goal'],
  [/\b(prefer|favorite|loves|hates|enjoys|dislikes|likes|fan of|into|passionate about|obsessed with|allergic|vegetarian|vegan|doesn't eat|avoids|can't stand)\b/i, 'preference'],
  [/\b(started|began|finished|completed|graduated|promoted|hired|fired|quit|joined|left|moved|bought|sold|adopted|lost|won|earned|received|diagnosed|recovered|launched|released|published|performed)\b/i, 'event'],
  [/\b(works at|job|career|occupation|profession|employed|position|role|title|salary|income|studying|student|enrolled|major|degree)\b/i, 'status'],
  [/\b(thinks|believes|feels|opinion|view|perspective|stance|attitude|worried|concerned|excited|anxious|happy|sad|frustrated|confident)\b/i, 'opinion'],
];

export function classifyFactKind(claim: string): string {
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(claim)) return kind;
  }
  return 'event'; // default
}

// --- Topic key extraction ---

const TOPIC_PATTERNS: [RegExp, string][] = [
  [/\b(camp|hik|outdoor|trail|mountain|tent|backpack|wilderness|nature|fish|hunt)\b/i, 'outdoors'],
  [/\b(career|job|work|employ|profession|office|company|startup|business|promot|resign|fired|hired)\b/i, 'career'],
  [/\b(art|paint|draw|sculpt|museum|gallery|creative|design|photograph|craft)\b/i, 'art'],
  [/\b(adopt|baby|child|parent|family|pregnant|birth|kid|toddler|infant)\b/i, 'family'],
  [/\b(school|university|college|degree|study|class|course|exam|graduat|academic|research)\b/i, 'education'],
  [/\b(health|doctor|hospital|sick|diagnos|surgery|medic|treat|therapy|condition|illness|disease)\b/i, 'health'],
  [/\b(travel|trip|vacation|visit|flight|hotel|country|city|abroad|tour|destination)\b/i, 'travel'],
  [/\b(cook|food|eat|restaurant|recipe|meal|diet|kitchen|bake|cuisine)\b/i, 'food'],
  [/\b(music|band|song|concert|instrument|guitar|piano|sing|album|genre)\b/i, 'music'],
  [/\b(sport|game|team|play|match|competition|athlete|train|fitness|exercise|gym|workout|run|swim)\b/i, 'sports'],
  [/\b(movie|film|show|series|tv|watch|stream|cinema|actor|director|episode|season)\b/i, 'entertainment'],
  [/\b(read|book|novel|author|fiction|library|literature|write|publish)\b/i, 'reading'],
  [/\b(pet|dog|cat|animal|vet|breed|puppy|kitten|fish|bird)\b/i, 'pets'],
  [/\b(house|home|apartment|rent|mortgage|move|neighbor|room|furniture|decor|garden|yard)\b/i, 'housing'],
  [/\b(money|finance|budget|invest|savings|debt|loan|bank|expense|income|tax|stock)\b/i, 'finance'],
  [/\b(friend|social|party|hang out|meet up|gathering|event|celebrate|birthday|wedding|anniversary)\b/i, 'social'],
  [/\b(tech|computer|software|program|code|app|device|phone|laptop|internet|AI|machine learning)\b/i, 'technology'],
  [/\b(relationship|dating|love|romantic|partner|breakup|crush|marriage|divorce|wedding)\b/i, 'relationships'],
  [/\b(hobby|collect|garden|craft|DIY|volunteer|community|club|group|activity)\b/i, 'hobbies'],
];

export function extractTopicKey(claim: string, subject: string): string | null {
  const text = `${subject} ${claim}`;
  for (const [pattern, topic] of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic;
  }
  return null;
}

// --- Mentioned subjects extraction (simple NER) ---

/** Extract capitalized multi-word names from claim text, excluding the primary subject */
export function extractMentionedSubjects(claim: string, primarySubject: string): string[] {
  // Match sequences of capitalized words (2+ chars each)
  const namePattern = /\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})*)\b/g;
  const matches = claim.match(namePattern) || [];

  const primaryLower = primarySubject.toLowerCase();
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of matches) {
    const lower = match.toLowerCase();
    // Skip the primary subject, common words, and duplicates
    if (lower === primaryLower || lower.includes(primaryLower) || primaryLower.includes(lower)) continue;
    if (COMMON_CAPITALIZED.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    results.push(match);
  }

  return results;
}

const COMMON_CAPITALIZED = new Set([
  'the', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'new', 'old', 'great', 'high', 'low', 'north', 'south', 'east', 'west',
]);

// --- Slot mapping (fact_kind → state pack slot types) ---

const SLOT_GROUP_MAP: Record<string, string> = {
  'identity': 'identity',
  'relationship': 'relationship',
  'goal': 'goal',
  'preference': 'preference',
  'status': 'status',
  'event': 'recent_event',
  'opinion': 'unresolved',
};

function mapToSlotGroup(factKind: string): string {
  return SLOT_GROUP_MAP[factKind] || 'unresolved';
}

function extractSlotKey(claim: string, factKind: string): string | null {
  // Extract a short key from the claim based on kind
  if (factKind === 'identity') {
    if (/\bname\b/i.test(claim)) return 'name';
    if (/\bage\b|\bborn\b/i.test(claim)) return 'age';
    if (/\blives?\s+in\b|\bmoved?\s+to\b|\bfrom\b/i.test(claim)) return 'location';
    if (/\bnationality\b|\bcitizen\b/i.test(claim)) return 'nationality';
    return 'bio';
  }
  if (factKind === 'status') {
    if (/\bwork|job|employ|position|role\b/i.test(claim)) return 'employment';
    if (/\bstud|school|university|college|degree\b/i.test(claim)) return 'education';
    return 'general';
  }
  if (factKind === 'relationship') {
    // Try to extract the relationship type
    const relMatch = claim.match(/\b(married|dating|engaged|sibling|parent|child|friend|partner|spouse|boyfriend|girlfriend|husband|wife|mother|father|sister|brother|roommate|colleague|boss|mentor)\b/i);
    return relMatch ? relMatch[1]!.toLowerCase() : 'connection';
  }
  return null;
}

// --- Event time extraction ---

function extractEventTime(record: MemoryRecord): string | null {
  if (record.validFrom) return record.validFrom;
  return null;
}

// --- Main populator ---

/**
 * Build a FactFacet from a MemoryRecord. Pure function, no DB access.
 */
export function buildFacet(record: MemoryRecord): FactFacet {
  const factKind = classifyFactKind(record.claim);
  const topicKey = extractTopicKey(record.claim, record.subject);
  const mentioned = extractMentionedSubjects(record.claim, record.subject);
  const slotGroup = mapToSlotGroup(factKind);
  const slotKey = extractSlotKey(record.claim, factKind);

  return {
    fact_id: record.id,
    primary_subject: record.subject,
    mentioned_subjects: JSON.stringify(mentioned),
    fact_kind: factKind,
    topic_key: topicKey,
    slot_group: slotGroup,
    slot_key: slotKey,
    event_time: extractEventTime(record),
    turn_span_start: null,
    turn_span_end: null,
  };
}

/**
 * Insert a facet into the database.
 * Called after every fact write in the write pipeline.
 */
export function insertFacet(db: Database.Database, facet: FactFacet): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fact_facets 
      (fact_id, primary_subject, mentioned_subjects, fact_kind, topic_key, 
       slot_group, slot_key, event_time, turn_span_start, turn_span_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    facet.fact_id,
    facet.primary_subject,
    facet.mentioned_subjects,
    facet.fact_kind,
    facet.topic_key,
    facet.slot_group,
    facet.slot_key,
    facet.event_time,
    facet.turn_span_start,
    facet.turn_span_end,
  );
}

/**
 * Populate facets for a single memory record.
 * Called from write pipeline. Wraps build + insert.
 */
export function populateFacets(db: Database.Database, record: MemoryRecord): void {
  try {
    const facet = buildFacet(record);
    insertFacet(db, facet);
    log.debug({ factId: record.id, kind: facet.fact_kind, topic: facet.topic_key }, 'Facet populated');
  } catch (err) {
    // Non-critical: facet failure should never block writes
    log.warn({ factId: record.id, err }, 'Failed to populate facet');
  }
}

/**
 * Get facet for a fact ID.
 */
export function getFacet(db: Database.Database, factId: string): FactFacet | null {
  const row = db.prepare('SELECT * FROM fact_facets WHERE fact_id = ?').get(factId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    fact_id: row.fact_id as string,
    primary_subject: row.primary_subject as string,
    mentioned_subjects: row.mentioned_subjects as string,
    fact_kind: row.fact_kind as string,
    topic_key: (row.topic_key as string) || null,
    slot_group: (row.slot_group as string) || null,
    slot_key: (row.slot_key as string) || null,
    event_time: (row.event_time as string) || null,
    turn_span_start: (row.turn_span_start as number) || null,
    turn_span_end: (row.turn_span_end as number) || null,
  };
}

/**
 * Get all facets for a subject.
 */
export function getFacetsBySubject(db: Database.Database, subject: string): FactFacet[] {
  const rows = db.prepare('SELECT * FROM fact_facets WHERE primary_subject = ?').all(subject) as Record<string, unknown>[];
  return rows.map(row => ({
    fact_id: row.fact_id as string,
    primary_subject: row.primary_subject as string,
    mentioned_subjects: row.mentioned_subjects as string,
    fact_kind: row.fact_kind as string,
    topic_key: (row.topic_key as string) || null,
    slot_group: (row.slot_group as string) || null,
    slot_key: (row.slot_key as string) || null,
    event_time: (row.event_time as string) || null,
    turn_span_start: (row.turn_span_start as number) || null,
    turn_span_end: (row.turn_span_end as number) || null,
  }));
}

/**
 * Get facets by topic key.
 */
export function getFacetsByTopic(db: Database.Database, topicKey: string): FactFacet[] {
  const rows = db.prepare('SELECT * FROM fact_facets WHERE topic_key = ?').all(topicKey) as Record<string, unknown>[];
  return rows.map(row => ({
    fact_id: row.fact_id as string,
    primary_subject: row.primary_subject as string,
    mentioned_subjects: row.mentioned_subjects as string,
    fact_kind: row.fact_kind as string,
    topic_key: (row.topic_key as string) || null,
    slot_group: (row.slot_group as string) || null,
    slot_key: (row.slot_key as string) || null,
    event_time: (row.event_time as string) || null,
    turn_span_start: (row.turn_span_start as number) || null,
    turn_span_end: (row.turn_span_end as number) || null,
  }));
}
