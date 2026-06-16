import { dedupInjectionSet } from './dedup-injection.js';
import { onByDefault } from '../config/flag-defaults.js';
import { bridgeAllEnabled } from './bridge-policy.js';
import type { IMemoryRepository } from '../repository/interface.js';
import type { Config } from '../config.js';
import { createLogger } from '../config.js';
import { searchLexical } from './lexical.js';
import { searchVector } from './vector.js';
import {
  mergeCandidates,
  filterInjectable,
  applyInhibition,
  rankCandidates,
  adaptWeights,
  weightsForQueryType,
  additiveFusionScore,
  normalizeBm25,
  type FinalScoredCandidate,
  type ScoringWeights,
} from './scorer.js';
import { computeEntityBoosts, extractQueryEntities } from './entity-boost.js';
import type { ScoredCandidate } from '../schema/memory.js';
import type Database from 'better-sqlite3-multiple-ciphers';
import { logShadowComparison } from './thompson.js';
import { applyCascade } from './hub-cascade.js';
import { expandEntityQuery } from './entity-expansion.js';
import { entitySplitRetrieval } from './entity-split.js';
import { classifyQuery, detectCountCategory, type QueryType } from './query-classifier.js';
import { rerank } from './reranker.js';
import { rewriteQuery, queryRewriteEnabled } from './query-rewrite.js';
import { recordRetrieval } from '../telemetry/index.js';
import type { MemoryPacket } from '../plan/types.js';
// Wave 2 E-salvage will wire searchTemporalRange + extractDateBounds back
// into the hot path under a single-flag eval. Do not delete.
import { searchTemporalRange as _searchTemporalRangeReserved } from './temporal-range.js';
import { extractDateBounds as _extractDateBoundsReserved } from './query-temporal.js';
void _searchTemporalRangeReserved;
void _extractDateBoundsReserved;
import { encode, isInitialized } from '../embeddings/index.js';
import { shouldReextract, executeReextraction } from '../stone/reextract.js';
import type { StoneStore } from '../stone/index.js';
import { fetchPersonaCandidates } from './persona-boost.js';
import { engineNow } from './engine-now.js';
const log = createLogger('retrieval');

export interface RetrievalResult {
  candidates: FinalScoredCandidate[];
  reextractedFacts?: Array<{ subject: string; claim: string }>;
  metadata: {
    query: string;
    queryType: QueryType;
    queryEmbedding: number[] | null;
    reextractNeeded?: boolean;
    reextractedCount?: number;
    candidatesGenerated: number;
    candidatesAfterFilter: number;
    candidatesReturned: number;
    timings: {
      lexicalMs: number;
      vectorMs: number;
      mergeAndScoreMs: number;
      totalMs: number;
    };
    // Hybrid fusion diagnostics (omitted on SQL-first fast path).
    // Packet 1 (linear) emits weightProfile; Packet A (additive) emits entityBoostHits/biTemporalFiltered.
    fusionMode?: 'linear' | 'additive' | 'disabled';
    weightProfile?: { lexicalWeight: number; vectorWeight: number };
    entityBoostHits?: number;
    biTemporalFiltered?: number;
    /**
     * B1a: id of the retrievals row written for this call. Threaded into
     * the InjectionEvent on the inject side so the analyzer can join the
     * pair. Undefined when telemetry is disabled.
     */
    retrievalId?: string;
    // Wedge 2 (S74): present when the plan executor produced this result.
    // Legacy retrieve() leaves it undefined; the shim adapts MemoryPacket
    // into candidates + sets this for callers (Wedge 3+) that want native access.
    planExecutorUsed?: boolean;
    /**
     * P3 (S74 wedge-2-planner-fix): true when the plan executor accepted
     * but returned zero facts AND zero refusals, and the shim fell back
     * to legacy retrieve() for the actual result. The empty-plan event
     * is still recorded in telemetry for Wedge 4 calibrator. Only
     * the user-visible result was swapped to legacy.
     *
     * Bench harnesses + integration tests use this to assert the fallback
     * path fired without parsing log lines.
     */
    planExecutorFellBack?: boolean;
  };
  // Wedge 2 (S74): full MemoryPacket attached when the plan executor ran.
  // Wedges 3 (Materializer) and 5 (STONE-as-Source) consume this directly.
  // Always undefined on the legacy path; never load-bearing for legacy callers.
  memoryPacket?: MemoryPacket;
}

/**
 * Packet A: rank using Mem0 additive fusion (mem0/utils/scoring.py).
 * Replaces the weighted-sum scoring path when hybridFusionMode='additive'.
 * Other scoring components (provenance, freshness, confirmedBonus, contradictionPenalty)
 * are not applied in this mode, additive fusion is intentionally signal-only.
 */
function rankAdditive(
  candidates: ScoredCandidate[],
  query: string,
  entityBoosts: Map<string, number>,
  entityBoostWeight: number,
  limit: number,
): FinalScoredCandidate[] {
  const scored: FinalScoredCandidate[] = candidates.map((c) => {
    const hasBm25 = c.lexicalScore > 0;
    const hasEntityBoost = (entityBoosts.get(c.id) ?? 0) > 0;
    const semanticScore = Math.min(Math.max(c.vectorScore, 0), 1);
    const bm25Score = hasBm25 ? normalizeBm25(c.lexicalScore, query) : 0;
    const entityBoost = entityBoosts.get(c.id) ?? 0;
    const finalScore = additiveFusionScore({
      semanticScore,
      bm25Score,
      entityBoost,
      hasBm25,
      hasEntityBoost,
      entityBoostWeight,
    });
    return {
      id: c.id,
      candidate: c,
      finalScore,
      scoreBreakdown: {
        lexicalComponent: bm25Score,
        vectorComponent: semanticScore,
        provenanceComponent: 0,
        freshnessComponent: 0,
        confirmedBonus: 0,
        contradictionPenalty: 0,
      },
    };
  });
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, Math.max(0, limit));
}

/**
 * Packet A: bi-temporal post-filter. Drops candidates whose `invalid_at` is set
 * and earlier than nowIso. Returns the set of memory IDs to drop (so caller
 * can compute the count for telemetry).
 */
function getInvalidatedIds(db: Database.Database, candidateIds: string[], nowIso: string): Set<string> {
  if (candidateIds.length === 0) return new Set();
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id FROM memories
       WHERE id IN (${placeholders})
         AND invalid_at IS NOT NULL
         AND invalid_at <= ?`,
    )
    .all(...candidateIds, nowIso) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function weightsFromConfig(config: Config): ScoringWeights {
  return {
    lexicalWeight: config.lexicalWeight,
    vectorWeight: config.vectorWeight,
    provenanceWeight: config.provenanceWeight,
    freshnessWeight: config.freshnessWeight,
    confirmedBonus: config.confirmedBonus,
    contradictionPenaltyBase: config.contradictionPenaltyBase,
    contradictionPenaltyMax: config.contradictionPenaltyMax,
    freshnessHalfLifeDays: config.freshnessHalfLifeDays,
  };
}

/**
 * S67 Plan 2.5b: subject-grouped freshest-fact filter for current-state queries.
 *
 * Problem this fixes: when the user updates a fact (e.g. "cocktail-making class
 * on Thursday" → later "on Fridays"), both versions land in the memory store
 * with the same subject. Bi-temporal supersession at WRITE time should set
 * invalid_at on the older row, but only fires when:
 *   - findConflicts detects them as related (subject match + claim similarity)
 *   - both writes have explicit validFrom anchors
 *   - the temporal ordering is detectable
 *
 * In practice, knowledge-update questions on LME show retrieval surfacing both
 * the old and new fact, with the answer model picking the older one because it
 * scores higher on lexical match.
 *
 * Plan 2.5b's retrieval-side fix: for current-state queries, when multiple
 * candidates share the same subject, keep only the one with the latest
 * validFrom (falling back to validAt, then createdAt). Doesn't require any
 * write-side change. The retrieval signal stays, the user is asking about
 * the present, so the present-state fact wins.
 *
 * Constraints:
 *   - Only fires for current-state queryType. Other queries (temporal,
 *     historical, multi-hop, narrative) want all subject-versions visible.
 *   - Subject must be non-empty and not start with 'hub:'. Hubs are
 *     deliberately many-to-many.
 *   - Tie-break: identical timestamps fall through to ranking order.
 *
 * S69: hardcoded ON. Plan 2.5b is the production path; code default and bench
 * profiles already ran it on.
 */
function freshestBySubjectFilter(candidates: ScoredCandidate[]): ScoredCandidate[] {
  // S69 Wave 1 revised: env-overridable. Default off (locked from S69 matrix:
  // Plan 2.5b regresses LOCOMO -5.7pp on current-state queries despite +8pp
  // LME lift; the regression is the dominant net signal). Brain #2205.
  const fbsFlag = (process.env.RETRIEVAL_FRESHEST_BY_SUBJECT ?? 'off').toLowerCase();
  if (fbsFlag !== 'on' && fbsFlag !== 'true' && fbsFlag !== '1') return candidates;
  if (candidates.length === 0) return candidates;

  // Group by subject. Track best (freshest) candidate per subject.
  const bestBySubject = new Map<string, { cand: ScoredCandidate; ts: number }>();
  const passthrough: ScoredCandidate[] = [];

  for (const c of candidates) {
    const subj = c.record.subject;
    if (!subj || subj.startsWith('hub:')) {
      passthrough.push(c);
      continue;
    }
    const ts = Date.parse(c.record.validFrom ?? c.record.validAt ?? c.record.createdAt) || 0;
    const subjectKey = subj.toLowerCase();
    const prior = bestBySubject.get(subjectKey);
    if (!prior || ts > prior.ts) {
      bestBySubject.set(subjectKey, { cand: c, ts });
    }
  }

  const survivors = Array.from(bestBySubject.values()).map((v) => v.cand);
  return [...passthrough, ...survivors];
}

export async function retrieve(
  repo: IMemoryRepository,
  query: string,
  config: Config,
  limit?: number,
  deps?: {
    stoneStore?: StoneStore;
    callLLM?: (prompt: string) => Promise<string>;
    /** Packet 0: per-tenant scoping. Defaults to 'system' for benchmarks/MCP. */
    userId?: string;
    /**
     * S63 (B19-D): caller-supplied "now" timestamp in ISO 8601. When set,
     * overrides `new Date().toISOString()` for bi-temporal filtering, RRF
     * reference time, query-expansion's relative-date normalization,
     * freshness scoring, and reranker recency math. Used by bench runners
     * to anchor relative-date reasoning to the conversation's wall-clock
     * instead of the server's. Production callers (MCP / REST) leave this
     * undefined to keep current behavior. Brain #2044.
     */
    nowIso?: string;
  },
): Promise<RetrievalResult> {
  const userId = deps?.userId ?? 'system';
  const nowOverride = deps?.nowIso;
  const maxResults = limit ?? config.maxInjectedRules;
  const totalStart = performance.now();

  const queryType = classifyQuery(query);

  const baseWeights = weightsFromConfig(config);
  const profiledWeights = weightsForQueryType(baseWeights, queryType, config.hybridFusionMode);
  const candidateLimit = Math.max(maxResults * config.candidateOverfetchMultiplier, 30);

  // Packet A: bi-temporal cutoff (Graphiti pattern). When enabled, retrieval drops
  // facts whose invalid_at <= nowIso. undefined = no filter (legacy behavior).
  // Packet C3 / Bug 1: when biTemporalIntentAware is on (default true), only
  // current-state queries get the filter, historical/list/temporal queries
  // need superseded facts retrievable. This fixes Bench 1 historical/list
  // dropping to 0% under BI_TEMPORAL_ENABLED=true.
  const intentAwareFilter = config.biTemporalIntentAware !== false;
  const applyBiTemporalFilter =
    config.biTemporalEnabled &&
    (!intentAwareFilter ||
      !['temporal', 'temporal-multi-hop', 'coverage', 'synthesis', 'narrative'].includes(queryType));
  const nowIso = applyBiTemporalFilter ? (nowOverride ?? engineNow()) : undefined;

  // --- A4: multi-hop query rewrite (flag-gated, off by default) ---
  // For multi-hop / temporal-multi-hop queries, ask the LLM for 2
  // paraphrased variants and run lexical search against each. Vector
  // stays on the original, embedding paraphrases mostly re-fetches the
  // same chunks at slightly different scores; the lift is for BM25 to
  // reach facts whose phrasing differs from the original wording.
  // mergeCandidates dedupes by id, so any chunk found by multiple
  // variants only enters the pool once.
  const lexicalQueries: string[] =
    queryRewriteEnabled() && (queryType === 'multi-hop' || queryType === 'temporal-multi-hop')
      ? await rewriteQuery(query)
      : [query];

  // --- Lexical search ---
  const lexStart = performance.now();
  const lexicalCandidates =
    lexicalQueries.length <= 1
      ? await searchLexical(repo, query, candidateLimit, userId, nowIso)
      : await Promise.all(lexicalQueries.map((q) => searchLexical(repo, q, candidateLimit, userId, nowIso))).then(
          (arrays) => arrays.reduce((acc, arr) => mergeCandidates(acc, arr), [] as (typeof arrays)[number]),
        );
  const lexicalMs = performance.now() - lexStart;

  // --- Vector search ---
  const vecStart = performance.now();
  const vectorCandidates = await searchVector(repo, query, candidateLimit, userId, nowIso);
  const vectorMs = performance.now() - vecStart;

  // S63 (B19-D): override always wins, even when bi-temporal filter is off.
  // Recency math anchors to the conversation's notion of "now", not the
  // server's wall-clock.
  const rrfRefIso = nowOverride ?? nowIso ?? engineNow();

  // --- Compute query embedding for injection features ---
  let queryEmbedding: number[] | null = null;
  if (isInitialized()) {
    try {
      queryEmbedding = await encode('Represent this sentence for searching relevant passages: ' + query);
    } catch {
      // Non-critical: embedding for injection features, not retrieval
    }
  }

  // --- Entity-split retrieval for multi-hop queries ---
  const entitySplitCandidates: typeof vectorCandidates = [];
  // S65: entity-split also fires on temporal-multi-hop. Compound type was
  // designed to keep multi-hop bridge retrieval AND timeline; entity-split is
  // half of multi-hop's recall lift and was missing for the compound type.
  //
  // Classifier-collapse (S77): RETRIEVAL_BRIDGE_ALL (default OFF, on only when
  // `=== 'true'`) extends the bridge / deeper candidate set to ALL conversational
  // queryTypes, not just multi-hop / temporal-multi-hop. Default off so
  // production is unchanged; the bench host A/Bs it.
  if (
    queryType === 'multi-hop' ||
    queryType === 'temporal-multi-hop' ||
    (queryType === 'temporal' && onByDefault(process.env.ENTITY_SPLIT_TEMPORAL)) ||
    bridgeAllEnabled(queryType)
  ) {
    const splitResults = await entitySplitRetrieval(repo, query, candidateLimit, nowIso);
    entitySplitCandidates.push(...splitResults);
  }

  // --- Category-coverage channel for count/aggregation questions (S79 #12) ---
  // Count questions ("how many / how much / total ...") under-retrieve: vector
  // top-K surfaces only a subset of a category's instances, so the answer
  // undercounts. One FTS pass on just the counted category term surfaces all
  // matching instances (typed and fallback rows), capped by candidateLimit so
  // it stays category-relevant and does NOT recreate the killed brute-force
  // drown (that dumped ALL subject facts; this returns only term matches).
  // Flag-gated, default off.
  const categoryCandidates: typeof vectorCandidates = [];
  if (process.env.COUNT_COVERAGE_ENABLED === 'true') {
    const countCategory = detectCountCategory(query);
    if (countCategory) {
      const catResults = await searchLexical(repo, countCategory, candidateLimit, userId, nowIso);
      categoryCandidates.push(...catResults);
    }
  }

  // --- Merge all fact candidates ---
  const scoreStart = performance.now();
  let merged = (() => {
    let m = mergeCandidates(lexicalCandidates, vectorCandidates);
    if (entitySplitCandidates.length > 0) m = mergeCandidates(m, entitySplitCandidates);
    if (categoryCandidates.length > 0) m = mergeCandidates(m, categoryCandidates);
    return m;
  })();

  // Packet C3 / Bug 3: persona boost. When the flag is on, all persona-tagged
  // memories for the user are unioned into the candidate pool with a fixed
  // lexical-score boost so they survive merging and ranking. Cheap: single
  // indexed query on (user_id, persona). See src/retrieval/persona-boost.ts.
  if (config.personaBoostEnabled) {
    const personaCands = await fetchPersonaCandidates(repo, userId);
    if (personaCands.length > 0) merged = mergeCandidates(merged, personaCands);
  }

  const injectable = filterInjectable(merged);
  const expanded = await expandEntityQuery(repo, query, injectable, candidateLimit, nowIso);
  const withExpanded = expanded.length > 0 ? mergeCandidates(injectable, filterInjectable(expanded)) : injectable;

  const inhibitions = await repo.getActiveInhibitions();
  const afterInhibition = applyInhibition(
    withExpanded,
    inhibitions.map((m) => ({
      inhibitionTarget: m.inhibitionTarget ?? '',
      confidence: m.confidence,
    })),
  );

  // --- Scoring (weighted mode by default; additive fusion when Packet A flag on) ---
  const rerankerEnabled = process.env.RERANKER_ENABLED === 'true';
  const rankLimit = rerankerEnabled ? Math.min(maxResults * 3, afterInhibition.length) : maxResults;

  // Packet A: bi-temporal post-filter. Drops candidates whose invalid_at is set and ≤ now.
  // Packet C3 / Bug 1: gate the post-filter on intent the same way the SQL-layer
  // filter is gated (above). Otherwise current-state queries still pay for the
  // filter but historical/list queries don't, which would surface the bug at a
  // different layer.
  let biTemporalFiltered = 0;
  let biTemporalCandidates = afterInhibition;
  if (applyBiTemporalFilter) {
    const dbAccessor = (repo as { getDatabase?: () => Database.Database }).getDatabase;
    if (dbAccessor) {
      const db = dbAccessor.call(repo);
      const invalidated = getInvalidatedIds(
        db,
        afterInhibition.map((c) => c.id),
        nowOverride ?? engineNow(),
      );
      if (invalidated.size > 0) {
        biTemporalCandidates = afterInhibition.filter((c) => !invalidated.has(c.id));
        biTemporalFiltered = invalidated.size;
      }
    }
  }

  // S67 Plan 2.5b: retrieval-side freshest-by-subject filter. For current-state
  // queries, when multiple candidates share the same subject, keep only the
  // freshest. Catches the knowledge-update failure mode (LME: "cocktail class
  // on Thursday" old, "on Friday" new, both in memory, retrieval surfaces
  // both, model picks wrong). Doesn't require write-side invalid_at to be set.
  if (applyBiTemporalFilter) {
    const beforeCount = biTemporalCandidates.length;
    biTemporalCandidates = freshestBySubjectFilter(biTemporalCandidates);
    const droppedBySubject = beforeCount - biTemporalCandidates.length;
    if (droppedBySubject > 0) {
      biTemporalFiltered += droppedBySubject;
      log.debug(
        { droppedBySubject, queryType, query: query.substring(0, 80) },
        'Plan 2.5b: dropped older subject-duplicates',
      );
    }
  }

  // Packet A: entity boost (Mem0). Computed once per query, applied during additive ranking.
  let entityBoosts = new Map<string, number>();
  let entityBoostHits = 0;
  if (config.entityBoostEnabled && config.hybridFusionMode === 'additive') {
    const dbAccessor = (repo as { getDatabase?: () => Database.Database }).getDatabase;
    if (dbAccessor) {
      const db = dbAccessor.call(repo);
      entityBoosts = computeEntityBoosts(db, extractQueryEntities(query), 'system', {
        enabled: true,
        boostWeight: config.entityBoostWeight,
        maxEntities: config.entityBoostMaxEntities,
      });
      entityBoostHits = entityBoosts.size;
    }
  }

  const preHubRanked: FinalScoredCandidate[] =
    config.hybridFusionMode === 'additive'
      ? rankAdditive(biTemporalCandidates, query, entityBoosts, config.entityBoostWeight, rankLimit)
      : rankCandidates(
          biTemporalCandidates,
          adaptWeights(biTemporalCandidates, profiledWeights),
          rankLimit,
          // S63 (B19-D): freshness scoring uses the override anchor when set
          // so 2023-anchored bench conversations don't score every memory as
          // ~3 years stale against May 2026 wall-clock.
          nowOverride ? new Date(nowOverride) : undefined,
        );

  // S66: FFC (collapseFactFamilies) removed, was wired for the dual-phrasing
  // extraction fixtures deleted in S64. Production writers don't set canonicalFactId.
  const cascadeResult = await applyCascade(repo, preHubRanked, maxResults);
  const postCascade = cascadeResult.candidates;

  // EPISODE_CONTEXT_ENABLED killed S24 (-7.4pp brain #11). Episode injection
  // is now injection-only, gated on EPISODES_ENABLED in inject/episodes.
  const withEpisodeContext = postCascade;

  const deduped =
    process.env.DEDUP_INJECTION_ENABLED === 'true' ? dedupInjectionSet(withEpisodeContext) : withEpisodeContext;

  // Wave 2 E-salvage will wire temporal-window dateBounds back in here so
  // the episode-id bonus can fire on bench fixtures with structured episodeIds.
  // For now this is a passthrough.
  const dedupedForRerank: FinalScoredCandidate[] = deduped;

  // --- Final rerank ---
  const ranked = await rerank(query, dedupedForRerank, maxResults, { queryType, nowIso: rrfRefIso });

  const mergeAndScoreMs = performance.now() - scoreStart;
  const totalMs = performance.now() - totalStart;

  if (config.thompsonShadowEnabled && ranked.length > 0) {
    const logDir = config.backupPath;
    logShadowComparison(query, ranked, logDir);
  }

  if (totalMs > 50) {
    log.warn({ query, totalMs, lexicalMs, vectorMs, mergeAndScoreMs }, 'Retrieval exceeded 50ms SLO');
  } else {
    log.debug({ query, totalMs, candidatesReturned: ranked.length }, 'Retrieval complete');
  }

  // --- On-demand re-extraction trigger (tier 3) ---
  // Flag: REEXTRACT_ENABLED=true
  // When retrieval is thin, flag for re-extraction from STONE
  const topScore = ranked.length > 0 ? ranked[0]!.finalScore : 0;
  const reextractNeeded = shouldReextract(topScore, ranked.length);
  let reextractedFacts: Array<{ subject: string; claim: string }> = [];
  if (reextractNeeded && deps?.stoneStore && deps?.callLLM) {
    log.info(
      { query: query.substring(0, 80), topScore, candidateCount: ranked.length },
      'Re-extraction triggered (thin retrieval)',
    );
    try {
      reextractedFacts = await executeReextraction(query, deps.stoneStore, deps.callLLM);
    } catch (err) {
      log.error({ err, query: query.substring(0, 80) }, 'Re-extraction failed, proceeding without it');
    }
  } else if (reextractNeeded) {
    log.info(
      { query: query.substring(0, 80), topScore, candidateCount: ranked.length },
      'Re-extraction triggered but deps not provided (no-op)',
    );
  }

  // B1a: record this retrieval for the offline weight tuner. Cap stored
  // candidates at 50 so a wide overfetch doesn't bloat the row; trim
  // claim text to 200 chars per candidate for the same reason. Telemetry
  // is best-effort, getStorage().isEnabled() inside recordRetrieval
  // short-circuits when TELEMETRY_ENABLED=false (zero hot-path cost).
  const STORED_CANDIDATES_CAP = 50;
  const CLAIM_EXCERPT_LEN = 200;
  const retrievalId = recordRetrieval({
    query,
    query_type: queryType,
    user_id: userId,
    conversation_id: deps?.stoneStore ? undefined : undefined, // wired by caller for now; future: thread from deps
    candidates: ranked.slice(0, STORED_CANDIDATES_CAP).map((c) => ({
      id: c.id,
      claim_excerpt: c.candidate.record.claim.slice(0, CLAIM_EXCERPT_LEN),
      finalScore: c.finalScore,
      breakdown: { ...c.scoreBreakdown },
    })),
    candidates_total: ranked.length,
    weights: { ...profiledWeights },
    duration_ms: Math.round(totalMs * 100) / 100,
  });

  return {
    candidates: ranked,
    reextractedFacts: reextractedFacts.length > 0 ? reextractedFacts : undefined,
    metadata: {
      query,
      queryType,
      queryEmbedding,
      // S5: Surface reextractNeeded so callers can act on it
      reextractNeeded,
      reextractedCount: reextractedFacts.length,
      candidatesGenerated: merged.length,
      candidatesAfterFilter: afterInhibition.length,
      candidatesReturned: ranked.length,
      timings: {
        lexicalMs: Math.round(lexicalMs * 100) / 100,
        vectorMs: Math.round(vectorMs * 100) / 100,
        mergeAndScoreMs: Math.round(mergeAndScoreMs * 100) / 100,
        totalMs: Math.round(totalMs * 100) / 100,
      },
      fusionMode: config.hybridFusionMode,
      weightProfile: {
        lexicalWeight: profiledWeights.lexicalWeight,
        vectorWeight: profiledWeights.vectorWeight,
      },
      entityBoostHits,
      biTemporalFiltered,
      // B1a: id for downstream recordInjection correlation
      retrievalId: retrievalId ?? undefined,
    },
  };
}
