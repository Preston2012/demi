/**
 * Temporal Event Store.
 * Structured SVO (Subject-Verb-Object) events with ISO 8601 timestamps.
 * Enables precise temporal reasoning: event ordering, date arithmetic,
 * "who did X first", "what happened after Y".
 *
 * Chronos research shows temporal events = 58.9% of LME gains.
 * Our LME error analysis: 53% of errors are temporal reasoning failures.
 */

import { createLogger } from '../config.js';
import type Database from 'better-sqlite3';

const log = createLogger('temporal');

// --- Schema ---

export const TEMPORAL_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS temporal_events (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  verb TEXT NOT NULL,
  object TEXT,
  event_datetime TEXT,
  event_end_datetime TEXT,
  event_type TEXT NOT NULL DEFAULT 'event',
  granularity TEXT NOT NULL DEFAULT 'day',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_conversation_id TEXT,
  source_message_sequence INTEGER,
  source_memory_id TEXT,
  raw_temporal_expression TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_temporal_datetime
  ON temporal_events(event_datetime) WHERE event_datetime IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_temporal_subject
  ON temporal_events(subject);

CREATE INDEX IF NOT EXISTS idx_temporal_type
  ON temporal_events(event_type);

CREATE INDEX IF NOT EXISTS idx_temporal_source_conv
  ON temporal_events(source_conversation_id) WHERE source_conversation_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS temporal_events_fts USING fts5(
  subject,
  verb,
  object,
  raw_temporal_expression UNINDEXED,
  content=temporal_events,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS temporal_fts_insert AFTER INSERT ON temporal_events BEGIN
  INSERT INTO temporal_events_fts(rowid, subject, verb, object, raw_temporal_expression)
  VALUES (new.rowid, new.subject, new.verb, new.object, new.raw_temporal_expression);
END;
`;

// --- Types ---

export type EventType = 'event' | 'state_change' | 'preference' | 'commitment' | 'relationship' | 'achievement';
export type Granularity = 'exact' | 'day' | 'week' | 'month' | 'year' | 'relative';

export interface TemporalEvent {
  id: string;
  subject: string;
  verb: string;
  object?: string;
  eventDatetime?: string; // ISO 8601
  eventEndDatetime?: string; // for duration events
  eventType: EventType;
  granularity: Granularity;
  confidence: number;
  sourceConversationId?: string;
  sourceMessageSequence?: number;
  sourceMemoryId?: string;
  rawTemporalExpression?: string; // "last Tuesday", "in March 2024"
  createdAt?: string;
}

// --- Store ---

export class TemporalStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(TEMPORAL_MIGRATIONS);
    log.info('Temporal event store initialized');
  }

  /** Insert a temporal event */
  addEvent(event: TemporalEvent): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO temporal_events
        (id, subject, verb, object, event_datetime, event_end_datetime,
         event_type, granularity, confidence, source_conversation_id,
         source_message_sequence, source_memory_id, raw_temporal_expression)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        event.id,
        event.subject,
        event.verb,
        event.object || null,
        event.eventDatetime || null,
        event.eventEndDatetime || null,
        event.eventType,
        event.granularity,
        event.confidence,
        event.sourceConversationId || null,
        event.sourceMessageSequence ?? null,
        event.sourceMemoryId || null,
        event.rawTemporalExpression || null,
      );
  }

  /** Batch insert events */
  addEvents(events: TemporalEvent[]): number {
    const insert = this.db.transaction((evts: TemporalEvent[]) => {
      let count = 0;
      for (const e of evts) {
        try {
          this.addEvent(e);
          count++;
        } catch (err) {
          log.warn({ id: e.id, err }, 'Failed to insert temporal event');
        }
      }
      return count;
    });
    const count = insert(events);
    log.info({ count, total: events.length }, 'Temporal events batch inserted');
    return count;
  }

  /** Search events by text (FTS5) */
  searchEvents(query: string, limit = 20): TemporalEvent[] {
    const sanitized = query
      .replace(/['\u2019]s\b/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .join(' OR ');

    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `
      SELECT te.*
      FROM temporal_events_fts fts
      JOIN temporal_events te ON te.rowid = fts.rowid
      WHERE temporal_events_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `,
      )
      .all(sanitized, limit) as Record<string, unknown>[];

    return rows.map(this.rowToEvent);
  }

  /** Get events in a datetime range */
  getEventsInRange(startDatetime: string, endDatetime: string, limit = 50): TemporalEvent[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM temporal_events
      WHERE event_datetime >= ? AND event_datetime <= ?
      ORDER BY event_datetime ASC
      LIMIT ?
    `,
      )
      .all(startDatetime, endDatetime, limit) as Record<string, unknown>[];

    return rows.map(this.rowToEvent);
  }

  /** Get events for a specific subject */
  getEventsBySubject(subject: string, limit = 20): TemporalEvent[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM temporal_events
      WHERE LOWER(subject) = LOWER(?)
      ORDER BY event_datetime ASC NULLS LAST
      LIMIT ?
    `,
      )
      .all(subject, limit) as Record<string, unknown>[];

    return rows.map(this.rowToEvent);
  }

  /** Get all events ordered by datetime (timeline view) */
  getTimeline(limit = 100): TemporalEvent[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM temporal_events
      WHERE event_datetime IS NOT NULL
      ORDER BY event_datetime ASC
      LIMIT ?
    `,
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map(this.rowToEvent);
  }

  /** Get event count */
  getEventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM temporal_events').get() as { count: number };
    return row.count;
  }

  /** Get events by conversation */
  getEventsByConversation(conversationId: string): TemporalEvent[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM temporal_events
      WHERE source_conversation_id = ?
      ORDER BY source_message_sequence ASC, event_datetime ASC
    `,
      )
      .all(conversationId) as Record<string, unknown>[];

    return rows.map(this.rowToEvent);
  }

  private rowToEvent(r: Record<string, unknown>): TemporalEvent {
    return {
      id: r.id as string,
      subject: r.subject as string,
      verb: r.verb as string,
      object: r.object as string | undefined,
      eventDatetime: r.event_datetime as string | undefined,
      eventEndDatetime: r.event_end_datetime as string | undefined,
      eventType: r.event_type as EventType,
      granularity: r.granularity as Granularity,
      confidence: r.confidence as number,
      sourceConversationId: r.source_conversation_id as string | undefined,
      sourceMessageSequence: r.source_message_sequence as number | undefined,
      sourceMemoryId: r.source_memory_id as string | undefined,
      rawTemporalExpression: r.raw_temporal_expression as string | undefined,
      createdAt: r.created_at as string | undefined,
    };
  }
}
