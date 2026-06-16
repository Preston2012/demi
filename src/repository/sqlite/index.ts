import Database from 'better-sqlite3-multiple-ciphers';
import { onByDefault } from '../../config/flag-defaults.js';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { StoneStore } from '../../stone/index.js';
import type { IMemoryRepository, MemoryRecordPatch, HardDeleteCounts, AmendResult } from '../interface.js';
import type { AssertionTriple } from '../../plan/types.js';
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
import { buildEpisodes } from '../../write/episodes.js';
import { prepareStatements, type PreparedStatements } from './queries.js';
import type { Config } from '../../config.js';
import { span } from '../../telemetry/index.js';
import { bindMaterializer, seedDefaultPolicies } from '../../materializer/index.js';

/**
 * R29 WB-2: thrown inside the audit write transaction when the per-user
 * chain_head moved between read and compare-and-set. Caught by the bounded
 * retry loop in appendAuditWithChainHead; never escapes the repository.
 */
class ChainHeadConflict extends Error {
  constructor() {
    super('chain_head compare-and-set miss');
    this.name = 'ChainHeadConflict';
  }
}

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

      // S50: SQLCipher encryption-at-rest. Apply key BEFORE any other pragma
      // or DDL so the file header is encrypted from the first write.
      // :memory: databases are unencrypted (driver rejects PRAGMA key on them);
      // all real disk-backed memories use AES-256 via SQLCipher v4 format.
      if (this.config.dbEncryptionKey && this.config.dbPath !== ':memory:') {
        this.db.pragma(`key = "x'${this.config.dbEncryptionKey}'"`);
        this.db.pragma('cipher_compatibility = 4');
      }

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

      // Wedge 3: bind materializer + seed default policies. Both run
      // unconditionally. Seed is idempotent (INSERT OR IGNORE) so it
      // costs nothing when the flag is off, and it removes the
      // footgun where flipping MATERIALIZER_ENABLED at runtime
      // without restart would throw on missing 'default' policy.
      const stone = new StoneStore(this.db);
      bindMaterializer(this.db, stone);
      seedDefaultPolicies(this.db);
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

  /**
   * S3: synchronous-only transaction wrapper. better-sqlite3 is sync; the
   * earlier implementation accepted an async fn and held the write lock
   * across `await`, which would freeze every concurrent writer behind any
   * I/O performed inside the transaction. The new contract requires a
   * sync function, do all I/O (LLM calls, HTTP, etc.) BEFORE calling
   * this, and only enter the transaction for the actual SQL batch.
   *
   * Uses better-sqlite3's native `db.transaction()` which manages
   * BEGIN/COMMIT/ROLLBACK + savepoints correctly under nesting.
   */
  runInTransaction<T>(fn: () => T): T {
    const db = this.getDb();
    const txn = db.transaction(fn);
    return txn();
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
      userId: (row.user_id as string) || 'system',
      externalRef: (row.external_ref as string) || null,
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
      // Packet A: bi-temporal columns (Graphiti pattern)
      validAt: (row.valid_at as string) || null,
      invalidAt: (row.invalid_at as string) || null,
      // Packet C3 / Bug 3: persona flag
      persona: !!(row.persona as number),
      // S59 / TEMPR: session and episode IDs (nullable, set by writers with
      // session context; ordinary user writes leave NULL).
      sessionId: (row.session_id as string) || null,
      episodeId: (row.episode_id as string) || null,
      // D1 + A7 (S72): temporal parse IR audit columns. NULL when the
      // resolver did not mutate the claim (the common case).
      rawClaim: (row.raw_claim as string) || null,
      normalization: (row.normalization as string) || null,
    };
  }

  private recordToRow(record: MemoryRecord) {
    return {
      id: record.id,
      userId: record.userId || 'system',
      externalRef: record.externalRef ?? null,
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
      // Packet A: bi-temporal columns
      validAt: record.validAt ?? null,
      invalidAt: record.invalidAt ?? null,
      // Packet C3 / Bug 3: persona flag
      persona: record.persona ? 1 : 0,
      // S59 / TEMPR: session and episode IDs
      sessionId: record.sessionId ?? null,
      episodeId: record.episodeId ?? null,
      // D1 + A7 (S72): temporal parse IR audit columns
      rawClaim: record.rawClaim ?? null,
      normalization: record.normalization ?? null,
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

  /**
   * R29 WB-2: append an audit entry under the per-user chain head with a
   * compare-and-set inside an IMMEDIATE transaction. Reading the prior head
   * (chain_head) and writing the new one happen in the same exclusive write
   * transaction, so two concurrent writers cannot read the same head and
   * fork the chain (R29-N8). On a CAS miss (head moved under us) we retry
   * with a freshly read head; after a bounded number of attempts we hard
   * error rather than silently break the chain.
   *
   * `inTxnBody`, when provided, runs inside the same transaction BEFORE the
   * audit row is inserted, so insertWithAudit can land the memory, vectors,
   * and supersession atomically with the audit entry. It is re-run on retry
   * against a clean (rolled-back) state, so it must be idempotent w.r.t. the
   * transaction (it is: every statement is undone on rollback).
   */
  private appendAuditWithChainHead(userId: string, audit: NewAuditEntry, inTxnBody?: () => void): AuditEntry {
    const db = this.getDb();
    const stmts = this.getStmts();
    const MAX_ATTEMPTS = 8;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const txn = db.transaction((): AuditEntry => {
          const headRow = stmts.selectChainHead.get({ userId }) as { lastHash: string | null } | undefined;
          const previousHash = headRow?.lastHash ?? null;
          const timestamp = new Date().toISOString();

          // Memory + vectors + supersession (when supplied) land first, so
          // the whole unit commits or rolls back together.
          inTxnBody?.();

          const core = {
            id: uuid(),
            memoryId: audit.memoryId,
            action: audit.action,
            details: audit.details,
            timestamp,
          };
          const hash = this.computeAuditHash(core, previousHash);
          const fullEntry: AuditEntry = { ...core, userId, previousHash, hash };

          stmts.insertAuditEntry.run({
            id: fullEntry.id,
            userId,
            memoryId: fullEntry.memoryId,
            action: fullEntry.action,
            details: fullEntry.details,
            previousHash: fullEntry.previousHash,
            hash: fullEntry.hash,
            timestamp: fullEntry.timestamp,
          });

          if (headRow === undefined) {
            // First entry for this user. A concurrent first-writer racing us
            // collides on the chain_head PK and we retry.
            stmts.insertChainHead.run({ userId, lastHash: hash, updatedAt: timestamp });
          } else {
            const res = stmts.casUpdateChainHead.run({
              userId,
              oldHash: previousHash,
              newHash: hash,
              updatedAt: timestamp,
            });
            if (res.changes !== 1) throw new ChainHeadConflict();
          }

          return fullEntry;
        });

        return txn.immediate() as AuditEntry;
      } catch (err) {
        if (err instanceof ChainHeadConflict) continue;
        if (err instanceof Error && /UNIQUE constraint failed: chain_head/.test(err.message)) {
          continue;
        }
        throw err;
      }
    }

    throw new DatabaseError(
      `audit chain_head compare-and-set failed after ${MAX_ATTEMPTS} attempts (concurrent writers on user ${userId})`,
    );
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

  /**
   * S5: atomic write of a memory record together with its supersession
   * updates and audit-log entry, inside a single synchronous transaction.
   *
   * Before this method, the write pipeline did three things back-to-back
   * as separate calls: `repo.insert(record)`, raw `UPDATE memories SET
   * invalid_at` per superseded id, then `repo.appendAuditLog(...)`. If
   * the process died between any two, the DB ended up in a half-written
   * state (memory exists with no audit entry, or superseded facts not
   * invalidated). The per-call transactions inside `insert()` and
   * `appendAuditLog()` didn't protect against the cross-call gap.
   *
   * This method takes all the pieces, computes the audit hash up-front
   * (so no async work happens inside the sync transaction), then runs
   * insert + vec + bit + supersession + audit in one BEGIN/COMMIT block.
   *
   * Returns the full audit entry that was written so callers can log it.
   */
  async insertWithAudit(
    record: MemoryRecord,
    audit: NewAuditEntry,
    userId: string,
    options: { supersedeIds?: string[]; supersedeAt?: string } = {},
  ): Promise<{ memoryId: string; audit: AuditEntry }> {
    const db = this.getDb();
    const stmts = this.getStmts();

    // R29 WB-2: the head read, memory/vector/supersession writes, audit
    // insert, and chain_head compare-and-set all run in one IMMEDIATE
    // transaction (see appendAuditWithChainHead). The supersession block is
    // unchanged: we don't filter on user_id because the write pipeline only
    // feeds us supersedeIds owned by this user (the trust branch already
    // scoped them via repo.getByIds(..., userId)).
    try {
      const fullAudit = this.appendAuditWithChainHead(userId, audit, () => {
        stmts.insertMemory.run(this.recordToRow(record));
        if (record.embedding) {
          db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(
            record.id,
            new Float32Array(record.embedding),
          );
          db.prepare(`INSERT INTO memories_vec_bit (id, embedding) VALUES (?, vec_quantize_binary(vec_f32(?)))`).run(
            record.id,
            new Float32Array(record.embedding),
          );
        }
        if (options.supersedeIds && options.supersedeIds.length > 0 && options.supersedeAt) {
          const stmt = db.prepare(`UPDATE memories SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL`);
          for (const oldId of options.supersedeIds) {
            stmt.run(options.supersedeAt, oldId);
          }
        }
      });
      return { memoryId: record.id, audit: fullAudit };
    } catch (err) {
      throw new DatabaseError(`Failed atomic insertWithAudit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async update(id: string, patch: MemoryRecordPatch, userId: string = 'system'): Promise<void> {
    const db = this.getDb();
    const existing = await this.getById(id, userId);
    if (!existing) throw new MemoryNotFoundError(id);

    // Build dynamic UPDATE (only patched fields). user_id is part of the
    // WHERE clause to prevent cross-user mutation; never SET-able.
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id, userId };

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
    // Packet A: bi-temporal patch handlers
    if (patch.validAt !== undefined) {
      setClauses.push('valid_at = @validAt');
      values.validAt = patch.validAt;
    }
    if (patch.invalidAt !== undefined) {
      setClauses.push('invalid_at = @invalidAt');
      values.invalidAt = patch.invalidAt;
    }

    // Always update updated_at
    const now = patch.updatedAt ?? new Date().toISOString();
    setClauses.push('updated_at = @updatedAt');
    values.updatedAt = now;

    if (setClauses.length === 1) return; // Only updated_at, nothing to patch

    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE memories SET ${setClauses.join(', ')} WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`,
      ).run(values);

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

  async softDelete(id: string, reason: string, userId: string = 'system'): Promise<void> {
    const stmts = this.getStmts();
    const existing = await this.getById(id, userId);
    if (!existing) throw new MemoryNotFoundError(id);

    const now = new Date().toISOString();
    const result = stmts.softDeleteMemory.run({
      id,
      userId,
      deletedAt: now,
      deleteReason: reason,
      updatedAt: now,
    });

    if (result.changes === 0) {
      throw new MemoryNotFoundError(id);
    }
  }

  // --- Wedge 1.5 Phase 4: AMB S1 hard-delete cascade ---

  async hardDelete(memoryId: string, userId: string): Promise<HardDeleteCounts> {
    const db = this.getDb();

    const zero: HardDeleteCounts = {
      memory: 0,
      embedding: 0,
      fts: 0,
      tags: 0,
      versions: 0,
      hubLinks: 0,
      episodes: 0,
    };

    // Defense-in-depth: ownership pre-check. If the memory does not exist
    // or belongs to a different user, return zero-counts (cross-tenant no-op).
    // Tenant scoping is also enforced in the final DELETE WHERE clause.
    const ownerRow = db.prepare(`SELECT user_id FROM memories WHERE id = ?`).get(memoryId) as
      | { user_id: string }
      | undefined;
    if (!ownerRow || ownerRow.user_id !== userId) {
      return zero;
    }

    const counts: HardDeleteCounts = { ...zero };

    const txn = db.transaction(() => {
      // Children first (mirrors deleteUserCascade table inventory + guards).
      const guardedRun = (sql: string, params: unknown[]): number => {
        try {
          const res = db.prepare(sql).run(...params);
          return Number(res.changes ?? 0);
        } catch (err) {
          if (err instanceof Error && err.message.includes('no such table')) return 0;
          throw err;
        }
      };

      counts.tags = guardedRun(`DELETE FROM memory_tags WHERE memory_id = ?`, [memoryId]);
      counts.versions = guardedRun(`DELETE FROM memory_versions WHERE memory_id = ?`, [memoryId]);
      counts.hubLinks = guardedRun(`DELETE FROM hub_links WHERE memory_id = ?`, [memoryId]);
      guardedRun(`DELETE FROM structural_tags WHERE memory_id = ?`, [memoryId]);
      guardedRun(`DELETE FROM spot_checks WHERE memory_id = ?`, [memoryId]);
      guardedRun(`DELETE FROM memory_edges WHERE src_id = ? OR dst_id = ?`, [memoryId, memoryId]);
      guardedRun(`DELETE FROM inhibition_edges WHERE src_id = ? OR dst_id = ?`, [memoryId, memoryId]);
      guardedRun(`DELETE FROM procedures WHERE memory_id = ?`, [memoryId]);

      counts.episodes = guardedRun(`DELETE FROM episode_facts WHERE fact_id = ?`, [memoryId]);

      // Vec tables (virtual; not driven by memories triggers).
      counts.embedding = guardedRun(`DELETE FROM memories_vec WHERE id = ?`, [memoryId]);
      guardedRun(`DELETE FROM memories_vec_bit WHERE id = ?`, [memoryId]);

      // Parent. The FTS table's AFTER DELETE trigger purges memories_fts;
      // we infer fts=1 from a successful memory delete (the trigger fires
      // synchronously in the same transaction).
      const memRes = db.prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`).run(memoryId, userId);
      counts.memory = Number(memRes.changes ?? 0);
      counts.fts = counts.memory; // trigger purges 1 fts row per deleted memory
    });

    try {
      txn();
    } catch (err) {
      throw new DatabaseError(`Failed to hard-delete memory: ${err instanceof Error ? err.message : String(err)}`);
    }

    return counts;
  }

  // --- Wedge 1.5 Phase 4: AMB S3 right-to-amendment ---

  async amend(
    memoryId: string,
    userId: string,
    newClaim: string,
    reason: string,
    newEmbedding?: number[],
  ): Promise<AmendResult> {
    const db = this.getDb();

    const existingRow = db
      .prepare(`SELECT id, user_id, claim, version_number FROM memories WHERE id = ? AND deleted_at IS NULL`)
      .get(memoryId) as { id: string; user_id: string; claim: string; version_number: number } | undefined;

    if (!existingRow || existingRow.user_id !== userId) {
      throw new MemoryNotFoundError(memoryId);
    }

    const fromVersion = existingRow.version_number ?? 1;
    const toVersion = fromVersion + 1;
    const oldClaim = existingRow.claim;
    const now = new Date().toISOString();

    // S2: per-user chain head.
    const previousHash = await this.getLatestAuditHash(userId);
    const auditId = uuid();
    const auditDetails = JSON.stringify({ reason, fromVersion, toVersion });
    const auditTimestamp = now;
    const auditHash = this.computeAuditHash(
      { memoryId, action: 'correction', details: auditDetails, timestamp: auditTimestamp },
      previousHash,
    );

    const txn = db.transaction(() => {
      // Snapshot the OLD claim as a historical version row.
      db.prepare(`INSERT INTO memory_versions (id, memory_id, claim, changed_at, reason) VALUES (?, ?, ?, ?, ?)`).run(
        uuid(),
        memoryId,
        oldClaim,
        now,
        reason,
      );

      // Flip the live claim + bump version + correction_count.
      db.prepare(
        `UPDATE memories
         SET claim = ?, version_number = ?, correction_count = correction_count + 1, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(newClaim, toVersion, now, memoryId, userId);

      // Rotate embedding if caller supplied a fresh one.
      if (newEmbedding) {
        db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(memoryId);
        db.prepare(`DELETE FROM memories_vec_bit WHERE id = ?`).run(memoryId);
        db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(
          memoryId,
          new Float32Array(newEmbedding),
        );
        db.prepare(`INSERT INTO memories_vec_bit (id, embedding) VALUES (?, vec_quantize_binary(vec_f32(?)))`).run(
          memoryId,
          new Float32Array(newEmbedding),
        );
      }

      // Append audit entry (action = CORRECTION) inline so it shares the tx.
      const stmts = this.getStmts();
      stmts.insertAuditEntry.run({
        id: auditId,
        userId,
        memoryId,
        action: 'correction',
        details: auditDetails,
        previousHash,
        hash: auditHash,
        timestamp: auditTimestamp,
      });
    });

    try {
      txn();
    } catch (err) {
      throw new DatabaseError(`Failed to amend memory: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { memoryId, fromVersion, toVersion, reason };
  }

  // --- Read: candidate generation ---

  async searchFTS(
    query: string,
    limit: number,
    userId: string = 'system',
    nowIso?: string,
  ): Promise<ScoredCandidate[]> {
    return span(
      'lexical.search',
      async () => {
        const stmts = this.getStmts();

        try {
          const rows = nowIso
            ? (stmts.searchFTSBiTemporal.all({ query, limit, userId, nowIso }) as Record<string, unknown>[])
            : (stmts.searchFTS.all({ query, limit, userId }) as Record<string, unknown>[]);
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
      },
      { topk: limit },
    );
  }

  async searchVector(
    embedding: number[],
    limit: number,
    userId: string = 'system',
    nowIso?: string,
  ): Promise<ScoredCandidate[]> {
    return span(
      'vector.search',
      async () => {
        const db = this.getDb();

        try {
          // sqlite-vec virtual tables don't accept user_id in the MATCH clause,
          // so we overfetch and filter in the join. For a busy multi-tenant
          // index, this can degrade recall for small tenants; acceptable for
          // Packet 0 (one heavy 'system' tenant + occasional API tenants).
          const overfetch = Math.max(limit * this.config.candidateOverfetchMultiplier, limit);
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
            .all(new Float32Array(embedding), overfetch) as { id: string; distance: number }[];

          // Packet A: bi-temporal filter (Graphiti pattern). Drop superseded ids
          // before hydration, invalid_at column is on memories table, not exposed
          // on MemoryRecord, so we filter at SQL layer using the candidate ids.
          // S67: routed through stmts.filterValidIds (json_each) so it's one
          // cacheable prepared statement instead of a per-call dynamic IN-clause
          // build that varied placeholder count with overfetch.
          // R29 WD-2: always drop rejected/quarantined rows (trust filter);
          // additionally drop bi-temporally-invalid rows when a `now` is given.
          // Previously this only filtered when nowIso was set, leaking rejected
          // rows into the vector candidate set (F-D2-1).
          let validIds: Set<string> | null = null;
          if (rows.length > 0) {
            const stmts = this.getStmts();
            const ids = JSON.stringify(rows.map((r) => r.id));
            const validRows = (
              nowIso ? stmts.filterValidIds.all({ ids, userId, nowIso }) : stmts.filterTrustedIds.all({ ids, userId })
            ) as { id: string }[];
            validIds = new Set(validRows.map((r) => r.id));
          }

          // S67 perf: was N+1, getById per vec hit. Now: take the top-`limit`
          // ids that survive the bi-temporal filter, hydrate via single getByIds
          // batch (one IN-clause query). Distance is preserved by id-keyed lookup
          // so we don't lose the per-row vector score.
          const survivors: Array<{ id: string; distance: number }> = [];
          for (const row of rows) {
            if (survivors.length >= limit) break;
            if (validIds && !validIds.has(row.id)) continue;
            survivors.push(row);
          }
          if (survivors.length === 0) return [];

          const records = await this.getByIds(
            survivors.map((s) => s.id),
            userId,
          );
          // getByIds may return fewer rows than asked (deleted, wrong user, etc).
          // Index by id so we keep the original vec ordering and pair with distances.
          const byId = new Map<string, MemoryRecord>();
          for (const r of records) byId.set(r.id, r);

          const candidates: ScoredCandidate[] = [];
          for (const s of survivors) {
            const record = byId.get(s.id);
            if (!record) continue;
            candidates.push({
              id: s.id,
              record,
              lexicalScore: 0,
              vectorScore: 1 - s.distance, // Convert distance to similarity
              source: 'vector' as const,
              hubExpansionScore: 0,
              inhibitionPenalty: 0,
              primingBonus: 0,
              cascadeDepth: 0,
            });
          }
          return candidates;
        } catch (err) {
          throw new DatabaseError(`Vector search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      { topk: limit },
    );
  }

  /**
   * A3: binary-quantized vector search.
   *
   * Mirrors `searchVector` in structure (overfetch + bi-temporal filter via
   * stmts.filterValidIds + batched getByIds hydration) so the surface and
   * latency profile match. Differences:
   *   - Queries `memories_vec_bit` and converts the query embedding via
   *     `vec_quantize_binary(vec_f32(?))` on the fly.
   *   - Hamming distance ∈ [0, dim]. Convert to similarity by
   *     `1 - (distance / dim)` so downstream scoring is uniform with the
   *     float path's `1 - L2distance`.
   *
   * Flag-gated entry point lives at src/retrieval/vector.ts. Defaults to
   * off so LOCOMO/LME runs are unaffected until benched.
   */
  async searchVectorBinary(
    embedding: number[],
    limit: number,
    userId: string = 'system',
    nowIso?: string,
  ): Promise<ScoredCandidate[]> {
    return span(
      'vector.search.binary',
      async () => {
        const db = this.getDb();
        try {
          // Same overfetch policy as searchVector, binary hit rate at top-K
          // is slightly lower than float (Hamming ≠ L2 ordering), so we want
          // headroom for the bi-temporal filter to drop superseded rows
          // without starving the final pool.
          const overfetch = Math.max(limit * this.config.candidateOverfetchMultiplier, limit);
          const rows = db
            .prepare(
              `
        SELECT id, distance
        FROM memories_vec_bit
        WHERE embedding MATCH vec_quantize_binary(vec_f32(?))
        ORDER BY distance
        LIMIT ?
      `,
            )
            .all(new Float32Array(embedding), overfetch) as { id: string; distance: number }[];

          if (rows.length === 0) return [];

          // R29 WD-2: trust filter always, bi-temporal filter when nowIso set
          // (same statements as searchVector).
          let validIds: Set<string> | null = null;
          if (rows.length > 0) {
            const stmts = this.getStmts();
            const ids = JSON.stringify(rows.map((r) => r.id));
            const validRows = (
              nowIso ? stmts.filterValidIds.all({ ids, userId, nowIso }) : stmts.filterTrustedIds.all({ ids, userId })
            ) as { id: string }[];
            validIds = new Set(validRows.map((r) => r.id));
          }

          const survivors: Array<{ id: string; distance: number }> = [];
          for (const row of rows) {
            if (survivors.length >= limit) break;
            if (validIds && !validIds.has(row.id)) continue;
            survivors.push(row);
          }
          if (survivors.length === 0) return [];

          const records = await this.getByIds(
            survivors.map((s) => s.id),
            userId,
          );
          const byId = new Map<string, MemoryRecord>();
          for (const r of records) byId.set(r.id, r);

          // Hamming distance is [0, dim]; normalize to similarity [0, 1].
          // Using the embedding dimension here (not the bit-table dim) is
          // correct because vec_quantize_binary preserves dimensionality:
          // 384 floats → 384 bits.
          const dim = embedding.length || 1;
          const candidates: ScoredCandidate[] = [];
          for (const s of survivors) {
            const record = byId.get(s.id);
            if (!record) continue;
            const similarity = Math.max(0, Math.min(1, 1 - s.distance / dim));
            candidates.push({
              id: s.id,
              record,
              lexicalScore: 0,
              vectorScore: similarity,
              source: 'vector' as const,
              hubExpansionScore: 0,
              inhibitionPenalty: 0,
              primingBonus: 0,
              cascadeDepth: 0,
            });
          }
          return candidates;
        } catch (err) {
          throw new DatabaseError(`Binary vector search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      { topk: limit },
    );
  }

  async getById(id: string, userId: string = 'system'): Promise<MemoryRecord | null> {
    const stmts = this.getStmts();
    const row = stmts.getById.get({ id, userId }) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getByIds(ids: string[], userId: string = 'system'): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    if (ids.length === 0) return [];
    const rows = stmts.getByIds.all({ ids: JSON.stringify(ids), userId }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * S74 sanity-probe helper. ANY one row owned by `userId`, or null
   * when empty. Ordered by `rowid ASC` for deterministic results on a
   * given seeded corpus. Filters out soft-deleted + rejected rows so
   * the probe doesn't latch onto a row the bench would never retrieve.
   */
  async getOneByUser(userId: string): Promise<MemoryRecord | null> {
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ?
           AND deleted_at IS NULL
           AND trust_class != 'rejected'
         ORDER BY rowid ASC
         LIMIT 1`,
      )
      .get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getConflicts(id: string, userId: string = 'system'): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const record = await this.getById(id, userId);
    if (!record || record.conflictsWith.length === 0) return [];

    const rows = stmts.getConflicts.all({
      conflictIds: JSON.stringify(record.conflictsWith),
      userId,
    }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // --- Read: dedup ---

  async findBySourceHash(hash: string, userId: string = 'system'): Promise<MemoryRecord | null> {
    const stmts = this.getStmts();
    const row = stmts.findBySourceHash.get({ sourceHash: hash, userId }) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  // R29-WD-3: ids of previously-superseded rows carrying the same value as a
  // new write (most-recently-superseded first). Used to audit a re-assertion
  // (REASSERTED_PRIOR_VALUE) of a value that was once current then replaced.
  async findSupersededBySourceHash(hash: string, userId: string = 'system'): Promise<string[]> {
    const stmts = this.getStmts();
    const rows = stmts.findSupersededBySourceHash.all({ sourceHash: hash, userId }) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async findByExternalRef(userId: string, externalRef: string): Promise<MemoryRecord | null> {
    const stmts = this.getStmts();
    const row = stmts.findByExternalRef.get({ userId, externalRef }) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async findSimilar(embedding: number[], threshold: number, userId: string = 'system'): Promise<ScoredCandidate[]> {
    const candidates = await this.searchVector(embedding, 10, userId);
    return candidates.filter((c) => c.vectorScore >= threshold);
  }

  // --- Review queue ---

  async getPendingReview(limit: number, userId: string = 'system'): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getPendingReview.all({ limit, userId }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getSpotCheckBatch(limit: number, userId: string = 'system'): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const rows = stmts.getSpotCheckBatch.all({ limit, userId }) as Record<string, unknown>[];
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

  async getPromotionCandidates(
    minAccessCount: number,
    minAgeDays: number,
    limit: number,
    userId: string = 'system',
  ): Promise<MemoryRecord[]> {
    const stmts = this.getStmts();
    const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = stmts.getPromotionCandidates.all({
      minAccessCount,
      cutoffDate,
      limit,
      userId,
    }) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // --- Metadata updates (fast path, no LLM) ---

  async incrementAccessCount(id: string, userId: string = 'system'): Promise<void> {
    const stmts = this.getStmts();
    stmts.incrementAccessCount.run({ id, userId, now: new Date().toISOString() });
  }

  async incrementAccessCountBatch(ids: string[], userId: string = 'system'): Promise<void> {
    if (ids.length === 0) return;
    const stmts = this.getStmts();
    stmts.incrementAccessCountBatch.run({
      ids: JSON.stringify(ids),
      userId,
      now: new Date().toISOString(),
    });
  }

  async updateLastAccessed(id: string, userId: string = 'system'): Promise<void> {
    const stmts = this.getStmts();
    stmts.updateLastAccessed.run({ id, userId, now: new Date().toISOString() });
  }

  // --- Audit log ---

  async appendAuditLog(entry: NewAuditEntry, userId: string = 'system'): Promise<AuditEntry> {
    // S2: chain head is per-user. R29 WB-2: the head read and write run
    // under a compare-and-set inside an IMMEDIATE transaction so concurrent
    // writers cannot fork a user's chain.
    return this.appendAuditWithChainHead(userId, entry);
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

  async getLatestAuditHash(userId: string = 'system'): Promise<string | null> {
    const stmts = this.getStmts();
    const row = stmts.getLatestAuditHash.get({ userId }) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /**
   * Wedge 1.5 Phase 4: full ordered chain for the verify-audit-chain cron.
   *
   * Ordering by SQLite rowid (implicit autoincrement column since 'id' is
   * TEXT and not INTEGER PRIMARY KEY). rowid is monotonically increasing
   * within a connection, so insertion order is preserved even when multiple
   * appendAuditLog calls land in the same millisecond.
   *
   * Previous ordering (timestamp ASC, id ASC) was timestamp-flaky: ISO
   * timestamps have only ms precision, ties resolved by UUID lex order,
   * which scrambled hash-chain order and broke verifyChain on fast hardware.
   * S73 fix.
   */
  async getAllAuditEntries(): Promise<AuditEntry[]> {
    const db = this.getDb();
    // S2: include user_id so the cron verifier can group per-user chains.
    // The order is rowid ASC globally; per-user order is preserved inside
    // each group because rowid is monotonic per connection.
    const rows = db
      .prepare(
        `SELECT id, user_id, memory_id, action, details, previous_hash, hash, timestamp
         FROM audit_log
         ORDER BY rowid ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      userId: (row.user_id as string) ?? null,
      memoryId: (row.memory_id as string) || null,
      action: row.action as AuditEntry['action'],
      details: (row.details as string) || null,
      previousHash: (row.previous_hash as string) || null,
      hash: row.hash as string,
      timestamp: row.timestamp as string,
    }));
  }

  /**
   * R29-N7: the set of audit heads that were intentionally deleted (user
   * deletes, pre-epoch legacy wipe). The epoch-aware verifier uses this to
   * tolerate dangling references created by those deletions while still
   * flagging tampering that removes rows without a manifest entry.
   */
  async getAuditTombstoneHashes(): Promise<Set<string>> {
    const stmts = this.getStmts();
    const rows = stmts.getTombstoneHashes.all() as { hash: string | null }[];
    const set = new Set<string>();
    for (const r of rows) if (r.hash) set.add(r.hash);
    return set;
  }

  /**
   * R29-N7: record a deletion tombstone. Used by the one-time pre-epoch
   * legacy-wipe operator path (ruling 2) so the epoch marker's dangling
   * previousHash reads as an intentional deletion rather than a break.
   */
  async recordAuditTombstone(
    userId: string,
    deletedThroughHash: string | null,
    reason: string,
    operator?: string | null,
  ): Promise<void> {
    const stmts = this.getStmts();
    stmts.insertTombstone.run({
      id: uuid(),
      userId,
      deletedThroughHash,
      reason,
      operator: operator ?? process.env.DEMIURGE_OPERATOR ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  // --- Export / stats ---

  async *exportAll(userId: string = 'system'): AsyncIterable<MemoryRecord> {
    const stmts = this.getStmts();
    const pageSize = 100;
    let cursor = '';

    while (true) {
      const rows = stmts.exportPage.all({ cursor, pageSize, userId }) as Record<string, unknown>[];
      if (rows.length === 0) break;

      for (const row of rows) {
        yield this.rowToRecord(row);
      }

      const lastRow = rows[rows.length - 1];
      if (!lastRow) break;
      cursor = lastRow.created_at as string;
    }
  }

  async getStats(userId: string = 'system'): Promise<RepositoryStats> {
    const stmts = this.getStmts();

    const totalRow = stmts.countAll.get({ userId }) as { count: number };
    const trustRows = stmts.countByTrustClass.all({ userId }) as { trust_class: string; count: number }[];
    const provRows = stmts.countByProvenance.all({ userId }) as { provenance: string; count: number }[];
    const scopeRows = stmts.countByScope.all({ userId }) as { scope: string; count: number }[];
    const pendingRow = stmts.countPendingReview.get({ userId }) as { count: number };
    const avgRow = stmts.avgConfidence.get({ userId }) as { avg: number | null };
    const oldestRow = stmts.oldestMemory.get({ userId }) as { created_at: string } | undefined;
    const newestRow = stmts.newestMemory.get({ userId }) as { created_at: string } | undefined;

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

  async getLastActivityTimestamp(userId: string = 'system'): Promise<string | null> {
    const stmts = this.getStmts();
    const row = stmts.lastActivity.get({ userId }) as { last: string | null } | undefined;
    return row?.last ?? null;
  }

  // --- Bulk (for circuit breaker) ---

  async countAll(userId: string = 'system'): Promise<number> {
    const stmts = this.getStmts();
    const row = stmts.countAll.get({ userId }) as { count: number };
    return row.count;
  }

  // --- Account deletion (Packet 0) ---

  async deleteUserCascade(userId: string): Promise<{
    memories: number;
    audit: number;
    episodes: number;
    statePacks: number;
    summaries: number;
  }> {
    const db = this.getDb();
    const stmts = this.getStmts();

    // Children first, parents last. Vec table is virtual so we delete it
    // explicitly (FTS triggers handle memories_fts on the memories DELETE).
    // state_pack_slots and episode_facts are children of state_packs and
    // episodes respectively; delete them via subquery before the parent.
    const txn = db.transaction(() => {
      // Defer FK checks to commit so child-before-parent order and the
      // self-referential claims.supersedes_claim_id link cannot fail mid-cascade.
      db.pragma('defer_foreign_keys = ON');
      // Children of memories
      const memIdsRows = db.prepare(`SELECT id FROM memories WHERE user_id = ?`).all(userId) as { id: string }[];
      const memIds = memIdsRows.map((r) => r.id);

      if (memIds.length > 0) {
        const placeholders = memIds.map(() => '?').join(',');
        // Tables that may not exist in every install, guard with try/catch.
        for (const sql of [
          `DELETE FROM memory_tags WHERE memory_id IN (${placeholders})`,
          `DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`,
          `DELETE FROM hub_links WHERE memory_id IN (${placeholders})`,
          `DELETE FROM structural_tags WHERE memory_id IN (${placeholders})`,
          `DELETE FROM spot_checks WHERE memory_id IN (${placeholders})`,
          `DELETE FROM memory_edges WHERE src_id IN (${placeholders}) OR dst_id IN (${placeholders})`,
          `DELETE FROM inhibition_edges WHERE src_id IN (${placeholders}) OR dst_id IN (${placeholders})`,
          `DELETE FROM procedures WHERE memory_id IN (${placeholders})`,
          `DELETE FROM hub_stats WHERE hub_id IN (${placeholders})`,
          `DELETE FROM priming_cache WHERE memory_id IN (${placeholders})`,
          `DELETE FROM entity_index WHERE memory_id IN (${placeholders})`,
          `DELETE FROM assertion_triples WHERE assertion_id IN (${placeholders})`,
          `DELETE FROM claim_links WHERE src_claim_id IN (SELECT id FROM claims WHERE source_memory_id IN (${placeholders})) OR dst_claim_id IN (SELECT id FROM claims WHERE source_memory_id IN (${placeholders}))`,
          `DELETE FROM current_fact_cache WHERE claim_id IN (SELECT id FROM claims WHERE source_memory_id IN (${placeholders}))`,
          `DELETE FROM claims WHERE source_memory_id IN (${placeholders})`,
        ]) {
          try {
            // Some statements bind the memIds twice (memory_edges, inhibition_edges).
            const bindCount = (sql.match(/\(\?(?:,\?)*\)/g) || []).length;
            const params = bindCount === 2 ? [...memIds, ...memIds] : memIds;
            db.prepare(sql).run(...params);
          } catch (err) {
            // Table may not exist in older schemas. Soft-fail.
            if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
          }
        }
      }

      // Children of episodes
      try {
        db.prepare(`DELETE FROM episode_facts WHERE episode_id IN (SELECT id FROM episodes WHERE user_id = ?)`).run(
          userId,
        );
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
      }

      // Children of state_packs
      try {
        db.prepare(`DELETE FROM state_pack_slots WHERE pack_id IN (SELECT id FROM state_packs WHERE user_id = ?)`).run(
          userId,
        );
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
      }

      // Vec tables (virtual; don't fire memories_fts triggers). Clear all five
      // mirrors keyed off the parent rows BEFORE the parents are deleted below,
      // so a user delete leaves no orphaned embeddings (R29-WB / F-D4-3).
      for (const vecStmt of [
        stmts.deleteUserMemoriesVec,
        stmts.deleteUserMemoriesVecBit,
        stmts.deleteUserEpisodeVec,
        stmts.deleteUserEpisodeVecBit,
        stmts.deleteUserSummaryVec,
        stmts.deleteUserSummaryVecBit,
      ]) {
        try {
          vecStmt.run({ userId });
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
        }
      }

      // Top-level scoped tables
      const memRes = stmts.deleteUserMemories.run({ userId });
      const epRes = stmts.deleteUserEpisodes.run({ userId });
      const spRes = stmts.deleteUserStatePacks.run({ userId });
      const sumRes = stmts.deleteUserSummaries.run({ userId });

      // R29-N7: before removing the user's audit rows, record a deletion
      // tombstone covering the chain head we are about to delete, then drop
      // the chain_head row. This keeps the deletion auditable and lets the
      // verifier tell an intentional delete (covered by a manifest entry)
      // apart from a tamper that silently removes rows.
      const headRow = stmts.selectChainHead.get({ userId }) as { lastHash: string | null } | undefined;
      // S83: legacy (pre-epoch) users have no chain_head row because the
      // epoch migration records their heads only in the marker details, so
      // the R29-N7 tombstone write silently no-ops for them (observed on the
      // ruling-2 wipe: 142 cascades, zero tombstones). Fall back to deriving
      // the head from the user's audit rows before they are deleted below.
      let deletedThroughHash = headRow?.lastHash ?? null;
      if (deletedThroughHash === null) {
        const fallbackRow = db
          .prepare(`SELECT hash FROM audit_log WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`)
          .get(userId) as { hash: string } | undefined;
        deletedThroughHash = fallbackRow?.hash ?? null;
      }
      if (deletedThroughHash !== null) {
        stmts.insertTombstone.run({
          id: uuid(),
          userId,
          deletedThroughHash,
          reason: 'user-cascade-delete',
          operator: process.env.DEMIURGE_OPERATOR ?? null,
          createdAt: new Date().toISOString(),
        });
      }
      stmts.deleteChainHead.run({ userId });

      // Audit last so it captures history if anything fails
      const auditRes = stmts.deleteUserAuditLog.run({ userId });

      return {
        memories: Number(memRes.changes ?? 0),
        episodes: Number(epRes.changes ?? 0),
        statePacks: Number(spRes.changes ?? 0),
        summaries: Number(sumRes.changes ?? 0),
        audit: Number(auditRes.changes ?? 0),
      };
    });

    return txn();
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

  // S67: batched hub fetch. Single round-trip for many ids.
  async getHubsByIds(hubIds: string[]): Promise<MemoryHub[]> {
    if (hubIds.length === 0) return [];
    const stmts = this.getStmts();
    const rows = stmts.getHubsByIds.all({ ids: JSON.stringify(hubIds) }) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      claim: row.claim as string,
      hubType: row.hub_type as string,
      createdAt: row.created_at as string,
      accessCount: row.access_count as number,
    }));
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

  // S67: batched hub_links fetch. Single round-trip across N memory ids.
  async getHubLinksForMany(memoryIds: string[]): Promise<HubLink[]> {
    if (memoryIds.length === 0) return [];
    const stmts = this.getStmts();
    const rows = stmts.getHubLinksForMany.all({ memoryIds: JSON.stringify(memoryIds) }) as Record<string, unknown>[];
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

  async getBySubject(subject: string, limit: number, userId?: string): Promise<MemoryRecord[]> {
    // R29 WD-2: exclude rejected/quarantined rows. Both callers are read
    // surfaces (steering fetchInteractionPrefs, episode-context siblings); a
    // rejected row is kept for audit but must never steer or contextualize
    // (F-D3-1). No write/supersession path reads through this accessor.
    const TRUST = "AND trust_class != 'rejected' AND review_status NOT IN ('rejected', 'quarantined')";
    const rows = (
      userId
        ? this.db!.prepare(
            `SELECT * FROM memories WHERE subject = ? AND user_id = ? AND deleted_at IS NULL ${TRUST} ORDER BY created_at DESC LIMIT ?`,
          ).all(subject, userId, limit)
        : this.db!.prepare(
            `SELECT * FROM memories WHERE subject = ? AND deleted_at IS NULL ${TRUST} ORDER BY created_at DESC LIMIT ?`,
          ).all(subject, limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getRecentCorrections(limit: number, userId?: string): Promise<MemoryRecord[]> {
    // A "correction" is a current fact (invalid_at NULL) whose subject also has
    // an earlier value that was superseded (invalid_at set by the bi-temporal
    // write path). The supersedes column is not populated on the new record by
    // the write pipeline, so we detect the relationship via the existence of an
    // invalidated sibling on the same subject rather than reading supersedes.
    const rows = (
      userId
        ? this.db!.prepare(
            `SELECT m.* FROM memories m
             WHERE m.invalid_at IS NULL AND m.deleted_at IS NULL AND m.user_id = ?
               AND EXISTS (
                 SELECT 1 FROM memories o
                 WHERE o.subject = m.subject AND o.user_id = m.user_id AND o.invalid_at IS NOT NULL AND o.deleted_at IS NULL
               )
             ORDER BY m.created_at DESC LIMIT ?`,
          ).all(userId, limit)
        : this.db!.prepare(
            `SELECT m.* FROM memories m
             WHERE m.invalid_at IS NULL AND m.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM memories o
                 WHERE o.subject = m.subject AND o.invalid_at IS NOT NULL AND o.deleted_at IS NULL
               )
             ORDER BY m.created_at DESC LIMIT ?`,
          ).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getRecentEpisode(userId?: string): Promise<{ subject: string; title: string; summary: string } | null> {
    const row = (
      userId
        ? this.db!.prepare(
            'SELECT subject, title, summary FROM episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
          ).get(userId)
        : this.db!.prepare('SELECT subject, title, summary FROM episodes ORDER BY created_at DESC LIMIT 1').get()
    ) as { subject?: string; title?: string; summary?: string } | undefined;
    if (!row) return null;
    return {
      subject: row.subject ?? '',
      title: row.title ?? '',
      summary: row.summary ?? '',
    };
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

  async runPostSeedHooks(_apiKey?: string): Promise<{ episodes: number; summaries: number; bridges: number }> {
    // S79 fix #2: episodes are built on the prod ingest path
    // (dispatch.ingest -> buildEpisodesForSubjects). runPostSeedHooks must NOT
    // also build them here, or it double-builds (duplicate episodes) on top of
    // the ingest-built ones. Left as a no-op (episodes stays 0). If a full
    // backfill entry point is still wanted, expose buildAllEpisodes as a
    // separate rebuildAllEpisodes() method rather than running it here.

    // R11 KILLED: summaries (-1.0) and bridge retrieval (-0.3)
    return { episodes: 0, summaries: 0, bridges: 0 };
  }

  async buildEpisodesForSubjects(subjects: string[], apiKey?: string, userId: string = 'system'): Promise<number> {
    if (!onByDefault(process.env.EPISODES_ENABLED)) return 0;
    if (subjects.length === 0) return 0;
    const db = this.getDb();

    // Idempotency: drop each subject's existing episodes (and their vec and
    // fact rows) before rebuild. buildEpisodes only inserts, so without this
    // every ingest touching a subject would accumulate duplicate episodes.
    // episodes.subject is the facet primary_subject buildEpisodes writes, which
    // equals memories.subject verbatim (src/write/facets.ts), so deleting by the
    // subject getBySubject filters on matches the rows buildEpisodes will write.
    const factIds: string[] = [];
    for (const subject of subjects) {
      const existing = db.prepare('SELECT id FROM episodes WHERE subject = ? AND user_id = ?').all(subject, userId) as {
        id: string;
      }[];
      for (const { id } of existing) {
        db.prepare('DELETE FROM episode_vec WHERE id = ?').run(id);
        db.prepare('DELETE FROM episode_facts WHERE episode_id = ?').run(id);
        db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
      }
      const rows = await this.getBySubject(subject, 10000, userId);
      for (const r of rows) factIds.push(r.id);
    }

    const eps = await buildEpisodes(db, factIds, apiKey, userId);
    return eps.length;
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

  // --- Wedge 2 (S74): assertion_triples ---

  async insertTriples(assertionId: string, rows: AssertionTriple[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.getDb();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO assertion_triples
        (assertion_id, subject, predicate, object, object_literal,
         valid_from, valid_to, confidence, conflict_set_id, created_at)
      VALUES
        (@assertion_id, @subject, @predicate, @object, @object_literal,
         @valid_from, @valid_to, @confidence, @conflict_set_id, @created_at)
    `);
    const txn = db.transaction((batch: AssertionTriple[]) => {
      for (const t of batch) {
        if (t.assertion_id !== assertionId) {
          throw new DatabaseError(
            `insertTriples: row.assertion_id (${t.assertion_id}) does not match assertionId (${assertionId})`,
          );
        }
        stmt.run({
          assertion_id: t.assertion_id,
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          object_literal: t.object_literal,
          valid_from: t.valid_from,
          valid_to: t.valid_to,
          confidence: t.confidence,
          conflict_set_id: t.conflict_set_id,
          created_at: now,
        });
      }
    });
    try {
      txn(rows);
    } catch (err) {
      throw new DatabaseError(`Failed to insert triples: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async searchTriplesBySubject(
    subject: string,
    predicate: string | null,
    limit: number = 256,
  ): Promise<AssertionTriple[]> {
    const db = this.getDb();
    const norm = subject.trim().toLowerCase();
    const rows =
      predicate === null
        ? (db
            .prepare(`SELECT * FROM assertion_triples WHERE subject = ? ORDER BY created_at DESC LIMIT ?`)
            .all(norm, limit) as TripleRow[])
        : (db
            .prepare(
              `SELECT * FROM assertion_triples WHERE subject = ? AND predicate = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(norm, predicate, limit) as TripleRow[]);
    return rows.map(rowToTriple);
  }

  async searchTriplesByObject(
    object: string,
    predicate: string | null,
    limit: number = 256,
  ): Promise<AssertionTriple[]> {
    const db = this.getDb();
    const norm = object.trim().toLowerCase();
    const rows =
      predicate === null
        ? (db
            .prepare(`SELECT * FROM assertion_triples WHERE object = ? ORDER BY created_at DESC LIMIT ?`)
            .all(norm, limit) as TripleRow[])
        : (db
            .prepare(
              `SELECT * FROM assertion_triples WHERE object = ? AND predicate = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(norm, predicate, limit) as TripleRow[]);
    return rows.map(rowToTriple);
  }

  async searchTriplesByPredicate(predicate: string, limit: number = 256): Promise<AssertionTriple[]> {
    const db = this.getDb();
    const rows = db
      .prepare(`SELECT * FROM assertion_triples WHERE predicate = ? ORDER BY created_at DESC LIMIT ?`)
      .all(predicate, limit) as TripleRow[];
    return rows.map(rowToTriple);
  }

  async searchTriplesByConflictSet(conflictSetId: string): Promise<AssertionTriple[]> {
    const db = this.getDb();
    const rows = db
      .prepare(`SELECT * FROM assertion_triples WHERE conflict_set_id = ? ORDER BY created_at ASC`)
      .all(conflictSetId) as TripleRow[];
    return rows.map(rowToTriple);
  }

  async hasTriplesForAssertion(assertionId: string): Promise<boolean> {
    const db = this.getDb();
    const row = db.prepare(`SELECT 1 AS hit FROM assertion_triples WHERE assertion_id = ? LIMIT 1`).get(assertionId) as
      | { hit: number }
      | undefined;
    return row !== undefined;
  }
}

// ----------------------------------------------------------------------------
// Row → AssertionTriple mapping
// ----------------------------------------------------------------------------

interface TripleRow {
  assertion_id: string;
  subject: string;
  predicate: string | null;
  object: string | null;
  object_literal: string | null;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number | null;
  conflict_set_id: string | null;
  created_at: string;
}

function rowToTriple(r: TripleRow): AssertionTriple {
  return {
    assertion_id: r.assertion_id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    object_literal: r.object_literal,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    confidence: r.confidence,
    conflict_set_id: r.conflict_set_id,
  };
}
