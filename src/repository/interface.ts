import type {
  MemoryRecord,
  ScoredCandidate,
  RepositoryStats,
  MemoryHub,
  HubLink,
  MemoryVersion,
  MemoryConstraint,
  SelfPlayRun,
  SelfPlayResult,
  MetaMemoryStats,
} from '../schema/memory.js';
import type { AuditEntry, NewAuditEntry } from '../schema/audit.js';
import type { AssertionTriple } from '../plan/types.js';

/**
 * The migration seam. This is the ONLY interface that touches storage.
 * SQLite impl today. pgvector impl when trigger conditions are met.
 * See V2_ROADMAP.md: pgvector migration.
 *
 * Rules:
 * - No LLM calls inside any method.
 * - No embedding computation inside any method (caller provides embeddings).
 * - All methods are async (even if SQLite impl is sync) to support future pgvector.
 * - Errors throw typed DemiurgeError subclasses.
 */
/**
 * Packet 0 user-scoped requests:
 *
 * Methods touching memory data accept a `userId` partition key. The repository
 * filters every relevant SQL with `AND user_id = @userId` at the WHERE level,
 * so the caller cannot read or mutate another user's rows even if they hold
 * a valid memory id.
 *
 * `'system'` is the default partition for benchmarks, MCP, and pre-Packet-0
 * rows backfilled by the migration.
 *
 * Methods that do NOT take userId (hubs, novel features, R11 episodes, etc.)
 * are not exposed via the user-scoped HTTP routes in Packet 0; they remain
 * on the system partition until those routes are user-scoped in a later
 * packet. See PR description for the deferred list.
 */
export interface IMemoryRepository {
  // --- Lifecycle ---
  initialize(): Promise<void>;
  close(): Promise<void>;

  // --- STONE access ---
  getStoneStore?(): any;

  // --- Write ---
  /**
   * S3: better-sqlite3 transactions are synchronous. The previous version
   * accepted an `async` function and ran `BEGIN ... await fn() ... COMMIT`,
   * which held the write lock across the await, every concurrent writer
   * queued behind it. The contract now requires a synchronous function; if
   * you need async I/O, do it BEFORE entering the transaction.
   */
  runInTransaction<T>(fn: () => T): T;
  insert(record: MemoryRecord): Promise<string>;

  /**
   * S5: atomic insert + bi-temporal supersession + audit-log append in
   * one synchronous SQLite transaction. Use this from the write pipeline
   * instead of the three-call sequence (insert, raw supersede UPDATE,
   * appendAuditLog), those run in separate transactions, so a crash
   * between them leaves the DB in an inconsistent state (memory exists
   * with no audit entry, or superseded facts still marked valid).
   *
   * Returns the audit entry that was written so the caller can log it.
   */
  insertWithAudit(
    record: MemoryRecord,
    audit: NewAuditEntry,
    userId: string,
    options?: { supersedeIds?: string[]; supersedeAt?: string },
  ): Promise<{ memoryId: string; audit: AuditEntry }>;
  update(id: string, patch: MemoryRecordPatch, userId?: string): Promise<void>;
  softDelete(id: string, reason: string, userId?: string): Promise<void>;

  // --- Wedge 1.5 Phase 4: AMB S1 (hard-delete cascade) ---
  hardDelete(memoryId: string, userId: string): Promise<HardDeleteCounts>;

  // --- Wedge 1.5 Phase 4: AMB S3 (right-to-amendment) ---
  amend(
    memoryId: string,
    userId: string,
    newClaim: string,
    reason: string,
    newEmbedding?: number[],
  ): Promise<AmendResult>;

  // --- Read: candidate generation ---
  searchFTS(query: string, limit: number, userId?: string, nowIso?: string): Promise<ScoredCandidate[]>;
  searchVector(embedding: number[], limit: number, userId?: string, nowIso?: string): Promise<ScoredCandidate[]>;

  /**
   * A3: binary-quantized first-pass vector search. Queries the
   * `memories_vec_bit` table (48-byte rows vs 1.5KB float32, ~32× smaller)
   * using Hamming distance. Returns the same `ScoredCandidate` shape as
   * `searchVector` so callers can swap in transparently.
   *
   * Optional, implementations that don't have a binary vector table can
   * omit this; callers must check before invoking. Today only the SQLite
   * repo implements it; the retrieval-vector flag-gate is the only call
   * site (see src/retrieval/vector.ts).
   */
  searchVectorBinary?(embedding: number[], limit: number, userId?: string, nowIso?: string): Promise<ScoredCandidate[]>;
  getById(id: string, userId?: string): Promise<MemoryRecord | null>;
  getByIds(ids: string[], userId?: string): Promise<MemoryRecord[]>;
  getConflicts(id: string, userId?: string): Promise<MemoryRecord[]>;

  /**
   * Sanity-probe helper: return ANY one memory row owned by `userId`,
   * or null when the partition is empty. Used by the S67 bench probe
   * in scripts/benchmark-*.ts to verify writes landed in the expected
   * user partition WITHOUT going through retrieval (which is subject
   * to rerank confidence floors, vector search availability, etc.).
   * The probe should answer "did the writes land in this partition?"
   * with a SQL lookup, not a full search pipeline.
   *
   * Implementation chooses the row by `rowid ASC LIMIT 1` so the
   * result is deterministic for a given seeded conversation. Callers
   * use `record.subject` or a slice of `record.claim` as a real query
   * the reranker's confidence floor will accept.
   */
  getOneByUser(userId: string): Promise<MemoryRecord | null>;

  // --- Read: dedup ---
  findBySourceHash(hash: string, userId?: string): Promise<MemoryRecord | null>;
  // R29-WD-3: previously-superseded row ids carrying the same value (for
  // REASSERTED_PRIOR_VALUE auditing on re-assertion).
  findSupersededBySourceHash(hash: string, userId?: string): Promise<string[]>;
  findSimilar(embedding: number[], threshold: number, userId?: string): Promise<ScoredCandidate[]>;
  findByExternalRef(userId: string, externalRef: string): Promise<MemoryRecord | null>;

  // --- Review queue ---
  getPendingReview(limit: number, userId?: string): Promise<MemoryRecord[]>;
  getSpotCheckBatch(limit: number, userId?: string): Promise<MemoryRecord[]>;
  flagForSpotCheck(id: string): Promise<void>;

  // --- Metadata updates (fast path, no LLM) ---
  incrementAccessCount(id: string, userId?: string): Promise<void>;
  /** S67: single-SQL batch form of incrementAccessCount. Used by the decay
   *  tracker's recordAccessBatch hot path (called after every retrieval).
   *  Scoped by user_id (Packet 0 invariant: cross-user mutation impossible). */
  incrementAccessCountBatch(ids: string[], userId?: string): Promise<void>;
  updateLastAccessed(id: string, userId?: string): Promise<void>;

  // --- Audit log ---
  appendAuditLog(entry: NewAuditEntry, userId?: string): Promise<AuditEntry>;
  getAuditLog(memoryId: string): Promise<AuditEntry[]>;
  /**
   * S2: chain head is per-user. Returns the latest hash for the given user,
   * or null if that user has no audit entries yet. Default 'system' for
   * back-compat with callers that haven't been threaded through yet.
   */
  getLatestAuditHash(userId?: string): Promise<string | null>;
  /** Wedge 1.5 Phase 4: full ordered audit chain for cron verification (admin/system). */
  getAllAuditEntries(): Promise<AuditEntry[]>;

  // --- Export / stats ---
  exportAll(userId?: string): AsyncIterable<MemoryRecord>;
  getStats(userId?: string): Promise<RepositoryStats>;
  getLastActivityTimestamp(userId?: string): Promise<string | null>;

  // --- Promotion ---
  getPromotionCandidates(
    minAccessCount: number,
    minAgeDays: number,
    limit: number,
    userId?: string,
  ): Promise<MemoryRecord[]>;

  // --- Bulk (for circuit breaker) ---
  countAll(userId?: string): Promise<number>;

  // --- Account deletion (Packet 0: cascading per-user wipe) ---
  deleteUserCascade(userId: string): Promise<{
    memories: number;
    audit: number;
    episodes: number;
    statePacks: number;
    summaries: number;
  }>;

  // --- System metadata (key-value store for circuit breaker, etc.) ---
  setMetadata(key: string, value: string): Promise<void>;
  getMetadata(key: string): Promise<string | null>;

  // --- Tags ---
  getMemoryTags(memoryId: string): Promise<string[]>;
  setMemoryTags(memoryId: string, tags: string[]): Promise<void>;
  searchByTag(tag: string, limit: number): Promise<MemoryRecord[]>;
  getAllTags(): Promise<{ tag: string; count: number }[]>;

  // --- Hubs (fractal hub-and-spoke) ---
  getHubs(limit: number): Promise<MemoryHub[]>;
  getHubById(hubId: string): Promise<MemoryHub | null>;
  /** S67: batched fetch for hub-cascade hot path. Single round-trip for many hub ids. */
  getHubsByIds(hubIds: string[]): Promise<MemoryHub[]>;
  createHub(hub: MemoryHub): Promise<string>;
  linkToHub(memoryId: string, hubId: string): Promise<void>;
  unlinkFromHub(memoryId: string, hubId: string): Promise<void>;
  getHubLinks(memoryId: string): Promise<HubLink[]>;
  /** S67: batched fetch for hub-cascade hot path. Single round-trip for many memory ids. */
  getHubLinksForMany(memoryIds: string[]): Promise<HubLink[]>;
  getHubMembers(hubId: string, limit: number): Promise<MemoryRecord[]>;
  incrementHubAccessCount(hubId: string): Promise<void>;

  // --- Memory versions ---
  createVersion(version: MemoryVersion): Promise<string>;
  getVersionHistory(memoryId: string): Promise<MemoryVersion[]>;

  // --- Inhibitory memory ---
  getInhibitoryMemories(subject?: string): Promise<MemoryRecord[]>;
  getBySubject(subject: string, limit: number, userId?: string): Promise<MemoryRecord[]>;
  /** L3 continuity: current facts that superseded an earlier value, most recent first. */
  getRecentCorrections(limit: number, userId?: string): Promise<MemoryRecord[]>;
  /** L3 continuity: the most recent episode (current focus), or null if none. */
  getRecentEpisode(userId?: string): Promise<{ subject: string; title: string; summary: string } | null>;
  getActiveInhibitions(): Promise<MemoryRecord[]>;

  // --- Interference (cold storage) ---
  getColdStorageMemories(limit: number): Promise<MemoryRecord[]>;
  moveToColdStorage(id: string): Promise<void>;
  resurrectFromColdStorage(id: string): Promise<void>;

  // --- Constraints ---
  getConstraints(activeOnly?: boolean): Promise<MemoryConstraint[]>;
  insertConstraint(constraint: MemoryConstraint): Promise<string>;
  deactivateConstraint(id: string): Promise<void>;

  // --- Causal/narrative chains ---
  getCausalChain(memoryId: string, direction: 'up' | 'down', maxDepth: number): Promise<MemoryRecord[]>;

  // --- Self-play ---
  insertSelfPlayRun(run: SelfPlayRun): Promise<string>;
  updateSelfPlayRun(runId: string, patch: Partial<SelfPlayRun>): Promise<void>;
  insertSelfPlayResult(result: SelfPlayResult): Promise<string>;
  getSelfPlayResults(runId: string): Promise<SelfPlayResult[]>;
  getLatestSelfPlayRun(): Promise<SelfPlayRun | null>;

  // --- Freeze / pause ---
  getFrozenMemories(limit: number): Promise<MemoryRecord[]>;
  freezeMemory(id: string): Promise<void>;
  unfreezeMemory(id: string): Promise<void>;

  // --- Meta-memory (computed) ---
  getMetaMemoryStats(): Promise<MetaMemoryStats>;

  // --- Correction tracking ---
  incrementCorrectionCount(id: string): Promise<void>;

  // --- R11: Facets ---
  populateFacets(record: MemoryRecord): Promise<void>;

  // --- R11: Episodes ---
  searchEpisodeVec(embedding: number[], limit: number): Promise<Array<{ id: string; distance: number }>>;
  getEpisodeMemberFactIds(episodeId: string): Promise<string[]>;
  getEpisodeById(episodeId: string): Promise<{
    id: string;
    subject: string;
    title: string;
    summary: string;
    timeframe_start: string | null;
    timeframe_end: string | null;
    fact_count: number;
  } | null>;
  getEpisodeFactClaims(episodeId: string): Promise<string[]>;
  insertEpisode(episode: {
    id: string;
    subject: string;
    title: string;
    summary: string;
    timeframe_start: string | null;
    timeframe_end: string | null;
    session_source: string | null;
    fact_count: number;
  }): Promise<void>;
  insertEpisodeFact(episodeId: string, factId: string, ordinal: number): Promise<void>;
  insertEpisodeVec(id: string, embedding: number[]): Promise<void>;

  // --- R11: State Packs ---
  updateStatePack(record: MemoryRecord): Promise<void>;
  buildStatePackInjection(query: string, isCurrentState: boolean): Promise<string>;

  // --- R11: Summaries ---
  buildSummaryInjection(queryEmbedding: number[]): Promise<{ text: string; subjects: string[] }>;

  // --- R11: Bridge ---
  retrieveBridgeFacts(subjects: string[]): Promise<Array<{ id: string; record: any; score: number }>>;
  populateBridgeFact(factId: string, primarySubject: string, mentionedSubjectsJson: string): Promise<void>;
  backfillBridgeFacts(): Promise<number>;

  // --- R11: Benchmark post-seed hooks ---
  runPostSeedHooks(apiKey?: string): Promise<{ episodes: number; summaries: number; bridges: number }>;

  /**
   * S79 fix #2: rebuild episodes for the given subjects over all their current
   * facts. Called synchronously at the end of dispatch.ingest so prod and bench
   * build episodes on the same path. Idempotent: deletes each subject's existing
   * episodes before rebuilding. Self-gates on EPISODES_ENABLED. Returns the
   * number of episodes built.
   */
  buildEpisodesForSubjects(subjects: string[], apiKey?: string, userId?: string): Promise<number>;

  // --- Wedge 2 (S74): assertion_triples ---
  /**
   * Write a batch of triples for one assertion. Called immediately after
   * `insert(record)` from the write pipeline, atomically via runInTransaction
   * so memory + triples commit together. `assertion_id` on every row must
   * match `assertionId`; the implementation validates this defensively.
   */
  insertTriples(assertionId: string, rows: AssertionTriple[]): Promise<void>;
  /** Subject lookup. `predicate=null` returns all triples (including fallback rows). */
  searchTriplesBySubject(subject: string, predicate: string | null, limit?: number): Promise<AssertionTriple[]>;
  /** Object lookup. `predicate=null` returns every match regardless of predicate. */
  searchTriplesByObject(object: string, predicate: string | null, limit?: number): Promise<AssertionTriple[]>;
  /** Predicate-only scan. Skips fallback rows (predicate IS NULL). */
  searchTriplesByPredicate(predicate: string, limit?: number): Promise<AssertionTriple[]>;
  /** Cluster lookup by anchor uuid. Returns every triple whose conflict_set_id matches. */
  searchTriplesByConflictSet(conflictSetId: string): Promise<AssertionTriple[]>;
  /** Used by the backfill script to skip rows that already have triples. */
  hasTriplesForAssertion(assertionId: string): Promise<boolean>;
}

/**
 * Wedge 1.5 Phase 4 (AMB S1): per-table row counts purged by a hardDelete call.
 * Used by the AMB hard-delete-cascade harness scorecard.
 */
export interface HardDeleteCounts {
  memory: number;
  embedding: number;
  fts: number;
  tags: number;
  versions: number;
  hubLinks: number;
  episodes: number;
}

/**
 * Wedge 1.5 Phase 4 (AMB S3): result of an amend call. fromVersion is the
 * version_number of the row before the amendment; toVersion is after.
 */
export interface AmendResult {
  memoryId: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
}

/**
 * Subset of MemoryRecord fields that can be patched.
 * Excludes: id, createdAt, sourceHash (immutable after creation).
 */
export interface MemoryRecordPatch {
  claim?: string;
  subject?: string;
  scope?: string;
  validFrom?: string | null;
  validTo?: string | null;
  provenance?: string;
  trustClass?: string;
  confidence?: number;
  supersedes?: string | null;
  conflictsWith?: string[];
  reviewStatus?: string;
  accessCount?: number;
  lastAccessed?: string;
  updatedAt?: string;
  embedding?: number[] | null;
  permanenceStatus?: string;
  hubId?: string | null;
  hubScore?: number;
  resolution?: number;
  memoryType?: string;
  versionNumber?: number;
  parentVersionId?: string | null;
  frozenAt?: string | null;
  decayScore?: number;
  storageTier?: string;
  isInhibitory?: boolean;
  inhibitionTarget?: string | null;
  interferenceStatus?: string;
  correctionCount?: number;
  isFrozen?: boolean;
  causedBy?: string | null;
  leadsTo?: string | null;
  // Packet A: bi-temporal
  validAt?: string | null;
  invalidAt?: string | null;
  // Packet C3 / Bug 3: persona flag
  persona?: boolean;
}
