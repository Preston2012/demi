import type Database from 'better-sqlite3';

/**
 * Minimal statement wrapper — just the methods we use.
 * Avoids exposing BetterSqlite3.Statement in public type surface.
 */
export interface PreparedStatement {
  run(...params: unknown[]): Database.RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface PreparedStatements {
  insertMemory: PreparedStatement;
  softDeleteMemory: PreparedStatement;
  getPromotionCandidates: PreparedStatement;
  getById: PreparedStatement;
  getByIds: PreparedStatement;
  findBySourceHash: PreparedStatement;
  getConflicts: PreparedStatement;
  searchFTS: PreparedStatement;
  getPendingReview: PreparedStatement;
  getSpotCheckBatch: PreparedStatement;
  flagForSpotCheck: PreparedStatement;
  incrementAccessCount: PreparedStatement;
  updateLastAccessed: PreparedStatement;
  insertAuditEntry: PreparedStatement;
  getAuditByMemoryId: PreparedStatement;
  getLatestAuditHash: PreparedStatement;
  countAll: PreparedStatement;
  countByTrustClass: PreparedStatement;
  countByProvenance: PreparedStatement;
  countByScope: PreparedStatement;
  countPendingReview: PreparedStatement;
  avgConfidence: PreparedStatement;
  oldestMemory: PreparedStatement;
  newestMemory: PreparedStatement;
  lastActivity: PreparedStatement;
  exportPage: PreparedStatement;
  setMetadata: PreparedStatement;
  getMetadata: PreparedStatement;
  // Tags
  getMemoryTags: PreparedStatement;
  deleteMemoryTags: PreparedStatement;
  insertMemoryTag: PreparedStatement;
  searchByTag: PreparedStatement;
  getAllTags: PreparedStatement;
  // Hubs
  getHubs: PreparedStatement;
  getHubById: PreparedStatement;
  insertHub: PreparedStatement;
  insertHubLink: PreparedStatement;
  deleteHubLink: PreparedStatement;
  getHubLinks: PreparedStatement;
  getHubMembers: PreparedStatement;
  incrementHubAccess: PreparedStatement;
  // Versions
  insertVersion: PreparedStatement;
  getVersionHistory: PreparedStatement;
  // Inhibitory
  getInhibitoryMemories: PreparedStatement;
  getInhibitoryBySubject: PreparedStatement;
  // Interference
  getColdStorage: PreparedStatement;
  setInterferenceStatus: PreparedStatement;
  // Constraints
  getConstraints: PreparedStatement;
  getActiveConstraints: PreparedStatement;
  insertConstraint: PreparedStatement;
  deactivateConstraint: PreparedStatement;
  // Causal
  getCausedBy: PreparedStatement;
  getLeadsTo: PreparedStatement;
  // Self-play
  insertSelfPlayRun: PreparedStatement;
  updateSelfPlayRun: PreparedStatement;
  insertSelfPlayResult: PreparedStatement;
  getSelfPlayResults: PreparedStatement;
  getLatestSelfPlayRun: PreparedStatement;
  // Freeze
  getFrozenMemories: PreparedStatement;
  freezeMemory: PreparedStatement;
  unfreezeMemory: PreparedStatement;
  // Correction
  incrementCorrectionCount: PreparedStatement;
  // Meta-memory
  topSubjects: PreparedStatement;
  stalestMemories: PreparedStatement;
  mostAccessedMemories: PreparedStatement;
  countInhibitory: PreparedStatement;
  countFrozen: PreparedStatement;
  countColdStorage: PreparedStatement;
  countHubs: PreparedStatement;
}

/**
 * Prepared statement factories. Each returns a prepared statement
 * bound to the database instance. Cached per-connection.
 *
 * All queries exclude soft-deleted records (deleted_at IS NULL)
 * unless explicitly noted.
 */
export function prepareStatements(db: Database.Database): PreparedStatements {
  return {
    // --- Write ---

    insertMemory: db.prepare(`
      INSERT INTO memories (
        id, claim, subject, scope, valid_from, valid_to,
        provenance, trust_class, confidence, source_hash,
        supersedes, conflicts_with, review_status,
        access_count, last_accessed, created_at, updated_at,
        permanence_status,
        hub_id, hub_score, resolution, memory_type,
        version_number, parent_version_id,
        frozen_at, decay_score, storage_tier,
        is_inhibitory, inhibition_target, interference_status,
        correction_count, is_frozen, caused_by, leads_to,
        canonical_fact_id, is_canonical
      ) VALUES (
        @id, @claim, @subject, @scope, @validFrom, @validTo,
        @provenance, @trustClass, @confidence, @sourceHash,
        @supersedes, @conflictsWith, @reviewStatus,
        @accessCount, @lastAccessed, @createdAt, @updatedAt,
        @permanenceStatus,
        @hubId, @hubScore, @resolution, @memoryType,
        @versionNumber, @parentVersionId,
        @frozenAt, @decayScore, @storageTier,
        @isInhibitory, @inhibitionTarget, @interferenceStatus,
        @correctionCount, @isFrozen, @causedBy, @leadsTo,
        @canonicalFactId, @isCanonical
      )
    `),

    softDeleteMemory: db.prepare(`
      UPDATE memories
      SET deleted_at = @deletedAt, delete_reason = @deleteReason, updated_at = @updatedAt
      WHERE id = @id AND deleted_at IS NULL
    `),

    // --- Read ---

    getById: db.prepare(`
      SELECT * FROM memories WHERE id = @id AND deleted_at IS NULL
    `),

    getByIds: db.prepare(`
      SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(@ids)) AND deleted_at IS NULL
    `),

    findBySourceHash: db.prepare(`
      SELECT * FROM memories WHERE source_hash = @sourceHash AND deleted_at IS NULL LIMIT 1
    `),

    getConflicts: db.prepare(`
      SELECT m.* FROM memories m, json_each(@conflictIds) j
      WHERE m.id = j.value AND m.deleted_at IS NULL
    `),

    // --- FTS5 search ---

    searchFTS: db.prepare(`
      SELECT
        m.*,
        bm25(memories_fts) AS fts_rank
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH @query
        AND m.deleted_at IS NULL
        AND m.trust_class != 'rejected'
      ORDER BY fts_rank
      LIMIT @limit
    `),

    // --- Review queue ---

    getPendingReview: db.prepare(`
      SELECT * FROM memories
      WHERE review_status = 'pending'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT @limit
    `),

    getSpotCheckBatch: db.prepare(`
      SELECT m.* FROM spot_checks sc
      JOIN memories m ON m.id = sc.memory_id
      WHERE sc.reviewed_at IS NULL
        AND m.deleted_at IS NULL
      ORDER BY sc.flagged_at ASC
      LIMIT @limit
    `),

    flagForSpotCheck: db.prepare(`
      INSERT OR IGNORE INTO spot_checks (memory_id, flagged_at)
      VALUES (@memoryId, @flaggedAt)
    `),

    getPromotionCandidates: db.prepare(`
      SELECT * FROM memories
      WHERE permanence_status = 'provisional'
        AND access_count >= @minAccessCount
        AND created_at <= @cutoffDate
        AND trust_class IN ('confirmed', 'auto-approved')
        AND deleted_at IS NULL
      ORDER BY access_count DESC
      LIMIT @limit
    `),

    // --- Metadata fast path ---

    incrementAccessCount: db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed = @now, updated_at = @now
      WHERE id = @id AND deleted_at IS NULL
    `),

    updateLastAccessed: db.prepare(`
      UPDATE memories
      SET last_accessed = @now, updated_at = @now
      WHERE id = @id AND deleted_at IS NULL
    `),

    // --- Audit log ---

    insertAuditEntry: db.prepare(`
      INSERT INTO audit_log (id, memory_id, action, details, previous_hash, hash, timestamp)
      VALUES (@id, @memoryId, @action, @details, @previousHash, @hash, @timestamp)
    `),

    getAuditByMemoryId: db.prepare(`
      SELECT * FROM audit_log
      WHERE memory_id = @memoryId
      ORDER BY timestamp ASC
    `),

    getLatestAuditHash: db.prepare(`
      SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1
    `),

    // --- Stats ---

    countAll: db.prepare(`
      SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL
    `),

    countByTrustClass: db.prepare(`
      SELECT trust_class, COUNT(*) AS count
      FROM memories WHERE deleted_at IS NULL
      GROUP BY trust_class
    `),

    countByProvenance: db.prepare(`
      SELECT provenance, COUNT(*) AS count
      FROM memories WHERE deleted_at IS NULL
      GROUP BY provenance
    `),

    countByScope: db.prepare(`
      SELECT scope, COUNT(*) AS count
      FROM memories WHERE deleted_at IS NULL
      GROUP BY scope
    `),

    countPendingReview: db.prepare(`
      SELECT COUNT(*) AS count
      FROM memories WHERE review_status = 'pending' AND deleted_at IS NULL
    `),

    avgConfidence: db.prepare(`
      SELECT AVG(confidence) AS avg
      FROM memories WHERE deleted_at IS NULL
    `),

    oldestMemory: db.prepare(`
      SELECT created_at FROM memories WHERE deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `),

    newestMemory: db.prepare(`
      SELECT created_at FROM memories WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `),

    lastActivity: db.prepare(`
      SELECT MAX(updated_at) AS last FROM memories
    `),

    // --- Export (cursor-based for AsyncIterable) ---

    exportPage: db.prepare(`
      SELECT * FROM memories
      WHERE deleted_at IS NULL AND created_at > @cursor
      ORDER BY created_at ASC
      LIMIT @pageSize
    `),

    // --- System metadata ---

    setMetadata: db.prepare(`
      INSERT OR REPLACE INTO system_metadata (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
    `),

    getMetadata: db.prepare(`
      SELECT value FROM system_metadata WHERE key = @key
    `),

    // --- Tags ---
    getMemoryTags: db.prepare(`SELECT tag FROM memory_tags WHERE memory_id = @memoryId ORDER BY tag`),
    deleteMemoryTags: db.prepare(`DELETE FROM memory_tags WHERE memory_id = @memoryId`),
    insertMemoryTag: db.prepare(`INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (@memoryId, @tag)`),
    searchByTag: db.prepare(`
      SELECT m.* FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
      WHERE mt.tag = @tag AND m.deleted_at IS NULL ORDER BY m.access_count DESC LIMIT @limit
    `),
    getAllTags: db.prepare(`
      SELECT mt.tag, COUNT(*) AS count FROM memory_tags mt
      JOIN memories m ON m.id = mt.memory_id WHERE m.deleted_at IS NULL
      GROUP BY mt.tag ORDER BY count DESC
    `),

    // --- Hubs ---
    getHubs: db.prepare(`SELECT * FROM memory_hubs ORDER BY access_count DESC LIMIT @limit`),
    getHubById: db.prepare(`SELECT * FROM memory_hubs WHERE id = @id`),
    insertHub: db.prepare(`
      INSERT INTO memory_hubs (id, claim, hub_type, created_at, access_count)
      VALUES (@id, @claim, @hubType, @createdAt, @accessCount)
    `),
    insertHubLink: db.prepare(`INSERT OR IGNORE INTO hub_links (memory_id, hub_id, linked_at) VALUES (@memoryId, @hubId, @linkedAt)`),
    deleteHubLink: db.prepare(`DELETE FROM hub_links WHERE memory_id = @memoryId AND hub_id = @hubId`),
    getHubLinks: db.prepare(`SELECT * FROM hub_links WHERE memory_id = @memoryId ORDER BY linked_at`),
    getHubMembers: db.prepare(`
      SELECT m.* FROM hub_links hl JOIN memories m ON m.id = hl.memory_id
      WHERE hl.hub_id = @hubId AND m.deleted_at IS NULL ORDER BY m.access_count DESC LIMIT @limit
    `),
    incrementHubAccess: db.prepare(`UPDATE memory_hubs SET access_count = access_count + 1 WHERE id = @id`),

    // --- Versions ---
    insertVersion: db.prepare(`
      INSERT INTO memory_versions (id, memory_id, claim, changed_at, reason)
      VALUES (@id, @memoryId, @claim, @changedAt, @reason)
    `),
    getVersionHistory: db.prepare(`SELECT * FROM memory_versions WHERE memory_id = @memoryId ORDER BY changed_at ASC`),

    // --- Inhibitory ---
    getInhibitoryMemories: db.prepare(`SELECT * FROM memories WHERE is_inhibitory = 1 AND deleted_at IS NULL ORDER BY created_at DESC`),
    getInhibitoryBySubject: db.prepare(`
      SELECT * FROM memories WHERE is_inhibitory = 1 AND inhibition_target = @subject AND deleted_at IS NULL ORDER BY confidence DESC
    `),

    // --- Interference ---
    getColdStorage: db.prepare(`SELECT * FROM memories WHERE interference_status = 'cold' AND deleted_at IS NULL ORDER BY last_accessed ASC LIMIT @limit`),
    setInterferenceStatus: db.prepare(`UPDATE memories SET interference_status = @status, updated_at = @now WHERE id = @id AND deleted_at IS NULL`),

    // --- Constraints ---
    getConstraints: db.prepare(`SELECT * FROM memory_constraints ORDER BY priority DESC`),
    getActiveConstraints: db.prepare(`SELECT * FROM memory_constraints WHERE is_active = 1 ORDER BY priority DESC`),
    insertConstraint: db.prepare(`
      INSERT INTO memory_constraints (id, claim, constraint_type, priority, is_active, created_at)
      VALUES (@id, @claim, @constraintType, @priority, @isActive, @createdAt)
    `),
    deactivateConstraint: db.prepare(`UPDATE memory_constraints SET is_active = 0 WHERE id = @id`),

    // --- Causal ---
    getCausedBy: db.prepare(`SELECT * FROM memories WHERE id = @id AND deleted_at IS NULL`),
    getLeadsTo: db.prepare(`SELECT * FROM memories WHERE id = @id AND deleted_at IS NULL`),

    // --- Self-play ---
    insertSelfPlayRun: db.prepare(`
      INSERT INTO self_play_runs (id, started_at, completed_at, queries_generated, retrievals_passed, retrievals_failed, notes)
      VALUES (@id, @startedAt, @completedAt, @queriesGenerated, @retrievalsPassed, @retrievalsFailed, @notes)
    `),
    updateSelfPlayRun: db.prepare(`
      UPDATE self_play_runs SET completed_at = @completedAt, queries_generated = @queriesGenerated,
      retrievals_passed = @retrievalsPassed, retrievals_failed = @retrievalsFailed, notes = @notes WHERE id = @id
    `),
    insertSelfPlayResult: db.prepare(`
      INSERT INTO self_play_results (id, run_id, query, expected_memory_id, actual_memory_id, passed, score_gap, details)
      VALUES (@id, @runId, @query, @expectedMemoryId, @actualMemoryId, @passed, @scoreGap, @details)
    `),
    getSelfPlayResults: db.prepare(`SELECT * FROM self_play_results WHERE run_id = @runId ORDER BY rowid ASC`),
    getLatestSelfPlayRun: db.prepare(`SELECT * FROM self_play_runs ORDER BY started_at DESC LIMIT 1`),

    // --- Freeze ---
    getFrozenMemories: db.prepare(`SELECT * FROM memories WHERE is_frozen = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT @limit`),
    freezeMemory: db.prepare(`UPDATE memories SET is_frozen = 1, updated_at = @now WHERE id = @id AND deleted_at IS NULL`),
    unfreezeMemory: db.prepare(`UPDATE memories SET is_frozen = 0, updated_at = @now WHERE id = @id AND deleted_at IS NULL`),

    // --- Correction ---
    incrementCorrectionCount: db.prepare(`UPDATE memories SET correction_count = correction_count + 1, updated_at = @now WHERE id = @id AND deleted_at IS NULL`),

    // --- Meta-memory ---
    topSubjects: db.prepare(`SELECT subject, COUNT(*) AS count FROM memories WHERE deleted_at IS NULL GROUP BY subject ORDER BY count DESC LIMIT 10`),
    stalestMemories: db.prepare(`SELECT id, claim, last_accessed FROM memories WHERE deleted_at IS NULL AND is_frozen = 0 ORDER BY last_accessed ASC LIMIT 10`),
    mostAccessedMemories: db.prepare(`SELECT id, claim, access_count FROM memories WHERE deleted_at IS NULL ORDER BY access_count DESC LIMIT 10`),
    countInhibitory: db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE is_inhibitory = 1 AND deleted_at IS NULL`),
    countFrozen: db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE is_frozen = 1 AND deleted_at IS NULL`),
    countColdStorage: db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE interference_status = 'cold' AND deleted_at IS NULL`),
    countHubs: db.prepare(`SELECT COUNT(*) AS count FROM memory_hubs`),
  };
}
