import { runAutopsy as executeAutopsy } from '../autopsy/index.js';
import type { IMemoryRepository } from '../repository/interface.js';
import type { StoneStore, Conversation, ConversationMessage } from '../stone/index.js';
import type { TemporalStore, TemporalEvent } from '../temporal/index.js';
import type { Config } from '../config.js';
import type { MemoryRecord, AddMemoryResult, InjectionPayload, SystemStats } from '../schema/memory.js';
import type { RetrievalResult } from '../retrieval/index.js';
import { AuditAction } from '../schema/audit.js';
import { TrustClass, ReviewStatus, isValidTransition } from '../schema/memory.js';
import { MemoryNotFoundError, CircuitBreakerActiveError, ValidationError } from '../errors.js';
import { createLogger } from '../config.js';
import { retrieve } from '../retrieval/index.js';
import { addMemory as writeMemory } from '../write/index.js';
import { buildInjectionPayload, formatForContext } from '../inject/index.js';
import { getInjectionMode } from '../retrieval/query-classifier.js';
import { formatEpisodesForInjection } from '../inject/episodes.js';
import { createReviewQueue } from '../learn/review-queue.js';
import { createDecayTracker } from '../learn/decay.js';
import { createCircuitBreaker } from '../learn/circuit-breaker.js';
import { runSelfPlay as executeSelfPlay } from '../learn/self-play.js';
import { runInterferenceBatch as executeInterferenceBatch } from '../learn/interference-batch.js';
import { identifyHubCandidates, promoteToHub as executePromoteToHub } from '../learn/hub-computation.js';
import { flushShadowLog } from '../retrieval/thompson.js';

const log = createLogger('dispatch');

/**
 * Core dispatch layer.
 *
 * Wires all 5 layers: Capture → Store → Retrieve → Inject → Learn.
 * Every MCP tool and REST endpoint calls through this interface.
 * Enforces cross-cutting concerns: circuit breaker, decay tracking, audit.
 */

export interface SearchResult {
  payload: InjectionPayload;
  contextText: string;
  raw: RetrievalResult;
}

export interface CoreDispatch {
  /** Search memories and build injection context. Primary read path. */
  search(query: string, limit?: number, conversationId?: string): Promise<SearchResult>;

  /** Write a new memory through trust branching pipeline. */
  addMemory(input: unknown): Promise<AddMemoryResult>;

  /** Get a single memory by ID. */
  getMemory(id: string): Promise<MemoryRecord>;

  /** Confirm a memory (user override to confirmed trust class). */
  confirmMemory(id: string, reason?: string): Promise<void>;

  /** Reject a memory (user override to rejected). */
  rejectMemory(id: string, reason?: string): Promise<void>;

  /** Get pending review queue. */
  getPendingReviews(limit?: number): Promise<MemoryRecord[]>;

  /** System stats. */
  getStats(): Promise<SystemStats>;

  /** Full brain export (all memories as async iterable). */
  exportBrain(): Promise<AsyncIterable<MemoryRecord>>;

  /** Graceful shutdown. Flush buffers. */
  shutdown(): Promise<void>;

  // --- Novel features ---

  /** Freeze a memory (skip decay, user-preserved). */
  freezeMemory(id: string): Promise<void>;

  /** Unfreeze a memory. */
  unfreezeMemory(id: string): Promise<void>;

  /** Get/set global pause state. */
  getGlobalPause(): Promise<boolean>;
  setGlobalPause(paused: boolean): Promise<void>;

  /** Memory version history. */
  getVersionHistory(memoryId: string): Promise<unknown[]>;

  /** Tags CRUD. */
  getMemoryTags(memoryId: string): Promise<string[]>;
  setMemoryTags(memoryId: string, tags: string[]): Promise<void>;
  searchByTag(tag: string, limit?: number): Promise<unknown[]>;

  /** Hubs. */
  getHubs(limit?: number): Promise<unknown[]>;
  getHubMembers(hubId: string, limit?: number): Promise<unknown[]>;

  /** Cold storage. */
  getColdStorage(limit?: number): Promise<unknown[]>;
  resurrectMemory(id: string): Promise<void>;

  /** Meta-memory stats. */
  getMetaMemoryStats(): Promise<unknown>;

  /** Self-play. */
  runSelfPlay(): Promise<unknown>;
  getLatestSelfPlayRun(): Promise<unknown>;

  /** Interference batch. */
  runInterferenceBatch(): Promise<unknown>;

  /** Hub candidates. */
  getHubCandidates(): Promise<unknown[]>;
  promoteToHub(memoryId: string, hubType?: string): Promise<unknown>;

  /** Increment correction count on a memory. */
  correctMemory(id: string, newClaim: string, reason: string): Promise<void>;

  // --- Temporal Events ---

  /** Search temporal events by text. */
  temporalSearch(query: string, limit?: number): Promise<TemporalEvent[]>;

  /** Get events in a datetime range. */
  temporalRange(startDatetime: string, endDatetime: string, limit?: number): Promise<TemporalEvent[]>;

  /** Get events for a subject. */
  temporalBySubject(subject: string, limit?: number): Promise<TemporalEvent[]>;

  /** Get full timeline. */
  temporalTimeline(limit?: number): Promise<TemporalEvent[]>;

  /** Add temporal events (from extraction). */
  temporalAddEvents(events: TemporalEvent[]): Promise<number>;

  /** Get event count. */
  temporalEventCount(): Promise<number>;

  // --- STONE (raw conversation store) ---

  /** Search raw conversation turns via FTS5. */
  stoneSearchTurns(query: string, limit?: number): Promise<Array<ConversationMessage & { rank: number }>>;

  /** Get a conversation with its messages. */
  stoneGetConversation(
    conversationId: string,
  ): Promise<{ conversation: Conversation | null; messages: ConversationMessage[] }>;

  /** List all conversations. */
  stoneListConversations(limit?: number): Promise<Array<Conversation & { messageCount: number; totalTokens: number }>>;

  /** Get neighbor messages around a turn (episode context). */
  stoneGetNeighbors(conversationId: string, sequenceNumber: number, window?: number): Promise<ConversationMessage[]>;

  runAutopsy(query: string, expected: string, predicted: string, searchTerms: string[]): Promise<unknown>;
}

export function createCoreDispatch(
  repo: IMemoryRepository,
  config: Config,
  stone?: StoneStore | null,
  temporal?: TemporalStore | null,
): CoreDispatch {
  const reviewQueue = createReviewQueue(repo);
  const decayTracker = createDecayTracker(repo, {
    halfLifeDays: config.freshnessHalfLifeDays,
  });
  const circuitBreaker = createCircuitBreaker(repo, {
    lockAfterDays: config.inactivityLockDays,
  });

  return {
    async search(query: string, limit?: number, conversationId?: string): Promise<SearchResult> {
      // Circuit breaker gates the read path
      // --- S23: Compression router — skip retrieval for small conversations ---
      if (stone && conversationId && process.env.COMPRESSION_ROUTER_ENABLED === 'true') {
        try {
          const { routeByBudget } = await import('../retrieval/compression-router.js');
          const routeResult = routeByBudget(stone, conversationId);
          if (routeResult.skipRetrieval && routeResult.directContext) {
            log.info({ conversationId, reason: routeResult.reason }, 'Compression router: skipping retrieval');
            const emptyResult: RetrievalResult = {
              candidates: [],
              metadata: {
                query,
                queryType: 'single-hop' as any,
                queryEmbedding: null,
                candidatesGenerated: 0,
                candidatesAfterFilter: 0,
                candidatesReturned: 0,
                timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 },
              },
            };
            const directPayload = buildInjectionPayload(emptyResult, config.maxInjectedRules);
            return {
              payload: directPayload,
              contextText: routeResult.directContext,
              raw: emptyResult,
            };
          }
        } catch (err) {
          log.warn({ err }, 'Compression router failed, falling back to standard retrieval');
        }
      }

      const locked = await circuitBreaker.isLocked();
      if (locked) {
        const lastActivity = await repo.getLastActivityTimestamp();
        throw new CircuitBreakerActiveError(lastActivity ?? 'unknown');
      }

      // Retrieve candidates
      const result = await retrieve(repo, query, config, limit);

      // Record access for decay tracking (fire-and-forget)
      const ids = result.candidates.map((c) => c.id);
      if (ids.length > 0) {
        decayTracker.recordAccessBatch(ids).catch((err) => log.error({ err }, 'Decay batch update failed'));
      }

      // Build injection payload
      const payload = buildInjectionPayload(result, config.maxInjectedRules);
      let contextText = formatForContext(payload);

      // R11: Episode injection (injection-only, no retrieval interference)
      // Episodes are searched and formatted here in dispatch, NOT in retrieval.
      // This ensures zero impact on the fact candidate pool.
      if (process.env.EPISODES_ENABLED === 'true' && result.metadata.queryEmbedding) {
        const injectionMode = getInjectionMode(result.metadata.queryType);
        if (injectionMode.episodes) {
          try {
            const threshold = parseFloat(process.env.EPISODE_COSINE_THRESHOLD || '0.6');
            const maxEpisodes = parseInt(process.env.MAX_INJECTED_EPISODES || '3', 10);
            const epVecResults = await repo.searchEpisodeVec(result.metadata.queryEmbedding, 10);
            const episodes: Array<{
              id: string;
              subject: string;
              title: string;
              summary: string;
              timeframe_start: string | null;
              timeframe_end: string | null;
              fact_claims: string[];
              cosine_score: number;
            }> = [];
            for (const epResult of epVecResults) {
              const score = 1 - epResult.distance / 2;
              if (score < threshold) continue;
              const ep = await repo.getEpisodeById(epResult.id);
              if (!ep) continue;
              const claims = await repo.getEpisodeFactClaims(epResult.id);
              episodes.push({ ...ep, fact_claims: claims, cosine_score: score });
              if (episodes.length >= maxEpisodes) break;
            }
            if (episodes.length > 0) {
              const episodeText = formatEpisodesForInjection(episodes);
              const insertPoint = '--- Memory Context';
              const idx = contextText.indexOf(insertPoint);
              if (idx > 0) {
                contextText = contextText.slice(0, idx) + episodeText + '\n' + contextText.slice(idx);
              }
            }
          } catch (epErr) {
            log.warn({ err: epErr }, 'Episode injection failed (non-critical)');
          }
        }
      }

      // R11: Summaries KILLED (prune). Was -1.0 LOCOMO.

      // R11: State packs KILLED (prune). Was -2.4 LOCOMO, -2.3 BEAM.


      // --- S23: Temporal event injection for temporal queries ---
      if (temporal && result.metadata.queryType === 'temporal') {
        try {
          const temporalEvents = temporal.searchEvents(query, 10);
          if (temporalEvents.length > 0) {
            const timelineText = temporalEvents
              .filter(e => e.eventDatetime)
              .sort((a, b) => (a.eventDatetime || '').localeCompare(b.eventDatetime || ''))
              .map(e => `[${e.eventDatetime}] ${e.subject} ${e.verb}${e.object ? ' ' + e.object : ''}`)
              .join('\n');
            if (timelineText) {
              contextText = `TEMPORAL EVENTS (structured timeline):\n${timelineText}\n\n${contextText}`;
            }
          }
        } catch (err) {
          log.warn({ err }, 'Temporal event injection failed (non-critical)');
        }
      }

      // --- S23: STONE neighbor expansion for richer context ---
      if (stone && process.env.STONE_NEIGHBOR_EXPANSION === 'true' && result.candidates.length > 0) {
        try {
          // For top-3 retrieved facts, find their STONE source conversation
          // and pull neighboring messages for context
          const topCandidates = result.candidates.slice(0, 3);
          const neighborContextParts: string[] = [];

          for (const candidate of topCandidates) {
            const record = candidate.candidate.record;
            if (!record?.provenance) continue;

            // Try to find this fact's source conversation in STONE
            const searchResults = stone.searchMessages(record.claim.substring(0, 60), 1);
            if (searchResults.length > 0) {
              const msg = searchResults[0]!;
              const neighbors = stone.getNeighborMessages(msg.conversationId, msg.sequenceNumber, 1, 1);
              if (neighbors.length > 1) {
                const ctx = neighbors
                  .map(n => `[${n.role}]: ${n.content.substring(0, 200)}`)
                  .join('\n');
                neighborContextParts.push(ctx);
              }
            }
          }

          if (neighborContextParts.length > 0) {
            const stoneContext = neighborContextParts.join('\n---\n');
            contextText = `${contextText}\n\nCONVERSATION CONTEXT (from raw logs):\n${stoneContext}`;
          }
        } catch (err) {
          log.warn({ err }, 'STONE neighbor expansion failed (non-critical)');
        }
      }

      // --- S27: Specialist pre-processing pipeline ---
      if (process.env.SPECIALIST_ROUTING === 'true') {
        try {
          const { initializeSpecialists, runSpecialistPipeline } = await import('../specialist/pipeline.js');
          initializeSpecialists();
          const evidencePacket = runSpecialistPipeline(payload.memories, query, result.metadata.queryType);
          if (evidencePacket.specialistOutputs.length > 0) {
            const computedEvidence = evidencePacket.specialistOutputs
              .map((o) => o.derivedEvidence)
              .join('\n\n');
            // S27 fix #15: raw first, computed last (LLM recency-bias attention)
            contextText = `[MEMORY EVIDENCE]\n${contextText}\n\n[COMPUTED EVIDENCE — use these resolved values over raw memories above]\n${computedEvidence}`;
            log.info({
              specialists: evidencePacket.specialistOutputs.map((o) => o.source),
              totalMs: evidencePacket.totalSpecialistMs.toFixed(1),
            }, 'Specialist pipeline completed');
          }
        } catch (err) {
          log.warn({ err }, 'Specialist pipeline failed (non-critical)');
        }
      }

      // S25: Strict memory-only directive (reduces hallucination)
      if (process.env.STRICT_MEMORY_ONLY === 'true') {
        contextText = 'IMPORTANT: Answer ONLY using the memories provided below. Do not use external knowledge. If the answer cannot be determined from these memories alone, state that clearly.' + '\n\n' + contextText;
      }

      return { payload, contextText, raw: result };
    },

    async addMemory(input: unknown): Promise<AddMemoryResult> {
      // Delegate entirely to write pipeline (which handles its own audit logging)
      const result = await writeMemory(input, repo, config);

      // Record activity on circuit breaker for non-rejected writes
      if (result.action !== 'rejected') {
        circuitBreaker.recordActivity().catch((err) => log.error({ err }, 'Circuit breaker activity record failed'));
      }

      return result;
    },

    async getMemory(id: string): Promise<MemoryRecord> {
      const record = await repo.getById(id);
      if (!record) throw new MemoryNotFoundError(id);
      return record;
    },

    async confirmMemory(id: string, reason?: string): Promise<void> {
      const memory = await repo.getById(id);
      if (!memory) throw new MemoryNotFoundError(id);

      if (!isValidTransition(memory.trustClass, TrustClass.CONFIRMED)) {
        throw new ValidationError(`Cannot transition from ${memory.trustClass} to confirmed`);
      }

      await repo.update(id, {
        trustClass: TrustClass.CONFIRMED,
        reviewStatus: ReviewStatus.APPROVED,
        updatedAt: new Date().toISOString(),
      });

      await repo.appendAuditLog({
        memoryId: id,
        action: AuditAction.CONFIRMED,
        details: reason ?? null,
      });

      await circuitBreaker.recordActivity();
      log.info(`Memory confirmed: ${id}`);
    },

    async rejectMemory(id: string, reason?: string): Promise<void> {
      const memory = await repo.getById(id);
      if (!memory) throw new MemoryNotFoundError(id);

      if (!isValidTransition(memory.trustClass, TrustClass.REJECTED)) {
        throw new ValidationError(`Cannot transition from ${memory.trustClass} to rejected`);
      }

      await repo.update(id, {
        trustClass: TrustClass.REJECTED,
        reviewStatus: ReviewStatus.REJECTED,
        updatedAt: new Date().toISOString(),
      });

      await repo.appendAuditLog({
        memoryId: id,
        action: AuditAction.REJECTED,
        details: reason ?? null,
      });

      log.info(`Memory rejected: ${id}${reason ? ` (${reason})` : ''}`);
    },

    async getPendingReviews(limit?: number): Promise<MemoryRecord[]> {
      return reviewQueue.getPending(limit);
    },

    async getStats(): Promise<SystemStats> {
      const repoStats = await repo.getStats();
      const locked = await circuitBreaker.isLocked();
      const lastActivity = await repo.getLastActivityTimestamp();

      return {
        ...repoStats,
        circuitBreakerActive: locked,
        lastActivityAt: lastActivity,
        uptimeSeconds: Math.floor(process.uptime()),
        thompsonShadowEnabled: config.thompsonShadowEnabled,
        hubCount: 0,
        spokeCount: 0,
        crossDomainLinkCount: 0,
        inhibitionEdgeCount: 0,
        procedureCount: 0,
        coldStorageCount: 0,
        archivedCount: 0,
        frozenCount: 0,
        decayPaused: false,
        lastSelfPlayScore: null,
        lastSelfPlayDate: null,
        memoryHealthGrade: null,
      };
    },

    async exportBrain(): Promise<AsyncIterable<MemoryRecord>> {
      await repo.appendAuditLog({
        memoryId: null,
        action: AuditAction.EXPORT,
        details: null,
      });

      return repo.exportAll();
    },

    async shutdown(): Promise<void> {
      log.info('Dispatch shutdown initiated');
      await flushShadowLog(config.backupPath);
      log.info('Dispatch shutdown complete');
    },

    // --- Novel features ---

    async freezeMemory(id: string): Promise<void> {
      const memory = await repo.getById(id);
      if (!memory) throw new MemoryNotFoundError(id);
      await repo.freezeMemory(id);
      await repo.appendAuditLog({ memoryId: id, action: AuditAction.FROZEN, details: null });
      log.info(`Memory frozen: ${id}`);
    },

    async unfreezeMemory(id: string): Promise<void> {
      const memory = await repo.getById(id);
      if (!memory) throw new MemoryNotFoundError(id);
      await repo.unfreezeMemory(id);
      await repo.appendAuditLog({ memoryId: id, action: AuditAction.UNFROZEN, details: null });
      log.info(`Memory unfrozen: ${id}`);
    },

    async getGlobalPause(): Promise<boolean> {
      const val = await repo.getMetadata('global_pause');
      return val === 'true';
    },

    async setGlobalPause(paused: boolean): Promise<void> {
      await repo.setMetadata('global_pause', String(paused));
      log.info(`Global pause ${paused ? 'enabled' : 'disabled'}`);
    },

    async getVersionHistory(memoryId: string) {
      return repo.getVersionHistory(memoryId);
    },

    async getMemoryTags(memoryId: string) {
      return repo.getMemoryTags(memoryId);
    },

    async setMemoryTags(memoryId: string, tags: string[]) {
      await repo.setMemoryTags(memoryId, tags);
    },

    async searchByTag(tag: string, limit = 15) {
      return repo.searchByTag(tag, limit);
    },

    async getHubs(limit = 20) {
      return repo.getHubs(limit);
    },

    async getHubMembers(hubId: string, limit = 20) {
      return repo.getHubMembers(hubId, limit);
    },

    async getColdStorage(limit = 50) {
      return repo.getColdStorageMemories(limit);
    },

    async resurrectMemory(id: string) {
      await repo.resurrectFromColdStorage(id);
      await repo.appendAuditLog({ memoryId: id, action: AuditAction.RESURRECTED, details: null });
      log.info(`Memory resurrected: ${id}`);
    },

    async getMetaMemoryStats() {
      return repo.getMetaMemoryStats();
    },

    async runSelfPlay() {
      return executeSelfPlay(repo, config);
    },

    async getLatestSelfPlayRun() {
      return repo.getLatestSelfPlayRun();
    },

    async runInterferenceBatch() {
      return executeInterferenceBatch(repo);
    },

    async getHubCandidates() {
      return identifyHubCandidates(repo);
    },

    async promoteToHub(memoryId: string, hubType = 'principle') {
      return executePromoteToHub(repo, memoryId, hubType);
    },

    async correctMemory(id: string, newClaim: string, reason: string) {
      const memory = await repo.getById(id);
      if (!memory) throw new MemoryNotFoundError(id);

      // Create version snapshot before correction
      const { v4: versionUuid } = await import('uuid');
      await repo.createVersion({
        id: versionUuid(),
        memoryId: id,
        claim: memory.claim,
        changedAt: new Date().toISOString(),
        reason,
      });

      await repo.update(id, { claim: newClaim });
      await repo.incrementCorrectionCount(id);

      await repo.appendAuditLog({
        memoryId: id,
        action: AuditAction.CORRECTION,
        details: `Corrected: "${memory.claim}" → "${newClaim}". Reason: ${reason}`,
      });

      log.info({ memoryId: id }, 'Memory corrected with version snapshot');
    },

    async runAutopsy(query: string, expected: string, predicted: string, searchTerms: string[]) {
      return executeAutopsy(repo, query, expected, predicted, searchTerms);
    },

    // --- STONE methods ---

    async stoneSearchTurns(query: string, limit = 20) {
      if (!stone) throw new Error('STONE is not enabled. Set STONE_ENABLED=true.');
      return stone.searchMessages(query, limit);
    },

    async stoneGetConversation(conversationId: string) {
      if (!stone) throw new Error('STONE is not enabled. Set STONE_ENABLED=true.');
      return {
        conversation: stone.getConversation(conversationId),
        messages: stone.getMessages(conversationId),
      };
    },

    async stoneListConversations(limit = 50) {
      if (!stone) throw new Error('STONE is not enabled. Set STONE_ENABLED=true.');
      const convs = stone.listConversations(limit);
      return convs.map((c) => ({
        ...c,
        messageCount: stone.getMessageCount(c.id),
        totalTokens: stone.getTotalTokens(c.id),
      }));
    },

    async stoneGetNeighbors(conversationId: string, sequenceNumber: number, window = 2) {
      if (!stone) throw new Error('STONE is not enabled. Set STONE_ENABLED=true.');
      return stone.getNeighborMessages(conversationId, sequenceNumber, window, window);
    },

    // --- Temporal methods ---

    async temporalSearch(query: string, limit = 20) {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.searchEvents(query, limit);
    },

    async temporalRange(startDatetime: string, endDatetime: string, limit = 50) {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.getEventsInRange(startDatetime, endDatetime, limit);
    },

    async temporalBySubject(subject: string, limit = 20) {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.getEventsBySubject(subject, limit);
    },

    async temporalTimeline(limit = 100) {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.getTimeline(limit);
    },

    async temporalAddEvents(events: TemporalEvent[]) {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.addEvents(events);
    },

    async temporalEventCount() {
      if (!temporal) throw new Error('Temporal store not enabled. Set TEMPORAL_ENABLED=true.');
      return temporal.getEventCount();
    },
  };
}
