import { runAutopsy as executeAutopsy } from '../autopsy/index.js';
import { onByDefault } from '../config/flag-defaults.js';
import type { IMemoryRepository } from '../repository/interface.js';
import type { StoneStore, Conversation, ConversationMessage } from '../stone/index.js';
import { createReextractCallLLM } from '../stone/reextract-llm.js';
import type { TemporalStore, TemporalEvent } from '../temporal/index.js';
import type { Config } from '../config.js';
import type {
  MemoryRecord,
  AddMemoryResult,
  InjectionPayload,
  SystemStats,
  PartialInjectionConfig,
} from '../schema/memory.js';
import type { RetrievalResult } from '../retrieval/index.js';
import { AuditAction } from '../schema/audit.js';
import { TrustClass, ReviewStatus, isValidTransition } from '../schema/memory.js';
import { MemoryNotFoundError, CircuitBreakerActiveError, ValidationError } from '../errors.js';
import { createLogger } from '../config.js';
import { searchViaPlanOrLegacy } from '../retrieval/plan-shim.js';
import { addMemory as writeMemory } from '../write/index.js';
import { buildInjectionPayload, formatForContext } from '../inject/index.js';
import {
  resolveInjectionConfig,
  getDeploymentInjectionConfig,
  fetchInteractionPrefs,
  fetchContinuity,
} from '../inject/steering.js';
import { applyL3Defense } from '../security/read-defense/l3-scanner.js';
import { getInjectionMode } from '../retrieval/query-classifier.js';
import { formatEpisodesForInjection } from '../inject/episodes.js';
import { createReviewQueue } from '../learn/review-queue.js';
import { createDecayTracker } from '../learn/decay.js';
import { createCircuitBreaker } from '../learn/circuit-breaker.js';
import { runSelfPlay as executeSelfPlay } from '../learn/self-play.js';
import { warnShelvedFlagsEnabled } from '../shelved-features.js';
import { runInterferenceBatch as executeInterferenceBatch } from '../learn/interference-batch.js';
import { identifyHubCandidates, promoteToHub as executePromoteToHub } from '../learn/hub-computation.js';
import { flushShadowLog } from '../retrieval/thompson.js';
import { answerQuery, type AnswerResult, type AnswerOpts } from '../answer/answer.js';
import { extractClaims, defaultExtractionModel } from '../extract/index.js';
import { resolveTemporal, buildNormalization } from '../inject/temporal-parse-ir.js';
import { span } from '../telemetry/index.js';
import { materialize } from '../materializer/index.js';
import { calibratedTeacherAdjudicator } from '../materializer/adjudicators/calibrated-teacher.js';
import type { MaterializeOpts } from '../materializer/types.js';
import {
  loadWarmingConfig,
  warmIngestedWindow,
  startPeriodicWarming,
  type WindowCandidate,
  type WarmingDeps,
} from '../materializer/warming-policy.js';
import type { ExtractedClaim } from '../extract/index.js';
import { randomUUID } from 'node:crypto';

export type { AnswerResult, AnswerOpts } from '../answer/answer.js';

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
  /**
   * S51: Per-candidate rank score in `[0,1]`. Min-max normalization over
   * `raw.candidates[].finalScore` so the top hit is 1.0 and the bottom is 0.0
   * (or all 1.0 if scores are tied). Preserves rank order AND gap information.
   * Independent of `payload.memories[].score`, which remains the unbounded
   * `finalScore` for back-compat with existing inject/budget consumers.
   */
  rankedCandidates: Array<{ id: string; claim: string; score: number }>;
}

/**
 * S65 Phase 1B: options for `dispatch.ingest()`.
 *
 * `asserted_at` is the timestamp the content was generated. Required for
 * historical bench data (LOCOMO timestamps). Production users get `now()`
 * by default. `BENCH_SKIP_CIRCUIT_BREAKER=true` is required when ingesting
 * historical data to bypass the circuit-breaker freshness check.
 */
export interface IngestOpts {
  user_id?: string;
  conversation_id?: string;
  asserted_at?: string;
  speaker?: string;
  source?: 'user' | 'assistant' | 'system' | 'imported';
  extractionModel?: string;
  /**
   * S65 Phase 1B: use the multi-speaker extraction prompt for dialogues
   * between named human participants (e.g. LOCOMO Caroline ↔ Melanie). When
   * true, the extracted claim.subject becomes the speaker's name so claims
   * about each speaker cluster on retrieval. Default: false (single-user
   * prompt, suitable for assistant-style chat).
   */
  multiSpeaker?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * S65 Phase 1B: result from `dispatch.ingest()`.
 *
 * Per-claim outcomes are surfaced in `written[]` so callers can audit
 * which claims passed the trust pipeline. `errors[]` captures per-stage
 * failures (STONE write, extraction LLM, individual memory write) so
 * partial-success cases are observable. ingest() never throws on these
 * failures, empty IngestResult is the failure shape.
 */
export interface IngestResult {
  conversation_id: string;
  stone_message_id?: string;
  extracted_count: number;
  /** D1 (S72): how many extracted claims had relative temporal phrases mutated to canonical form. */
  temporal_resolved_count?: number;
  written: AddMemoryResult[];
  rejected_count: number;
  duration_ms: {
    stone_write: number;
    extraction: number;
    memory_writes: number;
    total: number;
    /** W3: time spent in materialize() (cache + extract + adjudicate). Present only when MATERIALIZER_ENABLED. */
    materialize?: number;
  };
  errors: Array<{
    stage: 'stone' | 'extraction' | 'write' | 'adjudication';
    error: string;
    claim_index?: number;
  }>;
}

export interface CoreDispatch {
  /**
   * Packet 0: every method that touches per-user memory data accepts an
   * optional `userId` (default `'system'`). Benchmarks and MCP callers
   * keep their existing call shape and run on the system partition.
   * REST routes always extract user_id from the request and pass it.
   */

  /**
   * Search memories and build injection context. Primary read path.
   *
   * S63 (B19-D): optional `nowIso` overrides the engine's "now" anchor for
   * bi-temporal filtering, RRF reference time, query-expansion's relative-date
   * normalization, freshness scoring, and reranker recency math. Used by
   * bench runners to set per-conversation wall-clock when seeding historical
   * transcripts; production callers (MCP / REST) leave it undefined to keep
   * server wall-clock behavior. Brain #2044.
   */
  search(
    query: string,
    limit?: number,
    conversationId?: string,
    userId?: string,
    nowIso?: string,
    injectionOverride?: PartialInjectionConfig,
  ): Promise<SearchResult>;

  /**
   * S51: First-class answer surface. Searches, calls the answer LLM, and
   * extracts a calibrated `confidence` in `[0,1]`. Returns the search result
   * alongside so callers can inspect retrieval. Used by calibration benches.
   */
  answer(query: string, opts?: AnswerOpts): Promise<AnswerResult>;

  /** Write a new memory through trust branching pipeline. user_id flows from input.user_id. */
  addMemory(input: unknown): Promise<AddMemoryResult>;
  setPreference(dimension: string, value: string, userId?: string): Promise<AddMemoryResult>;

  /**
   * S65 Phase 1B: end-to-end ingest. Accepts raw text (a chat session, a
   * message, an article), runs the engine's own extraction pipeline to
   * produce structured claims, and writes each claim through the same
   * trust pipeline `addMemory` uses. This is the public surface a real
   * user (e.g. MyKonos chat) goes through; benches now use it instead
   * of seeding pre-extracted facts directly.
   */
  ingest(rawText: string, opts?: IngestOpts): Promise<IngestResult>;

  /** Get a single memory by ID. */
  getMemory(id: string, userId?: string): Promise<MemoryRecord>;

  /** Confirm a memory (user override to confirmed trust class). */
  confirmMemory(id: string, reason?: string, userId?: string): Promise<void>;

  /** Reject a memory (user override to rejected). */
  rejectMemory(id: string, reason?: string, userId?: string): Promise<void>;

  /** Get pending review queue. */
  getPendingReviews(limit?: number, userId?: string): Promise<MemoryRecord[]>;

  /** System stats. Per-user counts. */
  getStats(userId?: string): Promise<SystemStats>;

  /** Full brain export (all memories as async iterable). */
  exportBrain(userId?: string): Promise<AsyncIterable<MemoryRecord>>;

  /** Cascade-delete all data for a single user (memories + audit + episodes + state_packs + summaries). */
  deleteUser(userId: string): Promise<{
    memories: number;
    audit: number;
    episodes: number;
    statePacks: number;
    summaries: number;
  }>;

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
  // S74 shelf guard: log ERROR if a shelved feature flag was enabled
  // without DEMIURGE_ALLOW_SHELVED_FEATURES=true override. Does not
  // throw: benches legitimately toggle these for measurement.
  warnShelvedFlagsEnabled();

  const reviewQueue = createReviewQueue(repo);
  const decayTracker = createDecayTracker(repo, {
    halfLifeDays: config.freshnessHalfLifeDays,
  });
  const circuitBreaker = createCircuitBreaker(repo, {
    lockAfterDays: config.inactivityLockDays,
  });

  // P1.1: build reextract callLLM once per dispatch (not per-request).
  // Returns null if OPENAI_API_KEY is unset; reextract then no-ops cleanly.
  const reextractCallLLM = createReextractCallLLM();

  // W4 Track D: cache-warming policy state. A bounded in-memory buffer of the
  // most-recently-touched materializer windows. Ingest populates it; the
  // periodic warming cycle ranks it (recency/frequency) and re-warms the top
  // windows. Kept in-memory on purpose: a warming heuristic does not need to
  // survive restarts, and this avoids reconstructing MaterializeOpts from the
  // lossy truncated cache_events key. The decay tracker exposes no window-level
  // access query, so this buffer is the cheap, accurate recency signal.
  const RECENT_WINDOWS_MAX = 100;
  const recentWindows = new Map<string, WindowCandidate>();
  function touchWindow(opts: MaterializeOpts, recentMiss = false): void {
    const key = `${opts.conversationId}:${opts.stoneWindow.seqStart}:${opts.stoneWindow.seqEnd}`;
    const now = Date.now();
    const existing = recentWindows.get(key);
    if (existing) {
      existing.lastTouchTs = now;
      existing.touchCount += 1;
      existing.opts = opts;
      if (recentMiss) existing.recentMiss = true;
      return;
    }
    recentWindows.set(key, { opts, lastTouchTs: now, touchCount: 1, ...(recentMiss ? { recentMiss: true } : {}) });
    // Bound the buffer: evict the least-recently-touched window when over cap.
    if (recentWindows.size > RECENT_WINDOWS_MAX) {
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [k, v] of recentWindows) {
        if (v.lastTouchTs < oldestTs) {
          oldestTs = v.lastTouchTs;
          oldestKey = k;
        }
      }
      if (oldestKey) recentWindows.delete(oldestKey);
    }
  }
  const warmingDeps: WarmingDeps = { gatherCandidates: () => [...recentWindows.values()] };
  let warmingTimer: ReturnType<typeof setInterval> | null = null;

  // S51: assign to a local so dispatch.answer() can pass the object back into
  // answerQuery() (which needs a SearchCapableDispatch). Keeps the existing
  // factory shape, no other consumer of `dispatch` notices.
  const dispatch: CoreDispatch = {
    async search(
      query: string,
      limit?: number,
      conversationId?: string,
      userId: string = 'system',
      nowIso?: string,
      injectionOverride?: PartialInjectionConfig,
    ): Promise<SearchResult> {
      // Deployment surface: resolve the effective injection config once
      // (deployment default merged with any per-request override). Used by both
      // the compression-router path and the main path below.
      const effectiveInjection = resolveInjectionConfig(getDeploymentInjectionConfig(), injectionOverride);
      // Circuit breaker gates the read path
      // --- S23: Compression router, skip retrieval for small conversations ---
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
            let directPayload = buildInjectionPayload(emptyResult, config.maxInjectedRules, nowIso, effectiveInjection);
            // W4 Track B L3: also hook the compression-router direct path. The
            // payload is empty here so applyL3Defense early-returns (no LLM
            // call); wired for completeness and parity with the main path.
            if (process.env.READ_INJECTION_DEFENSE_ENABLED === 'true') {
              directPayload = await applyL3Defense(directPayload);
            }
            return {
              payload: directPayload,
              contextText: routeResult.directContext,
              raw: emptyResult,
              rankedCandidates: [],
            };
          }
        } catch (err) {
          log.warn({ err }, 'Compression router failed, falling back to standard retrieval');
        }
      }

      // S50/S51: BENCH_SKIP_CIRCUIT_BREAKER bypass. Mirrors the BENCH_SKIP_DEDUP
      // guard in src/write/index.ts, production-blocked, dev-only. Required
      // both for security benches that hammer many adversarial seeds in tight
      // loops and for product/calibration benches that seed historical
      // timestamps (e.g. Wikidata stale-memory), either of which would
      // otherwise trip the inactivity lock mid-run.
      if (process.env.BENCH_SKIP_CIRCUIT_BREAKER === 'true' && process.env.NODE_ENV === 'production') {
        throw new ValidationError(
          'BENCH_SKIP_CIRCUIT_BREAKER cannot be enabled in production. Aborting to prevent security bypass.',
        );
      }
      const skipBreaker = process.env.BENCH_SKIP_CIRCUIT_BREAKER === 'true' && process.env.NODE_ENV !== 'production';
      if (!skipBreaker) {
        const locked = await circuitBreaker.isLocked();
        if (locked) {
          const lastActivity = await repo.getLastActivityTimestamp(userId);
          throw new CircuitBreakerActiveError(lastActivity ?? 'unknown');
        }
      } else if (process.env.BENCH_SKIP_CIRCUIT_BREAKER === 'true') {
        log.warn({}, 'CRITICAL: Circuit breaker bypassed via BENCH_SKIP_CIRCUIT_BREAKER');
      }

      // Wedge 1.5 Phase 2: span wraps the retrieval + injection pipeline.
      return span(
        'dispatch.search',
        async () => {
          const effectiveLimit = limit;

          // Retrieve candidates.
          // Wedge 2 (S74): route through the plan-executor shim. When
          // `planExecutorEnabled` is off, the shim calls retrieve() directly
          //, no behavioral change. When on, the shim plans the query and
          // executes the plan; queries the planner declines fall back to
          // retrieve(). The shim returns a RetrievalResult so the downstream
          // injection / episode / score-normalization pipeline runs unchanged.
          // P1.1: STONE store + reextractCallLLM are still passed through; the
          // legacy retrieve() consumes them. If stone is null or
          // reextractCallLLM is null (no OPENAI_API_KEY), the feature no-ops.
          const result = await searchViaPlanOrLegacy(repo, query, config, effectiveLimit, {
            stoneStore: stone ?? undefined,
            callLLM: reextractCallLLM ?? undefined,
            userId,
            nowIso,
          });

          // Record access for decay tracking (fire-and-forget)
          const ids = result.candidates.map((c) => c.id);
          if (ids.length > 0) {
            decayTracker.recordAccessBatch(ids).catch((err) => log.error({ err }, 'Decay batch update failed'));
          }

          // Build injection payload.
          // Packet A H3: forward the per-question `nowIso` into the payload so
          // metadata.nowIso is the question's reference date (the LME runner's
          // convNowIso = max session date), not the engineNow() global pin /
          // wall-clock. formatForContext sources the CURRENT DATE header from it.
          // L3 steering: fetch the user's current interaction preferences and
          // continuity (recent focus and corrections) and pass them into the
          // payload. They do not match the query, so they are fetched
          // separately, gated by the default injection profile.
          const interactionPrefs = effectiveInjection.steering.interactionPrefs
            ? await fetchInteractionPrefs(repo, userId)
            : [];
          const continuity = effectiveInjection.steering.continuity ? await fetchContinuity(repo, userId) : {};
          let payload = buildInjectionPayload(
            result,
            config.maxInjectedRules,
            nowIso,
            effectiveInjection,
            interactionPrefs,
            continuity,
          );
          // W4 Track B L3: payload-level injection scan (async). Flag off =>
          // never called: zero added latency, zero LLM cost. Fails open.
          if (process.env.READ_INJECTION_DEFENSE_ENABLED === 'true') {
            payload = await applyL3Defense(payload);
          }
          let contextText = formatForContext(payload, effectiveInjection.format);

          // R11: Episode injection (injection-only, no retrieval interference)
          // Episodes are searched and formatted here in dispatch, NOT in retrieval.
          // This ensures zero impact on the fact candidate pool.
          if (onByDefault(process.env.EPISODES_ENABLED) && result.metadata.queryEmbedding) {
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
          if (
            temporal &&
            (result.metadata.queryType === 'temporal' || result.metadata.queryType === 'temporal-multi-hop')
          ) {
            try {
              const temporalEvents = temporal.searchEvents(query, 10);
              if (temporalEvents.length > 0) {
                const timelineText = temporalEvents
                  .filter((e) => e.eventDatetime)
                  .sort((a, b) => (a.eventDatetime || '').localeCompare(b.eventDatetime || ''))
                  .map((e) => `[${e.eventDatetime}] ${e.subject} ${e.verb}${e.object ? ' ' + e.object : ''}`)
                  .join('\n');
                if (timelineText) {
                  contextText = `TEMPORAL EVENTS (structured timeline):\n${timelineText}\n\n${contextText}`;
                }
              }
            } catch (err) {
              log.warn({ err }, 'Temporal event injection failed (non-critical)');
            }
          }

          // STONE_NEIGHBOR_EXPANSION killed S24 (brain #1499).

          // S27 specialist pipeline removed S65, never validated, 2,435 LOC of
          // dead code. Tried multiple times, gave up. SPECIALIST_ROUTING env var
          // ignored; src/specialist/ directory deleted.

          // S51: min-max normalize finalScore over the candidate set so the top
          // hit is 1.0 and the bottom is 0.0 (or all 1.0 on ties). Preserves rank
          // AND gap information. Independent of payload.memories[].score, which
          // remains the unbounded finalScore for back-compat with inject/budget.
          const rankedCandidates: Array<{ id: string; claim: string; score: number }> = (() => {
            const cands = result.candidates;
            if (cands.length === 0) return [];
            let min = Infinity;
            let max = -Infinity;
            for (const c of cands) {
              if (c.finalScore < min) min = c.finalScore;
              if (c.finalScore > max) max = c.finalScore;
            }
            const range = max - min;
            return cands.map((c) => ({
              id: c.id,
              claim: c.candidate.record.claim,
              score: range === 0 ? 1.0 : (c.finalScore - min) / range,
            }));
          })();

          return { payload, contextText, raw: result, rankedCandidates };
        },
        { query_len: query.length },
      );
    },

    async answer(query: string, opts?: AnswerOpts): Promise<AnswerResult> {
      // S51: implementation lives in src/answer/answer.ts so it can be called
      // by the calibration benches directly (without going through dispatch).
      // We pass the captured `dispatch` reference so the orchestrator can
      // re-enter dispatch.search() with the same circuit-breaker / decay /
      // payload-build pipeline the rest of the read path uses.
      return span('dispatch.answer', async () => answerQuery(dispatch, query, opts), {
        query_len: query.length,
      });
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

    async setPreference(dimension: string, value: string, userId?: string): Promise<AddMemoryResult> {
      // L3 explicit capture (S80). Store an interaction preference as a memory:
      // subject is the dimension (verbosity, tone, ...), claim is the terse
      // value. The cardinality gate treats these dimensions as single-valued
      // and validFrom anchors the new value as newer, so it supersedes the old
      // one rather than landing as an unresolved conflict. Keep values terse
      // (1-2 words) so the claim-similarity leniency links old and new. The
      // steering layer (P3) reads these back via getBySubject.
      return writeMemory(
        {
          subject: dimension,
          claim: value,
          scope: 'global',
          source: 'user',
          validFrom: new Date().toISOString(),
          user_id: userId,
        },
        repo,
        config,
      );
    },

    async ingest(rawText: string, opts: IngestOpts = {}): Promise<IngestResult> {
      return span(
        'dispatch.ingest',
        async () => {
          const t0 = Date.now();
          const errors: IngestResult['errors'] = [];
          const conversation_id = opts.conversation_id ?? `ingest-${randomUUID()}`;
          const asserted_at = opts.asserted_at ?? new Date().toISOString();
          const role: 'user' | 'assistant' | 'system' =
            opts.source === 'assistant' ? 'assistant' : opts.source === 'system' ? 'system' : 'user';

          // [1] STONE write, best-effort. Skipped silently if STONE not wired.
          let stone_message_id: string | undefined;
          let stone_seq: number | undefined;
          const stoneStart = Date.now();
          if (stone) {
            try {
              // Ensure conversation exists (idempotent)
              if (!stone.getConversation(conversation_id)) {
                const conv: Conversation = {
                  id: conversation_id,
                  source: (opts.metadata?.bench_source as string | undefined) ?? 'ingest',
                  startedAt: asserted_at,
                  participantId: opts.user_id,
                  metadata: opts.metadata,
                };
                stone.createConversation(conv);
              }
              const seq = stone.getMessageCount(conversation_id) + 1;
              const msg: ConversationMessage = {
                id: randomUUID(),
                conversationId: conversation_id,
                role,
                content: rawText,
                sequenceNumber: seq,
                timestamp: asserted_at,
                metadata: opts.speaker ? { speaker: opts.speaker } : undefined,
              };
              stone.appendMessage(msg);
              stone_message_id = msg.id;
              stone_seq = seq;
            } catch (err) {
              errors.push({ stage: 'stone', error: err instanceof Error ? err.message : String(err) });
            }
          }
          const stone_write_ms = Date.now() - stoneStart;

          // [2] Extraction (or Materialization, behind MATERIALIZER_ENABLED).
          //
          // Flag-OFF path: direct extractClaims(), unchanged from S65 Phase 1B.
          // Flag-ON path: route through materialize() which caches the projection
          // keyed by (stone_window, policy_id, asof_minute). Requires the STONE
          // write above to have produced a sequence number; if STONE wasn't
          // wired we silently fall back to the legacy path so the flag doesn't
          // break degraded-mode ingest.
          const extractStart = Date.now();
          const extractionModel = opts.extractionModel ?? defaultExtractionModel();
          let claims: ExtractedClaim[] = [];
          let materialize_ms: number | undefined;
          // W4 Track D: the just-ingested window to warm (set only on the
          // materializer path with the warming policy on); consumed after the
          // ingest result is ready, fire-and-forget.
          let warmTarget: MaterializeOpts | undefined;
          const useMaterializer = process.env.MATERIALIZER_ENABLED === 'true' && stone_seq !== undefined;
          if (useMaterializer) {
            const matStart = Date.now();
            try {
              const policyId = opts.multiSpeaker ? 'default-multispeaker' : 'default';
              // W4 Track A: select calibrated teacher when the flag is on,
              // otherwise fall through to the W3 detectInjection default
              // bound inside materialize(). Same hook contract; pure swap.
              const useCalibrated = process.env.CALIBRATED_ADJUDICATOR_ENABLED === 'true';
              const materializeOpts: MaterializeOpts = {
                asOf: asserted_at,
                conversationId: conversation_id,
                stoneWindow: { seqStart: stone_seq as number, seqEnd: stone_seq as number },
                policyId,
                userId: opts.user_id,
                ...(useCalibrated ? { pre_adjudicate: calibratedTeacherAdjudicator } : {}),
              };
              // W4 Track D: register the window with the warming policy (recency
              // buffer for the periodic cycle + warm target for the on-ingest
              // hook). Gated by WARMING_POLICY_ENABLED so it is a strict no-op
              // when warming is off.
              if (process.env.WARMING_POLICY_ENABLED === 'true') {
                touchWindow(materializeOpts);
                warmTarget = materializeOpts;
              }
              const projection = await materialize(materializeOpts);
              materialize_ms = Date.now() - matStart;
              if (projection.adjudication.decision === 'reject') {
                errors.push({
                  stage: 'adjudication',
                  error: projection.adjudication.reason_codes.join(',') || 'rejected',
                });
                claims = [];
              } else {
                claims = projection.assertions;
              }
            } catch (err) {
              errors.push({ stage: 'extraction', error: err instanceof Error ? err.message : String(err) });
              materialize_ms = Date.now() - matStart;
            }
          } else {
            try {
              claims = await extractClaims(rawText, {
                // Pin the extraction model ONLY when explicitly requested: programmatic
                // opts.extractionModel, or the EXTRACTION_MODEL bench env. The default
                // product path passes no model, so extractClaims uses the failover chain
                // (head gpt-4.1-nano) instead of one pinned model with no failover. This
                // prevents silent fact loss when the primary provider is down, while bench
                // pinning (EXTRACTION_MODEL set) stays single-model for sweep validity.
                ...(opts.extractionModel || process.env.EXTRACTION_MODEL ? { model: extractionModel } : {}),
                multiSpeaker: opts.multiSpeaker,
                assertedAt: asserted_at,
              });
            } catch (err) {
              errors.push({ stage: 'extraction', error: err instanceof Error ? err.message : String(err) });
            }
          }
          const extraction_ms = Date.now() - extractStart;

          // [3] Per-claim memory write
          // D1 + A7 (S72): run temporal resolver on each claim before write.
          // High-confidence relative phrases (yesterday, last week, etc.) get
          // canonicalized against asserted_at; the original text is preserved in
          // raw_claim and the audit JSON in normalization. Low-confidence matches
          // log telemetry only (calibrator pickup is Wedge 4).
          const writesStart = Date.now();
          const written: AddMemoryResult[] = [];
          const touchedSubjects = new Set<string>();
          let rejected_count = 0;
          let temporal_resolved_count = 0;
          for (let i = 0; i < claims.length; i++) {
            const c = claims[i];
            if (!c) continue;
            const resolution = resolveTemporal(c.claim, asserted_at);
            let writeClaim = c.claim;
            let writeRawClaim: string | undefined;
            let writeNormalization: string | undefined;
            if (resolution.ok && resolution.atom) {
              writeClaim = resolution.claim;
              writeRawClaim = resolution.rawClaim;
              writeNormalization = buildNormalization(resolution.atom);
              temporal_resolved_count++;
            } else if (resolution.unresolved.length > 0) {
              log.info(
                {
                  conversation_id,
                  claim_index: i,
                  unresolved: resolution.unresolved,
                  reason: resolution.reason,
                },
                'temporal-parse-ir: unresolved phrases',
              );
            }
            try {
              const result = await dispatch.addMemory({
                user_id: opts.user_id,
                claim: writeClaim,
                subject: c.subject,
                // S65 council reconciliation: extracted-from-imported-text claims
                // are NOT user-asserted. They go through the LLM-source trust path
                // (consensus on conflict, quarantine on low confidence) instead of
                // being auto-confirmed at USER trust. Bench seeds and product writes
                // alike route through this path.
                source: opts.source === 'imported' ? 'llm' : (opts.source ?? 'llm'),
                confidence: 0.7,
                validFrom: asserted_at,
                rawClaim: writeRawClaim,
                normalization: writeNormalization,
              });
              written.push(result);
              if (result.action === 'rejected') rejected_count++;
              else touchedSubjects.add(c.subject);
            } catch (err) {
              errors.push({
                stage: 'write',
                error: err instanceof Error ? err.message : String(err),
                claim_index: i,
              });
            }
          }
          const memory_writes_ms = Date.now() - writesStart;

          const total_ms = Date.now() - t0;

          log.info(
            {
              conversation_id,
              extracted_count: claims.length,
              written_count: written.length,
              rejected_count,
              errors_count: errors.length,
              extractionModel,
              total_ms,
            },
            'Ingest complete',
          );

          // W4 Track D: warm the just-ingested window. Fire-and-forget (no
          // await) so ingest returns immediately; mirrors the fire-and-forget
          // decayTracker.recordAccessBatch pattern. warmIngestedWindow
          // self-gates (double-gate + trigger), so this is inert when warming
          // is off or in periodic-only mode.
          if (warmTarget) {
            warmIngestedWindow(warmTarget).catch((err) => log.error({ err }, 'Warming (on-ingest) failed'));
          }

          // S79 fix #2: materialize episodes for the subjects this ingest
          // touched, over all their facts. Synchronous (awaited) so callers and
          // the bench observe the episodes before querying. Self-gates on
          // EPISODES_ENABLED. apiKey matches what the benches pass to
          // runPostSeedHooks so prod and bench build episodes identically.
          if (touchedSubjects.size > 0) {
            try {
              await repo.buildEpisodesForSubjects(
                [...touchedSubjects],
                process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || undefined,
                opts.user_id ?? 'system',
              );
            } catch (err) {
              log.error({ err }, 'Episode build (on-ingest) failed');
            }
          }

          return {
            conversation_id,
            stone_message_id,
            extracted_count: claims.length,
            temporal_resolved_count,
            written,
            rejected_count,
            duration_ms: {
              stone_write: stone_write_ms,
              extraction: extraction_ms,
              memory_writes: memory_writes_ms,
              total: total_ms,
              ...(materialize_ms !== undefined ? { materialize: materialize_ms } : {}),
            },
            errors,
          };
        },
        { text_len: rawText.length },
      );
    },

    async getMemory(id: string, userId: string = 'system'): Promise<MemoryRecord> {
      const record = await repo.getById(id, userId);
      if (!record) throw new MemoryNotFoundError(id);
      return record;
    },

    async confirmMemory(id: string, reason?: string, userId: string = 'system'): Promise<void> {
      const memory = await repo.getById(id, userId);
      if (!memory) throw new MemoryNotFoundError(id);

      if (!isValidTransition(memory.trustClass, TrustClass.CONFIRMED)) {
        throw new ValidationError(`Cannot transition from ${memory.trustClass} to confirmed`);
      }

      await repo.update(
        id,
        {
          trustClass: TrustClass.CONFIRMED,
          reviewStatus: ReviewStatus.APPROVED,
          updatedAt: new Date().toISOString(),
        },
        userId,
      );

      await repo.appendAuditLog(
        {
          memoryId: id,
          action: AuditAction.CONFIRMED,
          details: reason ?? null,
        },
        userId,
      );

      await circuitBreaker.recordActivity();
      log.info(`Memory confirmed: ${id}`);
    },

    async rejectMemory(id: string, reason?: string, userId: string = 'system'): Promise<void> {
      const memory = await repo.getById(id, userId);
      if (!memory) throw new MemoryNotFoundError(id);

      if (!isValidTransition(memory.trustClass, TrustClass.REJECTED)) {
        throw new ValidationError(`Cannot transition from ${memory.trustClass} to rejected`);
      }

      await repo.update(
        id,
        {
          trustClass: TrustClass.REJECTED,
          reviewStatus: ReviewStatus.REJECTED,
          updatedAt: new Date().toISOString(),
        },
        userId,
      );

      await repo.appendAuditLog(
        {
          memoryId: id,
          action: AuditAction.REJECTED,
          details: reason ?? null,
        },
        userId,
      );

      log.info(`Memory rejected: ${id}${reason ? ` (${reason})` : ''}`);
    },

    async getPendingReviews(limit?: number, userId: string = 'system'): Promise<MemoryRecord[]> {
      return reviewQueue.getPending(limit, userId);
    },

    async getStats(userId: string = 'system'): Promise<SystemStats> {
      const repoStats = await repo.getStats(userId);
      const locked = await circuitBreaker.isLocked();
      const lastActivity = await repo.getLastActivityTimestamp(userId);

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

    async exportBrain(userId: string = 'system'): Promise<AsyncIterable<MemoryRecord>> {
      await repo.appendAuditLog(
        {
          memoryId: null,
          action: AuditAction.EXPORT,
          details: null,
        },
        userId,
      );

      return repo.exportAll(userId);
    },

    async deleteUser(userId: string) {
      // Account-deletion cascade. The route layer enforces 403 for 'system';
      // this is a defense-in-depth check.
      if (userId === 'system') {
        throw new ValidationError('Cannot delete system user');
      }
      const counts = await repo.deleteUserCascade(userId);
      log.info({ userId, ...counts }, 'User cascade-deleted');
      return counts;
    },

    async shutdown(): Promise<void> {
      log.info('Dispatch shutdown initiated');
      // W4 Track D: stop the periodic warming timer (no leaked handle).
      if (warmingTimer) {
        clearInterval(warmingTimer);
        warmingTimer = null;
      }
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

  // W4 Track D: start the periodic warming cycle when both gates are open and
  // the trigger includes periodic. Returns null (no timer) otherwise, e.g. the
  // default on-ingest-only mode. The handle is unref'd and cleared on shutdown.
  warmingTimer = startPeriodicWarming(warmingDeps, loadWarmingConfig());

  return dispatch;
}
