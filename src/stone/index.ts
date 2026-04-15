/**
 * STONE: Immutable raw conversation store.
 * Tier 1 of the three-tier architecture (council unanimous, LOCKED).
 *
 * Every conversation message is stored verbatim. Never modified, never deleted.
 * Compiled state (tier 2) is extracted from STONE at write time.
 * On-demand re-extraction (tier 3) goes back to STONE when compiled state
 * can't answer a query.
 *
 * Schema:
 *   conversations: metadata per conversation session
 *   conversation_messages: individual messages, immutable
 *   extraction_log: tracks which messages have been extracted to compiled state
 */

import { createLogger } from '../config.js';
import type Database from 'better-sqlite3';

const log = createLogger('stone');

// --- Schema ---

export const STONE_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'unknown',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  participant_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  token_count INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
  ON conversation_messages(conversation_id, sequence_number);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp
  ON conversation_messages(timestamp);

CREATE TABLE IF NOT EXISTS extraction_log (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_range_start INTEGER NOT NULL,
  message_range_end INTEGER NOT NULL,
  extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
  memory_ids TEXT NOT NULL,
  extraction_model TEXT,
  extraction_prompt_hash TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_conv
  ON extraction_log(conversation_id);

CREATE VIRTUAL TABLE IF NOT EXISTS stone_messages_fts USING fts5(
  content,
  conversation_id UNINDEXED,
  role UNINDEXED,
  sequence_number UNINDEXED,
  content=conversation_messages,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS stone_fts_insert AFTER INSERT ON conversation_messages BEGIN
  INSERT INTO stone_messages_fts(rowid, content, conversation_id, role, sequence_number)
  VALUES (new.rowid, new.content, new.conversation_id, new.role, new.sequence_number);
END;
`;

// --- Types ---

export interface Conversation {
  id: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  participantId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sequenceNumber: number;
  timestamp: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface ExtractionRecord {
  id: string;
  conversationId: string;
  messageRangeStart: number;
  messageRangeEnd: number;
  extractedAt: string;
  memoryIds: string[];
  extractionModel?: string;
  extractionPromptHash?: string;
}

// --- STONE Store ---

export class StoneStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(STONE_MIGRATIONS);
    log.info('STONE store initialized');
  }

  /** Store a new conversation session */
  createConversation(conv: Conversation): void {
    this.db
      .prepare(
        `
      INSERT INTO conversations (id, source, started_at, ended_at, participant_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        conv.id,
        conv.source,
        conv.startedAt,
        conv.endedAt || null,
        conv.participantId || null,
        conv.metadata ? JSON.stringify(conv.metadata) : null,
      );
  }

  /** Append a message to a conversation (immutable) */
  appendMessage(msg: ConversationMessage): void {
    this.db
      .prepare(
        `
      INSERT INTO conversation_messages (id, conversation_id, role, content, sequence_number, timestamp, token_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        msg.id,
        msg.conversationId,
        msg.role,
        msg.content,
        msg.sequenceNumber,
        msg.timestamp,
        msg.tokenCount || null,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
      );
  }

  /** Get all messages in a conversation, ordered by sequence */
  getMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY sequence_number ASC
    `,
      )
      .all(conversationId) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      role: r.role as 'user' | 'assistant' | 'system',
      content: r.content as string,
      sequenceNumber: r.sequence_number as number,
      timestamp: r.timestamp as string,
      tokenCount: r.token_count as number | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    }));
  }

  /** Get messages in a range (for on-demand re-extraction) */
  getMessageRange(conversationId: string, start: number, end: number): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM conversation_messages
      WHERE conversation_id = ? AND sequence_number BETWEEN ? AND ?
      ORDER BY sequence_number ASC
    `,
      )
      .all(conversationId, start, end) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      role: r.role as 'user' | 'assistant' | 'system',
      content: r.content as string,
      sequenceNumber: r.sequence_number as number,
      timestamp: r.timestamp as string,
      tokenCount: r.token_count as number | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    }));
  }

  /** Record that messages were extracted into compiled state */
  logExtraction(record: ExtractionRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO extraction_log (id, conversation_id, message_range_start, message_range_end, memory_ids, extraction_model, extraction_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.id,
        record.conversationId,
        record.messageRangeStart,
        record.messageRangeEnd,
        JSON.stringify(record.memoryIds),
        record.extractionModel || null,
        record.extractionPromptHash || null,
      );
  }

  /** Find messages that haven't been extracted yet */
  getUnextractedMessages(conversationId: string): ConversationMessage[] {
    const extracted = this.db
      .prepare(
        `
      SELECT MAX(message_range_end) as max_end FROM extraction_log
      WHERE conversation_id = ?
    `,
      )
      .get(conversationId) as { max_end: number | null } | undefined;

    const startFrom = (extracted?.max_end ?? -1) + 1;

    return this.db
      .prepare(
        `
      SELECT * FROM conversation_messages
      WHERE conversation_id = ? AND sequence_number >= ?
      ORDER BY sequence_number ASC
    `,
      )
      .all(conversationId, startFrom) as ConversationMessage[];
  }

  /** Get conversation metadata */
  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      source: row.source as string,
      startedAt: row.started_at as string,
      endedAt: row.ended_at as string | undefined,
      participantId: row.participant_id as string | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  /** List all conversations */
  listConversations(limit = 50): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY started_at DESC LIMIT ?').all(limit) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as string,
      source: r.source as string,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string | undefined,
      participantId: r.participant_id as string | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    }));
  }

  /** Get message count for a conversation */
  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM conversation_messages WHERE conversation_id = ?')
      .get(conversationId) as { count: number };
    return row.count;
  }

  /** Get total token count for a conversation */
  getTotalTokens(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM conversation_messages WHERE conversation_id = ?')
      .get(conversationId) as { total: number };
    return row.total;
  }
  /** Full-text search across all STONE messages */
  searchMessages(query: string, limit = 20): Array<ConversationMessage & { rank: number }> {
    // Sanitize: strip possessives, convert spaces to OR for natural language
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
      SELECT cm.*, fts.rank
      FROM stone_messages_fts fts
      JOIN conversation_messages cm ON cm.rowid = fts.rowid
      WHERE stone_messages_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `,
      )
      .all(sanitized, limit) as Array<Record<string, unknown> & { rank: number }>;

    return rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      role: r.role as 'user' | 'assistant' | 'system',
      content: r.content as string,
      sequenceNumber: r.sequence_number as number,
      timestamp: r.timestamp as string,
      tokenCount: r.token_count as number | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
      rank: r.rank,
    }));
  }

  /** Get neighboring messages around a specific turn (episode context) */
  getNeighborMessages(
    conversationId: string,
    sequenceNumber: number,
    windowBefore = 2,
    windowAfter = 2,
  ): ConversationMessage[] {
    const start = Math.max(0, sequenceNumber - windowBefore);
    const end = sequenceNumber + windowAfter;
    return this.getMessageRange(conversationId, start, end);
  }

  /** Get conversation with message count summary */
  getConversationSummary(id: string): (Conversation & { messageCount: number; totalTokens: number }) | null {
    const conv = this.getConversation(id);
    if (!conv) return null;
    return {
      ...conv,
      messageCount: this.getMessageCount(id),
      totalTokens: this.getTotalTokens(id),
    };
  }
}
