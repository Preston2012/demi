import type Database from 'better-sqlite3-multiple-ciphers';

/**
 * Minimal statement wrapper, just the methods we use.
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
  findSupersededBySourceHash: PreparedStatement;
  findByExternalRef: PreparedStatement;
  getConflicts: PreparedStatement;
  searchFTS: PreparedStatement;
  searchFTSBiTemporal: PreparedStatement;
  /** S67: bi-temporal id filter for searchVector, cacheable single prepared
   *  statement using json_each, replacing per-call dynamic IN-clause builds. */
  filterValidIds: PreparedStatement;
  // Account deletion (Packet 0)
  deleteUserMemories: PreparedStatement;
  deleteUserAuditLog: PreparedStatement;
  deleteUserEpisodes: PreparedStatement;
  deleteUserStatePacks: PreparedStatement;
  deleteUserSummaries: PreparedStatement;
  deleteUserMemoriesVec: PreparedStatement;
  deleteUserMemoriesVecBit: PreparedStatement;
  deleteUserEpisodeVec: PreparedStatement;
  deleteUserEpisodeVecBit: PreparedStatement;
  deleteUserSummaryVec: PreparedStatement;
  deleteUserSummaryVecBit: PreparedStatement;
  getPendingReview: PreparedStatement;
  getSpotCheckBatch: PreparedStatement;
  flagForSpotCheck: PreparedStatement;
  incrementAccessCount: PreparedStatement;
  /** S67: batched access-count increment for retrieval hot path. Single SQL
   *  using json_each instead of N awaited individual UPDATEs from
   *  decayTracker.recordAccessBatch which fired after every retrieval. */
  incrementAccessCountBatch: PreparedStatement;
  updateLastAccessed: PreparedStatement;
  filterTrustedIds: PreparedStatement;
  insertAuditEntry: PreparedStatement;
  getAuditByMemoryId: PreparedStatement;
  getLatestAuditHash: PreparedStatement;
  // R29 WB-2: per-user chain head, written under compare-and-set.
  selectChainHead: PreparedStatement;
  insertChainHead: PreparedStatement;
  casUpdateChainHead: PreparedStatement;
  deleteChainHead: PreparedStatement;
  insertTombstone: PreparedStatement;
  getTombstoneHashes: PreparedStatement;
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
  /** S67: batched hub fetch by ids. */
  getHubsByIds: PreparedStatement;
  insertHub: PreparedStatement;
  insertHubLink: PreparedStatement;
  deleteHubLink: PreparedStatement;
  getHubLinks: PreparedStatement;
  /** S67: batched hub_links fetch for many memory ids. */
  getHubLinksForMany: PreparedStatement;
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
        id, user_id, external_ref,
        claim, subject, scope, valid_from, valid_to,
        provenance, trust_class, confidence, source_hash,
        supersedes, conflicts_with, review_status,
        access_count, last_accessed, created_at, updated_at,
        permanence_status,
        hub_id, hub_score, resolution, memory_type,
        version_number, parent_version_id,
        frozen_at, decay_score, storage_tier,
        is_inhibitory, inhibition_target, interference_status,
        correction_count, is_frozen, caused_by, leads_to,
        canonical_fact_id, is_canonical,
        valid_at, invalid_at,
        persona,
        session_id, episode_id,
        raw_claim, normalization
      ) VALUES (
        @id, @userId, @externalRef,
        @claim, @subject, @scope, @validFrom, @validTo,
        @provenance, @trustClass, @confidence, @sourceHash,
        @supersedes, @conflictsWith, @reviewStatus,
        @accessCount, @lastAccessed, @createdAt, @updatedAt,
        @permanenceStatus,
        @hubId, @hubScore, @resolution, @memoryType,
        @versionNumber, @parentVersionId,
        @frozenAt, @decayScore, @storageTier,
        @isInhibitory, @inhibitionTarget, @interferenceStatus,
        @correctionCount, @isFrozen, @causedBy, @leadsTo,
        @canonicalFactId, @isCanonical,
        @validAt, @invalidAt,
        @persona,
        @sessionId, @episodeId,
        @rawClaim, @normalization
      )
    `),

    // Packet 0: every prepared statement that touches `memories` now filters
    // by user_id at the WHERE level. Cross-user reads/writes are silently
    // empty (no information leak, same shape as a missing id).
    softDeleteMemory: db.prepare(`
      UPDATE memories
      SET deleted_at = @deletedAt, delete_reason = @deleteReason, updated_at = @updatedAt
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL
    `),

    // --- Read ---

    getById: db.prepare(`
      SELECT * FROM memories WHERE id = @id AND user_id = @userId AND deleted_at IS NULL
    `),

    getByIds: db.prepare(`
      SELECT * FROM memories
      WHERE id IN (SELECT value FROM json_each(@ids))
        AND user_id = @userId
        AND deleted_at IS NULL
    `),

    // R29-WD-3 (F-D2-2): dedup must only match a CURRENT, non-rejected row.
    // Anchoring on superseded (invalid_at set) or rejected rows meant a value
    // that was once superseded could never be re-asserted (it kept hitting the
    // dead row as a "duplicate"). Excluding those rows here lets a re-assertion
    // flow through the normal supersession path; re-stating the current value is
    // still caught (invalid_at IS NULL still matches it).
    findBySourceHash: db.prepare(`
      SELECT * FROM memories
      WHERE source_hash = @sourceHash
        AND user_id = @userId
        AND deleted_at IS NULL
        AND invalid_at IS NULL
        AND trust_class != 'rejected'
      LIMIT 1
    `),

    // R29-WD-3: recurrence detection. Find previously-superseded (or otherwise
    // bi-temporally-invalid) rows that carry the same value as a new write, so
    // the pipeline can audit REASSERTED_PRIOR_VALUE and link the historical row.
    // Rejected rows are excluded (a rejected value is not a "prior value").
    findSupersededBySourceHash: db.prepare(`
      SELECT id FROM memories
      WHERE source_hash = @sourceHash
        AND user_id = @userId
        AND deleted_at IS NULL
        AND invalid_at IS NOT NULL
        AND trust_class != 'rejected'
      ORDER BY invalid_at DESC
    `),

    findByExternalRef: db.prepare(`
      SELECT * FROM memories
      WHERE user_id = @userId
        AND external_ref = @externalRef
        AND deleted_at IS NULL
      LIMIT 1
    `),

    getConflicts: db.prepare(`
      SELECT m.* FROM memories m, json_each(@conflictIds) j
      WHERE m.id = j.value
        AND m.user_id = @userId
        AND m.deleted_at IS NULL
    `),

    // --- FTS5 search ---

    searchFTS: db.prepare(`
      SELECT
        m.*,
        bm25(memories_fts) AS fts_rank
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH @query
        AND m.user_id = @userId
        AND m.deleted_at IS NULL
        AND m.trust_class != 'rejected'
      ORDER BY fts_rank
      LIMIT @limit
    `),

    // Packet A: bi-temporal-aware FTS (Graphiti pattern, graphiti_core/edges.py)
    // Filters out facts that have been superseded (invalid_at <= query reference time)
    searchFTSBiTemporal: db.prepare(`
      SELECT
        m.*,
        bm25(memories_fts) AS fts_rank
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH @query
        AND m.user_id = @userId
        AND m.deleted_at IS NULL
        AND m.trust_class != 'rejected'
        AND (m.invalid_at IS NULL OR m.invalid_at > @nowIso)
      ORDER BY fts_rank
      LIMIT @limit
    `),

    // S67: bi-temporal id filter for searchVector. Replaces per-call
    // db.prepare("... id IN (?,?,?,...)") with N placeholders that varied by
    // candidate count, defeating better-sqlite3's prepare cache. The
    // json_each(@ids) form is one cacheable statement regardless of N.
    filterValidIds: db.prepare(`
      SELECT id FROM memories
      WHERE id IN (SELECT value FROM json_each(@ids))
        AND user_id = @userId
        AND deleted_at IS NULL
        AND trust_class != 'rejected'
        AND review_status NOT IN ('rejected', 'quarantined')
        AND (invalid_at IS NULL OR invalid_at > @nowIso)
    `),

    // R29 WD-2: trust filter without the bi-temporal predicate, for the
    // vector legs when no `now` is supplied. Rejected/quarantined rows are
    // kept in the table for audit but must never reach a read surface
    // (F-D2-1). searchVector previously skipped filtering entirely when
    // nowIso was absent, leaking rejected rows.
    filterTrustedIds: db.prepare(`
      SELECT id FROM memories
      WHERE id IN (SELECT value FROM json_each(@ids))
        AND user_id = @userId
        AND deleted_at IS NULL
        AND trust_class != 'rejected'
        AND review_status NOT IN ('rejected', 'quarantined')
    `),

    // --- Review queue ---

    getPendingReview: db.prepare(`
      SELECT * FROM memories
      WHERE review_status = 'pending'
        AND user_id = @userId
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT @limit
    `),

    getSpotCheckBatch: db.prepare(`
      SELECT m.* FROM spot_checks sc
      JOIN memories m ON m.id = sc.memory_id
      WHERE sc.reviewed_at IS NULL
        AND m.user_id = @userId
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
        AND user_id = @userId
        AND deleted_at IS NULL
      ORDER BY access_count DESC
      LIMIT @limit
    `),

    // --- Metadata fast path ---

    incrementAccessCount: db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed = @now, updated_at = @now
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL
    `),

    // S67: batched form. Decay tracker calls this once per retrieval with the
    // full candidate id list. Single SQL traversal beats N awaited UPDATEs.
    incrementAccessCountBatch: db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed = @now, updated_at = @now
      WHERE id IN (SELECT value FROM json_each(@ids))
        AND user_id = @userId
        AND deleted_at IS NULL
    `),

    updateLastAccessed: db.prepare(`
      UPDATE memories
      SET last_accessed = @now, updated_at = @now
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL
    `),

    // --- Audit log ---

    insertAuditEntry: db.prepare(`
      INSERT INTO audit_log (id, user_id, memory_id, action, details, previous_hash, hash, timestamp)
      VALUES (@id, @userId, @memoryId, @action, @details, @previousHash, @hash, @timestamp)
    `),

    getAuditByMemoryId: db.prepare(`
      SELECT * FROM audit_log
      WHERE memory_id = @memoryId
      ORDER BY timestamp ASC
    `),

    // S2 fix: chain is per-user. Without the user_id filter, writes by
    // user B linked to user A's last hash and the chain interleaved across
    // tenants, every user's chain looked tampered.
    getLatestAuditHash: db.prepare(`
      SELECT hash FROM audit_log
      WHERE user_id = @userId
      ORDER BY rowid DESC
      LIMIT 1
    `),

    // R29 WB-2: chain_head is the authoritative per-user audit head. Reads
    // and the compare-and-set update both run inside an IMMEDIATE
    // transaction in the write path so concurrent writers cannot fork a
    // user's chain (R29-N8). casUpdateChainHead uses IS for null-safe
    // matching of the prior head.
    selectChainHead: db.prepare(`
      SELECT last_hash AS lastHash FROM chain_head WHERE user_id = @userId
    `),
    insertChainHead: db.prepare(`
      INSERT INTO chain_head (user_id, last_hash, updated_at)
      VALUES (@userId, @lastHash, @updatedAt)
    `),
    casUpdateChainHead: db.prepare(`
      UPDATE chain_head SET last_hash = @newHash, updated_at = @updatedAt
      WHERE user_id = @userId AND last_hash IS @oldHash
    `),
    deleteChainHead: db.prepare(`DELETE FROM chain_head WHERE user_id = @userId`),

    // R29-N7 deletion tombstone manifest.
    insertTombstone: db.prepare(`
      INSERT INTO audit_tombstones (id, user_id, deleted_through_hash, reason, operator, created_at)
      VALUES (@id, @userId, @deletedThroughHash, @reason, @operator, @createdAt)
    `),
    getTombstoneHashes: db.prepare(`
      SELECT deleted_through_hash AS hash FROM audit_tombstones
      WHERE deleted_through_hash IS NOT NULL
    `),

    // --- Stats (per-user, Packet 0) ---

    countAll: db.prepare(`
      SELECT COUNT(*) AS count FROM memories
      WHERE user_id = @userId AND deleted_at IS NULL
    `),

    countByTrustClass: db.prepare(`
      SELECT trust_class, COUNT(*) AS count
      FROM memories WHERE user_id = @userId AND deleted_at IS NULL
      GROUP BY trust_class
    `),

    countByProvenance: db.prepare(`
      SELECT provenance, COUNT(*) AS count
      FROM memories WHERE user_id = @userId AND deleted_at IS NULL
      GROUP BY provenance
    `),

    countByScope: db.prepare(`
      SELECT scope, COUNT(*) AS count
      FROM memories WHERE user_id = @userId AND deleted_at IS NULL
      GROUP BY scope
    `),

    countPendingReview: db.prepare(`
      SELECT COUNT(*) AS count
      FROM memories
      WHERE review_status = 'pending'
        AND user_id = @userId
        AND deleted_at IS NULL
    `),

    avgConfidence: db.prepare(`
      SELECT AVG(confidence) AS avg
      FROM memories WHERE user_id = @userId AND deleted_at IS NULL
    `),

    oldestMemory: db.prepare(`
      SELECT created_at FROM memories
      WHERE user_id = @userId AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `),

    newestMemory: db.prepare(`
      SELECT created_at FROM memories
      WHERE user_id = @userId AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `),

    lastActivity: db.prepare(`
      SELECT MAX(updated_at) AS last FROM memories WHERE user_id = @userId
    `),

    // --- Export (cursor-based for AsyncIterable) ---

    exportPage: db.prepare(`
      SELECT * FROM memories
      WHERE user_id = @userId
        AND deleted_at IS NULL
        AND created_at > @cursor
      ORDER BY created_at ASC
      LIMIT @pageSize
    `),

    // --- Account deletion (Packet 0) ---

    deleteUserMemories: db.prepare(`DELETE FROM memories WHERE user_id = @userId`),
    deleteUserAuditLog: db.prepare(`DELETE FROM audit_log WHERE user_id = @userId`),
    deleteUserEpisodes: db.prepare(`DELETE FROM episodes WHERE user_id = @userId`),
    deleteUserStatePacks: db.prepare(`DELETE FROM state_packs WHERE user_id = @userId`),
    deleteUserSummaries: db.prepare(`DELETE FROM summaries WHERE user_id = @userId`),
    deleteUserMemoriesVec: db.prepare(`
      DELETE FROM memories_vec
      WHERE id IN (SELECT id FROM memories WHERE user_id = @userId)
    `),
    // R29-WB cascade fix: the cascade previously cleared only memories_vec,
    // leaving orphaned embeddings in the binary mirror and the episode/summary
    // vec tables after a user delete (a privacy + consistency leak, F-D4-3).
    // These are virtual (vec0) tables, so they never fire the memories DELETE
    // triggers and must be cleared explicitly, keyed off the parent rows BEFORE
    // those parents are deleted.
    deleteUserMemoriesVecBit: db.prepare(`
      DELETE FROM memories_vec_bit
      WHERE id IN (SELECT id FROM memories WHERE user_id = @userId)
    `),
    deleteUserEpisodeVec: db.prepare(`
      DELETE FROM episode_vec
      WHERE id IN (SELECT id FROM episodes WHERE user_id = @userId)
    `),
    deleteUserEpisodeVecBit: db.prepare(`
      DELETE FROM episode_vec_bit
      WHERE id IN (SELECT id FROM episodes WHERE user_id = @userId)
    `),
    deleteUserSummaryVec: db.prepare(`
      DELETE FROM summary_vec
      WHERE id IN (SELECT id FROM summaries WHERE user_id = @userId)
    `),
    deleteUserSummaryVecBit: db.prepare(`
      DELETE FROM summary_vec_bit
      WHERE id IN (SELECT id FROM summaries WHERE user_id = @userId)
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
    // S67: batched hub-by-ids, single round-trip. Mirrors getByIds JSON IN-clause pattern.
    getHubsByIds: db.prepare(`
      SELECT * FROM memory_hubs
      WHERE id IN (SELECT value FROM json_each(@ids))
    `),
    insertHub: db.prepare(`
      INSERT INTO memory_hubs (id, claim, hub_type, created_at, access_count)
      VALUES (@id, @claim, @hubType, @createdAt, @accessCount)
    `),
    insertHubLink: db.prepare(
      `INSERT OR IGNORE INTO hub_links (memory_id, hub_id, linked_at) VALUES (@memoryId, @hubId, @linkedAt)`,
    ),
    deleteHubLink: db.prepare(`DELETE FROM hub_links WHERE memory_id = @memoryId AND hub_id = @hubId`),
    getHubLinks: db.prepare(`SELECT * FROM hub_links WHERE memory_id = @memoryId ORDER BY linked_at`),
    // S67: batched links-for-many, single round-trip across N memory ids.
    getHubLinksForMany: db.prepare(`
      SELECT * FROM hub_links
      WHERE memory_id IN (SELECT value FROM json_each(@memoryIds))
      ORDER BY linked_at
    `),
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
    getInhibitoryMemories: db.prepare(
      `SELECT * FROM memories WHERE is_inhibitory = 1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    ),
    getInhibitoryBySubject: db.prepare(`
      SELECT * FROM memories WHERE is_inhibitory = 1 AND inhibition_target = @subject AND deleted_at IS NULL ORDER BY confidence DESC
    `),

    // --- Interference ---
    getColdStorage: db.prepare(
      `SELECT * FROM memories WHERE interference_status = 'cold' AND deleted_at IS NULL ORDER BY last_accessed ASC LIMIT @limit`,
    ),
    setInterferenceStatus: db.prepare(
      `UPDATE memories SET interference_status = @status, updated_at = @now WHERE id = @id AND deleted_at IS NULL`,
    ),

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
    getFrozenMemories: db.prepare(
      `SELECT * FROM memories WHERE is_frozen = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT @limit`,
    ),
    freezeMemory: db.prepare(
      `UPDATE memories SET is_frozen = 1, updated_at = @now WHERE id = @id AND deleted_at IS NULL`,
    ),
    unfreezeMemory: db.prepare(
      `UPDATE memories SET is_frozen = 0, updated_at = @now WHERE id = @id AND deleted_at IS NULL`,
    ),

    // --- Correction ---
    incrementCorrectionCount: db.prepare(
      `UPDATE memories SET correction_count = correction_count + 1, updated_at = @now WHERE id = @id AND deleted_at IS NULL`,
    ),

    // --- Meta-memory ---
    topSubjects: db.prepare(
      `SELECT subject, COUNT(*) AS count FROM memories WHERE deleted_at IS NULL GROUP BY subject ORDER BY count DESC LIMIT 10`,
    ),
    stalestMemories: db.prepare(
      `SELECT id, claim, last_accessed FROM memories WHERE deleted_at IS NULL AND is_frozen = 0 ORDER BY last_accessed ASC LIMIT 10`,
    ),
    mostAccessedMemories: db.prepare(
      `SELECT id, claim, access_count FROM memories WHERE deleted_at IS NULL ORDER BY access_count DESC LIMIT 10`,
    ),
    countInhibitory: db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE is_inhibitory = 1 AND deleted_at IS NULL`,
    ),
    countFrozen: db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE is_frozen = 1 AND deleted_at IS NULL`),
    countColdStorage: db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE interference_status = 'cold' AND deleted_at IS NULL`,
    ),
    countHubs: db.prepare(`SELECT COUNT(*) AS count FROM memory_hubs`),
  };
}
