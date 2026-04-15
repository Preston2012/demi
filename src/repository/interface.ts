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
export interface IMemoryRepository {
  // --- Lifecycle ---
  initialize(): Promise<void>;
  close(): Promise<void>;

  // --- STONE access ---
  getStoneStore?(): any;

  // --- Write ---
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  insert(record: MemoryRecord): Promise<string>;
  update(id: string, patch: MemoryRecordPatch): Promise<void>;
  softDelete(id: string, reason: string): Promise<void>;

  // --- Read: candidate generation ---
  searchFTS(query: string, limit: number): Promise<ScoredCandidate[]>;
  searchVector(embedding: number[], limit: number): Promise<ScoredCandidate[]>;
  getById(id: string): Promise<MemoryRecord | null>;
  getByIds(ids: string[]): Promise<MemoryRecord[]>;
  getConflicts(id: string): Promise<MemoryRecord[]>;

  // --- Read: dedup ---
  findBySourceHash(hash: string): Promise<MemoryRecord | null>;
  findSimilar(embedding: number[], threshold: number): Promise<ScoredCandidate[]>;

  // --- Review queue ---
  getPendingReview(limit: number): Promise<MemoryRecord[]>;
  getSpotCheckBatch(limit: number): Promise<MemoryRecord[]>;
  flagForSpotCheck(id: string): Promise<void>;

  // --- Metadata updates (fast path, no LLM) ---
  incrementAccessCount(id: string): Promise<void>;
  updateLastAccessed(id: string): Promise<void>;

  // --- Audit log ---
  appendAuditLog(entry: NewAuditEntry): Promise<AuditEntry>;
  getAuditLog(memoryId: string): Promise<AuditEntry[]>;
  getLatestAuditHash(): Promise<string | null>;

  // --- Export / stats ---
  exportAll(): AsyncIterable<MemoryRecord>;
  getStats(): Promise<RepositoryStats>;
  getLastActivityTimestamp(): Promise<string | null>;

  // --- Promotion ---
  getPromotionCandidates(minAccessCount: number, minAgeDays: number, limit: number): Promise<MemoryRecord[]>;

  // --- Bulk (for circuit breaker) ---
  countAll(): Promise<number>;

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
  createHub(hub: MemoryHub): Promise<string>;
  linkToHub(memoryId: string, hubId: string): Promise<void>;
  unlinkFromHub(memoryId: string, hubId: string): Promise<void>;
  getHubLinks(memoryId: string): Promise<HubLink[]>;
  getHubMembers(hubId: string, limit: number): Promise<MemoryRecord[]>;
  incrementHubAccessCount(hubId: string): Promise<void>;

  // --- Memory versions ---
  createVersion(version: MemoryVersion): Promise<string>;
  getVersionHistory(memoryId: string): Promise<MemoryVersion[]>;

  // --- Inhibitory memory ---
  getInhibitoryMemories(subject?: string): Promise<MemoryRecord[]>;
  getBySubject(subject: string, limit: number): Promise<MemoryRecord[]>;
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
  getEpisodeById(
    episodeId: string,
  ): Promise<{
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
}
