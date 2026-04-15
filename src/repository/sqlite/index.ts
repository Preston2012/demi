import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { StoneStore } from '../../stone/index.js';
import type { IMemoryRepository, MemoryRecordPatch } from '../interface.js';
import type {
  MemoryRecord,
  ScoredCandidate,
  RepositoryStats,
  TrustClass,
  Provenance,
  Scope,
  PermanenceStatus,
  MemoryHub,
  HubLink,
  MemoryVersion,
  MemoryConstraint,
  SelfPlayRun,
  SelfPlayResult,
  MetaMemoryStats,
} from '../../schema/memory.js';
import type { AuditEntry, NewAuditEntry } from '../../schema/audit.js';
import { DatabaseError, MemoryNotFoundError } from '../../errors.js';
import { runMigrations, initializeVectorTable } from './migrations.js';
import { populateFacets as doPopulateFacets } from '../../write/facets.js';
import { buildAllEpisodes } from '../../write/episodes.js';
import { prepareStatements, type PreparedStatements } from './queries.js';
import type { Config } from '../../config.js';

/**
 * SQLite implementation of IMemoryRepository.
 * This is the ONLY module that touches sqlite-vec and FTS5.
 * Everything else goes through the IMemoryRepository interface.
 *
 * better-sqlite3 is synchronous. Methods are async to match the
 * interface (future pgvector impl will be truly async).
 */
export class SqliteMemoryRepository implements IMemoryRepository {
  private db: Database.Database | null = null;
  private stmts: PreparedStatements | null = null;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      mkdirSync(dirname(this.config.dbPath), { recursive: true });

      this.db = new Database(this.config.dbPath);

      // WAL mode for concurrent reads
      if (this.config.walMode) {
        this.db.pragma('journal_mode = WAL');
      }
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');

      // Load sqlite-vec extension
      sqliteVec.load(this.db);

      // Run schema migrations
      runMigrations(this.db);
      initializeVectorTable(this.db, this.config.embeddingDim);

      // Prepare all statements
      this.stmts = prepareStatements(this.db);
    } catch (err) {
      throw new DatabaseError(`Failed to initialize database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.stmts = null;
    }
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- Internal helpers ---

  private getDb(): Database.Database {
    if (!this.db) throw new DatabaseError('Database not initialized. Call initialize() first.');
    return this.db;
  }

  /** Get a StoneStore for STONE writes. Cached singleton. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _stoneStore: any = null;
  getStoneStore(): unknown {
    if (!this._stoneStore) {
      const db = this.getDb();

      // StoneStore imported at top level
      this._stoneStore = new StoneStore(db);
    }
    return this._stoneStore;
  }

  /** Public accessor for raw DB handle (used by StoneStore). */
  getDatabase(): Database.Database {
    return this.getDb();
  }

  private getStmts(): PreparedStatements {
    if (!this.stmts) throw new DatabaseError('Database not initialized. Call initialize() first.');
    return this.stmts;
  }

  private rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      id: row.id as string,
      claim: row.claim as string,
      subject: row.subject as string,
      scope: row.scope as Scope,
      validFrom: (row.valid_from as string) || null,
      validTo: (row.valid_to as string) || null,
      provenance: row.provenance as Provenance,
      trustClass: row.trust_class as TrustClass,
      confidence: row.confidence as number,
      sourceHash: row.source_hash as string,
      supersedes: (row.supersedes as string) || null,
      conflictsWith: JSON.parse((row.conflicts_with as string) || '[]'),
      reviewStatus: row.review_status as MemoryRecord['reviewStatus'],
      accessCount: row.access_count as number,
      lastAccessed: row.last_accessed as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      embedding: null, // Embeddings stored in vec table, not main table
      permanenceStatus: (row.permanence_status as PermanenceStatus) || 'provisional',
      hubId: (row.hub_id as string) || null,
      hubScore: (row.hub_score as number) ?? 0,
      resolution: (row.resolution as number) ?? 3,
      memoryType: (row.memory_type as string as MemoryRecord['memoryType']) ?? 'declarative',
      versionNumber: (row.version_number as number) ?? 1,
      parentVersionId: (row.parent_version_id as string) || null,
      frozenAt: (row.frozen_at as string) || null,
      decayScore: (row.decay_score as number) ?? 1,
      storageTier: (row.storage_tier as string as MemoryRecord['storageTier']) ?? 'active',
      isInhibitory: !!(row.is_inhibitory as number),
      inhibitionTarget: (row.inhibition_target as string) || null,
      interferenceStatus: (row.interference_status as string as MemoryRecord['interferenceStatus']) ?? 'active',
      correctionCount: (row.correction_count as number) ?? 0,
      isFrozen: !!(row.is_frozen as number),
      causedBy: (row.caused_by as string) || null,
      leadsTo: (row.leads_to as string) || null,
      canonicalFactId: (row.canonical_fact_id as string) || null,
      isCanonical: row.is_canonical === undefined ? true : !!(row.is_canonical as number),
    };
  }

  private recordToRow(record: MemoryRecord) {
    return {
      id: record.id,
      claim: record.claim,
      subject: record.subject,
      scope: record.scope,
      validFrom: record.validFrom,
      validTo: record.validTo,
      provenance: record.provenance,
      trustClass: record.trustClass,
      confidence: record.confidence,
      sourceHash: record.sourceHash,
      supersedes: record.supersedes,
      conflictsWith: JSON.stringify(record.conflictsWith),
      reviewStatus: record.reviewStatus,
      accessCount: record.accessCount,
      lastAccessed: record.lastAccessed,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      permanenceStatus: record.permanenceStatus || 'provisional',
      hubId: record.hubId,
      hubScore: record.hubScore ?? 0,
      resolution: record.resolution ?? 3,
      memoryType: record.memoryType ?? 'declarative',
      versionNumber: record.versionNumber ?? 1,
      parentVersionId: record.parentVersionId,
      frozenAt: record.frozenAt,
      decayScore: record.decayScore ?? 1,
      storageTier: record.storageTier ?? 'active',
      isInhibitory: record.isInhibitory ? 1 : 0,
      inhibitionTarget: record.inhibitionTarget,
      interferenceStatus: record.interferenceStatus ?? 'active',
      correctionCount: record.correctionCount ?? 0,
      isFrozen: record.isFrozen ? 1 : 0,
      causedBy: record.causedBy,
      leadsTo: record.leadsTo,
      canonicalFactId: record.canonicalFactId ?? null,
      isCanonical: record.isCanonical === false ? 0 : 1,
    };
  }

  private computeAuditHash(
    entry: { memoryId: string | null; action: string; details: string | null; timestamp: string },
    previousHash: string | null,
  ): string {
    const payload = JSON.stringify({
      memoryId: entry.memoryId,
      action: entry.action,
      details: entry.details,
      timestamp: entry.timestamp,
      previousHash,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  // --- Write ---

  async insert(record: MemoryRecord): Promise<string> {
    const db = this.getDb();
    const stmts = this.getStmts();

    const txn = db.transaction(() => {
      // Insert main record
      stmts.insertMemory.run(this.recordToRow(record));

      // Insert embedding into vec table if present
      if (record.embedding) {
        db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(
          record.id,
          new Float32Array(record.embedding),
        );
        // R12: Dual-write binary quantized vector
        db.prepare(`INSERT INTO memories_vec_bit (id, embedding) VALUES (?, vec_quantize_binary(vec_f32(?)))`).run(
          record.id,
          new Float32Array(record.embedding),
        );
      }
    });

    try {
      txn();
      return record.id;
    } catch (err) {
      throw new DatabaseError(`Failed to insert memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async update(id: string, patch: MemoryRecordPatch): Promise<void> {
    const db = this.getDb();
    const existing = await this.getById(id);
    if (!existing) throw new MemoryNotFoundError(id);

    // Build dynamic UPDATE (only patched fields)
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    if (patch.claim !== undefined) {
      setClauses.push('claim = @claim');
      values.claim = patch.claim;
    }
    if (patch.subject !== undefined) {
      setClauses.push('subject = @subject');
      values.subject = patch.subject;
    }
    if (patch.scope !== undefined) {
      setClauses.push('scope = @scope');
      values.scope = patch.scope;
    }
    if (patch.validFrom !== undefined) {
      setClauses.push('valid_from = @validFrom');
      values.validFrom = patch.validFrom;
    }
    if (patch.validTo !== undefined) {
      setClauses.push('valid_to = @validTo');
      values.validTo = patch.validTo;
    }
    if (patch.provenance !== undefined) {
      setClauses.push('provenance = @provenance');
      values.provenance = patch.provenance;
    }
    if (patch.trustClass !== undefined) {
      setClauses.push('trust_class = @trustClass');
      values.trustClass = patch.trustClass;
    }
    if (patch.confidence !== undefined) {
      setClauses.push('confidence = @confidence');
      values.confidence = patch.confidence;
    }
    if (patch.supersedes !== undefined) {
      setClauses.push('supersedes = @supersedes');
      values.supersedes = patch.supersedes;
    }
    if (patch.conflictsWith !== undefined) {
      setClauses.push('conflicts_with = @conflictsWith');
      values.conflictsWith = JSON.stringify(patch.conflictsWith);
    }
    if (patch.reviewStatus !== undefined) {
      setClauses.push('review_status = @reviewStatus');
      values.reviewStatus = patch.reviewStatus;
    }
    if (patch.accessCount !== undefined) {
      setClauses.push('access_count = @accessCount');
      values.accessCount = patch.accessCount;
    }
    if (patch.lastAccessed !== undefined) {
      setClauses.push('last_accessed = @lastAccessed');
      values.lastAccessed = patch.lastAccessed;
    }
    if (patch.permanenceStatus !== undefined) {
      setClauses.push('permanence_status = @permanenceStatus');
      values.permanenceStatus = patch.permanenceStatus;
    }
    if (patch.hubId !== undefined) {
      setClauses.push('hub_id = @hubId');
      values.hubId = patch.hubId;
    }
    if (patch.hubScore !== undefined) {
      setClauses.push('hub_score = @hubScore');
      values.hubScore = patch.hubScore;
    }
    if (patch.resolution !== undefined) {
      setClauses.push('resolution = @resolution');
      values.resolution = patch.resolution;
    }
    if (patch.memoryType !== undefined) {
      setClauses.push('memory_type = @memoryType');
      values.memoryType = patch.memoryType;
    }
    if (patch.versionNumber !== undefined) {
      setClauses.push('version_number = @versionNumber');
      values.versionNumber = patch.versionNumber;
    }
    if (patch.parentVersionId !== undefined) {
      setClauses.push('parent_version_id = @parentVersionId');
      values.parentVersionId = patch.parentVersionId;
    }
    if (patch.frozenAt !== undefined) {
      setClauses.push('frozen_at = @frozenAt');
      values.frozenAt = patch.frozenAt;
    }
    if (patch.decayScore !== undefined) {
      setClauses.push('decay_score = @decayScore');
      values.decayScore = patch.decayScore;
    }
    if (patch.storageTier !== undefined) {
      setClauses.push('storage_tier = @storageTier');
      values.storageTier = patch.storageTier;
    }
    if (patch.isInhibitory !== undefined) {
      setClauses.push('is_inhibitory = @isInhibitory');
      values.isInhibitory = patch.isInhibitory ? 1 : 0;
    }
    if (patch.inhibitionTarget !== undefined) {
      setClauses.push('inhibition_target = @inhibitionTarget');
      values.inhibitionTarget = patch.inhibitionTarget;
    }
    if (patch.interferenceStatus !== undefined) {
      setClauses.push('interference_status = @interferenceStatus');
      values.interferenceStatus = patch.interferenceStatus;
    }
    if (patch.correctionCount !== undefined) {
      setClauses.push('correction_count = @correctionCount');
      values.correctionCount = patch.correctionCount;
    }
    if (patch.isFrozen !== undefined) {
      setClauses.push('is_frozen = @isFrozen');
      values.isFrozen = patch.isFrozen ? 1 : 0;
    }
    if (patch.causedBy !== undefined) {
      setClauses.push('caused_by = @causedBy');
      values.causedBy = patch.causedBy;
    }
    if (patch.leadsTo !== undefined) {
      setClauses.push('leads_to = @leadsTo');
      values.leadsTo = patch.leadsTo;
    }

    // Always update updated_at
    const now = patch.updatedAt ?? new Date().toISOString();
    setClauses.push('updated_at = @updatedAt');
    values.updatedAt = now;

    if (setClauses.length === 1) return; // Only updated_at, nothing to patch

    const txn = db.transaction(() => {
      db.prepare(`UPDATE memories SET ${setClauses.join(', ')} WHERE id = @id AND deleted_at IS NULL`).run(values);

      // Update embedding in vec table if present in patch
      if (patch.embedding !== undefined) {
        db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id);
        db.prepare(`DELETE FROM memories_vec_bit WHERE id = ?`).run(id);
        if (patch.embedding) {
          db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(
            id,
            new Float32Array(patch.embedding),
          );
          // R12: Dual-write binary quantized vector
          db.prepare(`INSERT INTO memories_vec_bit (id, embedding) VALUES (?, vec_quantize_binary(vec_f32(?)))`).run(
            id,
            new Float32Array(patch.embedding),
          );
        }
      }
    });

    try {
      txn();
    } catch (err) {
      throw new DatabaseError(`Failed to update memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const stmts = this.getStmts();
    const existing = await this.getById(id);
    if (!existing) throw new MemoryNotFoundError(id);

    const now = new Date().toISOString();
    const result = stmts.softDeleteMemory.run({
      id,
      deletedAt: now,
      deleteReason: reason,
      updatedAt: now,
    });

    if (result.changes === 0) {
      throw new MemoryNotFoundError(id);
    }
  }

  // --- Read: candidate generation ---

  async searchFTS(query: string, limit: number): Promise<ScoredCandidate[]> {
    const stmts = this.getStmts();

    try {
      const rows = stmts.searchFTS.all({ query, limit }) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as string,
        record: this.rowToRecord(row),
        lexicalScore: Math.abs(row.fts_rank as number), // bm25 returns negative scores
        vectorScore: 0,
        source: 'fts' as const,
        hubExpansionScore: 0,
        inhibitionPenalty: 0,
        primingBonus: 0,
        cascadeDepth: 0,
      }));
    } catch (err) {
      // FTS5 MATCH can throw on malformed query syntax
      if (err instanceof Error && err.message.includes('fts5')) {
        return [];
      }
      throw new DatabaseError(`FTS search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async searchVector(embedding: number[], limit: number): Promise<ScoredCandidate[]> {
    const db = this.getDb();

    try {
      const rows = db
        .prepare(
          `
        SELECT id, distance
        FROM memories_vec
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `,
        )
        .all(new Float32Array(embedding), limit) as { id: string; distance: number }[];

      const candidates: ScoredCandidate[] = [];
      for (const row of rows) {
        const record = await this.getById(row.id);
        if (record) {
          candidates.push({
            id: row.id,
            record,
            lexicalScore: 0,
            vectorScore: 1 - row.distance, // Convert distance to similarity
            source: 'vector' as const,
            hubExpansionScore: 0,
            inhibitionPenalty: 0,
            primingBonus: 0,
            cascadeDepth: 0,
          });
        }
      }
      return candidates;
    } catch (err) {
      throw new DatabaseError(`Vector search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    const stmts = this.getStmts();
    const row = stmts.getById.get({ id }) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    if (ids.length === 0) return [];
    const rows = stmts.getByIds.all({ ids: JSON.stringify(ids) }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getConflicts(id: string): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const record = await this.getById(id);
    if (!record || record.conflictsWith.length === 0) return [];

    const rows = stmts.getConflicts.all({
      conflictIds: JSON.stringify(record.conflictsWith),
    }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // --- Read: dedup ---

  async findBySourceHash(hash: string): Promise<MemoryRecord | null> {
    const stmts = this.getStmts();
    const row = stmts.findBySourceHash.get({ sourceHash: hash }) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async findSimilar(embedding: number[], threshold: number): Promise<ScoredCandidate[]> {
    const candidates = await this.searchVector(embedding, 10);
    return candidates.filter((c) => c.vectorScore >= threshold);
  }

  // --- Review queue ---

  async getPendingReview(limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getPendingReview.all({ limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getSpotCheckBatch(limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getSpotCheckBatch.all({ limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async flagForSpotCheck(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.flagForSpotCheck.run({
      memoryId: id,
      flaggedAt: new Date().toISOString(),
    });
  }

  // --- Promotion ---

  async getPromotionCandidates(minAccessCount: number, minAgeDays: number, limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = stmts.getPromotionCandidates.all({
      minAccessCount,
      cutoffDate,
      limit,
    }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // --- Metadata updates (fast path, no LLM) ---

  async incrementAccessCount(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.incrementAccessCount.run({ id, now: new Date().toISOString() });
  }

  async updateLastAccessed(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.updateLastAccessed.run({ id, now: new Date().toISOString() });
  }

  // --- Audit log ---

  async appendAuditLog(entry: NewAuditEntry): Promise<AuditEntry> {
    const stmts = this.getStmts();
    const previousHash = await this.getLatestAuditHash();
    const now = new Date().toISOString();
    const id = uuid();

    const auditEntry = {
      id,
      memoryId: entry.memoryId,
      action: entry.action,
      details: entry.details,
      timestamp: now,
    };

    const hash = this.computeAuditHash(auditEntry, previousHash);

    const fullEntry: AuditEntry = {
      ...auditEntry,
      previousHash,
      hash,
    };

    stmts.insertAuditEntry.run({
      id: fullEntry.id,
      memoryId: fullEntry.memoryId,
      action: fullEntry.action,
      details: fullEntry.details,
      previousHash: fullEntry.previousHash,
      hash: fullEntry.hash,
      timestamp: fullEntry.timestamp,
    });

    return fullEntry;
  }

  async getAuditLog(memoryId: string): Promise<AuditEntry[]> {
    const stmts = this.getStmts();
    const rows = stmts.getAuditByMemoryId.all({ memoryId }) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      memoryId: (row.memory_id as string) || null,
      action: row.action as AuditEntry['action'],
      details: (row.details as string) || null,
      previousHash: (row.previous_hash as string) || null,
      hash: row.hash as string,
      timestamp: row.timestamp as string,
    }));
  }

  async getLatestAuditHash(): Promise<string | null> {
    const stmts = this.getStmts();
    const row = stmts.getLatestAuditHash.get() as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  // --- Export / stats ---

  async *exportAll(): AsyncIterable<MemoryRecord> {
    const stmts = this.getStmts();
    const pageSize = 100;
    let cursor = '';

    while (true) {
      const rows = stmts.exportPage.all({ cursor, pageSize }) as Record<string, unknown>[];
      if (rows.length === 0) break;

      for (const row of rows) {
        yield this.rowToRecord(row);
      }

      const lastRow = rows[rows.length - 1];
      if (!lastRow) break;
      cursor = lastRow.created_at as string;
    }
  }

  async getStats(): Promise<RepositoryStats> {
    const stmts = this.getStmts();

    const totalRow = stmts.countAll.get() as { count: number };
    const trustRows = stmts.countByTrustClass.all() as { trust_class: string; count: number }[];
    const provRows = stmts.countByProvenance.all() as { provenance: string; count: number }[];
    const scopeRows = stmts.countByScope.all() as { scope: string; count: number }[];
    const pendingRow = stmts.countPendingReview.get() as { count: number };
    const avgRow = stmts.avgConfidence.get() as { avg: number | null };
    const oldestRow = stmts.oldestMemory.get() as { created_at: string } | undefined;
    const newestRow = stmts.newestMemory.get() as { created_at: string } | undefined;

    const byTrustClass = {
      confirmed: 0,
      'auto-approved': 0,
      quarantined: 0,
      rejected: 0,
    } as Record<TrustClass, number>;
    for (const row of trustRows) {
      byTrustClass[row.trust_class as TrustClass] = row.count;
    }

    const byProvenance = {
      'user-confirmed': 0,
      'llm-extracted-confident': 0,
      'llm-extracted-quarantine': 0,
      imported: 0,
    } as Record<Provenance, number>;
    for (const row of provRows) {
      byProvenance[row.provenance as Provenance] = row.count;
    }

    const byScope = {
      global: 0,
      project: 0,
      session: 0,
    } as Record<Scope, number>;
    for (const row of scopeRows) {
      byScope[row.scope as Scope] = row.count;
    }

    return {
      totalMemories: totalRow.count,
      byTrustClass,
      byProvenance,
      byScope,
      pendingReview: pendingRow.count,
      averageConfidence: avgRow.avg ?? 0,
      oldestMemory: oldestRow?.created_at ?? null,
      newestMemory: newestRow?.created_at ?? null,
    };
  }

  async getLastActivityTimestamp(): Promise<string | null> {
    const stmts = this.getStmts();
    const row = stmts.lastActivity.get() as { last: string | null } | undefined;
    return row?.last ?? null;
  }

  // --- Bulk (for circuit breaker) ---

  async countAll(): Promise<number> {
    const stmts = this.getStmts();
    const row = stmts.countAll.get() as { count: number };
    return row.count;
  }

  // --- System metadata ---

  async setMetadata(key: string, value: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.setMetadata.run({ key, value, updatedAt: new Date().toISOString() });
  }

  async getMetadata(key: string): Promise<string | null> {
    const stmts = this.getStmts();
    const row = stmts.getMetadata.get({ key }) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // --- Tags ---

  async getMemoryTags(memoryId: string): Promise<string[]> {
    const stmts = this.getStmts();
    const rows = stmts.getMemoryTags.all({ memoryId }) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  async setMemoryTags(memoryId: string, tags: string[]): Promise<void> {
    const db = this.getDb();
    const stmts = this.getStmts();
    db.transaction(() => {
      stmts.deleteMemoryTags.run({ memoryId });
      for (const tag of tags) {
        stmts.insertMemoryTag.run({ memoryId, tag });
      }
    })();
  }

  async searchByTag(tag: string, limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.searchByTag.all({ tag, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getAllTags(): Promise<{ tag: string; count: number }[]> {
    const stmts = this.getStmts();
    return stmts.getAllTags.all() as { tag: string; count: number }[];
  }

  // --- Hubs ---

  async getHubs(limit: number): Promise<MemoryHub[]> {
    const stmts = this.getStmts();
    const rows = stmts.getHubs.all({ limit }) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      claim: r.claim as string,
      hubType: r.hub_type as string,
      createdAt: r.created_at as string,
      accessCount: r.access_count as number,
    }));
  }

  async getHubById(hubId: string): Promise<MemoryHub | null> {
    const stmts = this.getStmts();
    const row = stmts.getHubById.get({ id: hubId }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      claim: row.claim as string,
      hubType: row.hub_type as string,
      createdAt: row.created_at as string,
      accessCount: row.access_count as number,
    };
  }

  async createHub(hub: MemoryHub): Promise<string> {
    const stmts = this.getStmts();
    stmts.insertHub.run({
      id: hub.id,
      claim: hub.claim,
      hubType: hub.hubType,
      createdAt: hub.createdAt,
      accessCount: hub.accessCount,
    });
    return hub.id;
  }

  async linkToHub(memoryId: string, hubId: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.insertHubLink.run({ memoryId, hubId, linkedAt: new Date().toISOString() });
  }

  async unlinkFromHub(memoryId: string, hubId: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.deleteHubLink.run({ memoryId, hubId });
  }

  async getHubLinks(memoryId: string): Promise<HubLink[]> {
    const stmts = this.getStmts();
    const rows = stmts.getHubLinks.all({ memoryId }) as Record<string, unknown>[];
    return rows.map((r) => ({
      memoryId: r.memory_id as string,
      hubId: r.hub_id as string,
      linkedAt: r.linked_at as string,
    }));
  }

  async getHubMembers(hubId: string, limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getHubMembers.all({ hubId, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async incrementHubAccessCount(hubId: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.incrementHubAccess.run({ id: hubId });
  }

  // --- Versions ---

  async createVersion(version: MemoryVersion): Promise<string> {
    const stmts = this.getStmts();
    stmts.insertVersion.run({
      id: version.id,
      memoryId: version.memoryId,
      claim: version.claim,
      changedAt: version.changedAt,
      reason: version.reason,
    });
    return version.id;
  }

  async getVersionHistory(memoryId: string): Promise<MemoryVersion[]> {
    const stmts = this.getStmts();
    const rows = stmts.getVersionHistory.all({ memoryId }) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      memoryId: r.memory_id as string,
      claim: r.claim as string,
      changedAt: r.changed_at as string,
      reason: r.reason as string,
    }));
  }

  // --- Inhibitory ---

  async getInhibitoryMemories(subject?: string): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = subject
      ? (stmts.getInhibitoryBySubject.all({ subject }) as Record<string, unknown>[])
      : (stmts.getInhibitoryMemories.all() as Record<string, unknown>[]);
    return rows.map((row) => this.rowToRecord(row));
  }

  async getBySubject(subject: string, limit: number): Promise<MemoryRecord[]> {
    const rows = this.db!.prepare(
      'SELECT * FROM memories WHERE subject = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
    ).all(subject, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getActiveInhibitions(): Promise<MemoryRecord[]> {
    return this.getInhibitoryMemories();
  }

  // --- Interference ---

  async getColdStorageMemories(limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getColdStorage.all({ limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async moveToColdStorage(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.setInterferenceStatus.run({ id, status: 'cold', now: new Date().toISOString() });
  }

  async resurrectFromColdStorage(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.setInterferenceStatus.run({ id, status: 'active', now: new Date().toISOString() });
  }

  // --- Constraints ---

  async getConstraints(activeOnly = false): Promise<MemoryConstraint[]> {
    const stmts = this.getStmts();
    const rows = (activeOnly ? stmts.getActiveConstraints : stmts.getConstraints).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      claim: r.claim as string,
      constraintType: r.constraint_type as string,
      priority: r.priority as number,
      isActive: Boolean(r.is_active),
      createdAt: r.created_at as string,
    }));
  }

  async insertConstraint(constraint: MemoryConstraint): Promise<string> {
    const stmts = this.getStmts();
    stmts.insertConstraint.run({
      id: constraint.id,
      claim: constraint.claim,
      constraintType: constraint.constraintType,
      priority: constraint.priority,
      isActive: constraint.isActive ? 1 : 0,
      createdAt: constraint.createdAt,
    });
    return constraint.id;
  }

  async deactivateConstraint(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.deactivateConstraint.run({ id });
  }

  // --- Causal chains ---

  async getCausalChain(memoryId: string, direction: 'up' | 'down', maxDepth: number): Promise<MemoryRecord[]> {
    const chain: MemoryRecord[] = [];
    let currentId: string | null = memoryId;
    let depth = 0;
    while (currentId && depth < maxDepth) {
      const record = await this.getById(currentId);
      if (!record) break;
      if (depth > 0) chain.push(record);
      currentId = direction === 'up' ? record.causedBy : record.leadsTo;
      depth++;
    }
    return chain;
  }

  // --- Self-play ---

  async insertSelfPlayRun(run: SelfPlayRun): Promise<string> {
    const stmts = this.getStmts();
    stmts.insertSelfPlayRun.run({
      id: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      queriesGenerated: run.queriesGenerated,
      retrievalsPassed: run.retrievalsPassed,
      retrievalsFailed: run.retrievalsFailed,
      notes: run.notes,
    });
    return run.id;
  }

  async updateSelfPlayRun(runId: string, patch: Partial<SelfPlayRun>): Promise<void> {
    const stmts = this.getStmts();
    stmts.updateSelfPlayRun.run({
      id: runId,
      completedAt: patch.completedAt ?? null,
      queriesGenerated: patch.queriesGenerated ?? 0,
      retrievalsPassed: patch.retrievalsPassed ?? 0,
      retrievalsFailed: patch.retrievalsFailed ?? 0,
      notes: patch.notes ?? null,
    });
  }

  async insertSelfPlayResult(result: SelfPlayResult): Promise<string> {
    const stmts = this.getStmts();
    stmts.insertSelfPlayResult.run({
      id: result.id,
      runId: result.runId,
      query: result.query,
      expectedMemoryId: result.expectedMemoryId,
      actualMemoryId: result.actualMemoryId,
      passed: result.passed ? 1 : 0,
      scoreGap: result.scoreGap,
      details: result.details,
    });
    return result.id;
  }

  async getSelfPlayResults(runId: string): Promise<SelfPlayResult[]> {
    const stmts = this.getStmts();
    const rows = stmts.getSelfPlayResults.all({ runId }) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      query: r.query as string,
      expectedMemoryId: (r.expected_memory_id as string) || null,
      actualMemoryId: (r.actual_memory_id as string) || null,
      passed: Boolean(r.passed),
      scoreGap: r.score_gap as number,
      details: (r.details as string) || null,
    }));
  }

  async getLatestSelfPlayRun(): Promise<SelfPlayRun | null> {
    const stmts = this.getStmts();
    const row = stmts.getLatestSelfPlayRun.get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      startedAt: row.started_at as string,
      completedAt: (row.completed_at as string) || null,
      queriesGenerated: row.queries_generated as number,
      retrievalsPassed: row.retrievals_passed as number,
      retrievalsFailed: row.retrievals_failed as number,
      notes: (row.notes as string) || null,
    };
  }

  // --- Freeze ---

  async getFrozenMemories(limit: number): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getFrozenMemories.all({ limit }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async freezeMemory(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.freezeMemory.run({ id, now: new Date().toISOString() });
  }

  async unfreezeMemory(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.unfreezeMemory.run({ id, now: new Date().toISOString() });
  }

  // --- Correction ---

  async incrementCorrectionCount(id: string): Promise<void> {
    const stmts = this.getStmts();
    stmts.incrementCorrectionCount.run({ id, now: new Date().toISOString() });
  }

  // --- R11: Facets ---

  async populateFacets(record: MemoryRecord): Promise<void> {
    const db = this.getDb();
    doPopulateFacets(db, record);
  }

  // --- R11: Episodes ---

  async searchEpisodeVec(embedding: number[], limit: number): Promise<Array<{ id: string; distance: number }>> {
    const db = this.getDb();
    try {
      const rows = db
        .prepare(
          `
        SELECT id, distance FROM episode_vec
        WHERE embedding MATCH ?
        ORDER BY distance ASC
        LIMIT ?
      `,
        )
        .all(new Float32Array(embedding), limit) as Array<{ id: string; distance: number }>;
      return rows;
    } catch {
      // episode_vec may be empty
      return [];
    }
  }

  async getEpisodeMemberFactIds(episodeId: string): Promise<string[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT fact_id FROM episode_facts WHERE episode_id = ? ORDER BY ordinal')
      .all(episodeId) as Array<{ fact_id: string }>;
    return rows.map((r) => r.fact_id);
  }

  async getEpisodeById(episodeId: string): Promise<{
    id: string;
    subject: string;
    title: string;
    summary: string;
    timeframe_start: string | null;
    timeframe_end: string | null;
    fact_count: number;
  } | null> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      subject: row.subject as string,
      title: row.title as string,
      summary: row.summary as string,
      timeframe_start: (row.timeframe_start as string) || null,
      timeframe_end: (row.timeframe_end as string) || null,
      fact_count: (row.fact_count as number) || 0,
    };
  }

  async getEpisodeFactClaims(episodeId: string): Promise<string[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        `
      SELECT m.claim FROM episode_facts ef
      JOIN memories m ON m.id = ef.fact_id
      WHERE ef.episode_id = ?
      ORDER BY ef.ordinal ASC
    `,
      )
      .all(episodeId) as Array<{ claim: string }>;
    return rows.map((r) => r.claim);
  }

  async insertEpisode(episode: {
    id: string;
    subject: string;
    title: string;
    summary: string;
    timeframe_start: string | null;
    timeframe_end: string | null;
    session_source: string | null;
    fact_count: number;
  }): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT OR REPLACE INTO episodes (id, subject, title, summary, timeframe_start, timeframe_end, session_source, fact_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      episode.id,
      episode.subject,
      episode.title,
      episode.summary,
      episode.timeframe_start,
      episode.timeframe_end,
      episode.session_source,
      episode.fact_count,
      now,
      now,
    );
  }

  async insertEpisodeFact(episodeId: string, factId: string, ordinal: number): Promise<void> {
    const db = this.getDb();
    db.prepare('INSERT OR IGNORE INTO episode_facts (episode_id, fact_id, ordinal) VALUES (?, ?, ?)').run(
      episodeId,
      factId,
      ordinal,
    );
  }

  async insertEpisodeVec(id: string, embedding: number[]): Promise<void> {
    const db = this.getDb();
    db.prepare('INSERT OR REPLACE INTO episode_vec (id, embedding) VALUES (?, ?)').run(id, new Float32Array(embedding));
    db.prepare(
      'INSERT OR REPLACE INTO episode_vec_bit (id, embedding) VALUES (?, vec_quantize_binary(vec_f32(?)))',
    ).run(id, new Float32Array(embedding));
  }

  // --- R11: State Packs ---

  async updateStatePack(_record: MemoryRecord): Promise<void> {
    // R11 KILLED: State packs (-2.4 LOCOMO, -2.3 BEAM)
  }

  async buildStatePackInjection(_query: string, _isCurrentState: boolean): Promise<string> {
    // R11 KILLED: State packs
    return '';
  }

  // --- R11: Summaries ---

  // --- R11: Bridge ---

  async retrieveBridgeFacts(_subjects: string[]): Promise<Array<{ id: string; record: MemoryRecord; score: number }>> {
    // R11 KILLED: Bridge retrieval (-0.3)
    return [];
  }

  async populateBridgeFact(_factId: string, _primarySubject: string, _mentionedSubjectsJson: string): Promise<void> {
    // R11 KILLED: Bridge retrieval
  }

  async backfillBridgeFacts(): Promise<number> {
    // R11 KILLED: Bridge retrieval
    return 0;
  }

  // --- R11: Post-seed hooks for benchmarks ---

  async runPostSeedHooks(apiKey?: string): Promise<{ episodes: number; summaries: number; bridges: number }> {
    const db = this.getDb();
    let episodes = 0;

    if (process.env.EPISODES_ENABLED === 'true') {
      const eps = await buildAllEpisodes(db, apiKey);
      episodes = eps.length;
    }

    // R11 KILLED: summaries (-1.0) and bridge retrieval (-0.3)
    return { episodes, summaries: 0, bridges: 0 };
  }

  async buildSummaryInjection(_queryEmbedding: number[]): Promise<{ text: string; subjects: string[] }> {
    // R11 KILLED: Summaries (-1.0)
    return { text: '', subjects: [] };
  }

  // --- Meta-memory ---

  async getMetaMemoryStats(): Promise<MetaMemoryStats> {
    const stmts = this.getStmts();
    const totalRow = stmts.countAll.get() as { count: number };
    const topSubjects = stmts.topSubjects.all() as { subject: string; count: number }[];
    const stalest = stmts.stalestMemories.all() as { id: string; claim: string; last_accessed: string }[];
    const mostAccessed = stmts.mostAccessedMemories.all() as { id: string; claim: string; access_count: number }[];
    const inhibRow = stmts.countInhibitory.get() as { count: number };
    const frozenRow = stmts.countFrozen.get() as { count: number };
    const coldRow = stmts.countColdStorage.get() as { count: number };
    const hubRow = stmts.countHubs.get() as { count: number };

    return {
      totalMemories: totalRow.count,
      topSubjects,
      coverageGaps: [], // Computed by learn layer, not repository
      stalestMemories: stalest.map((r) => ({ id: r.id, claim: r.claim, lastAccessed: r.last_accessed })),
      mostAccessed: mostAccessed.map((r) => ({ id: r.id, claim: r.claim, accessCount: r.access_count })),
      inhibitoryCount: inhibRow.count,
      frozenCount: frozenRow.count,
      coldStorageCount: coldRow.count,
      hubCount: hubRow.count,
    };
  }
}
