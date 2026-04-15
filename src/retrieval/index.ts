import { expandEpisodeContext } from './episode-context.js';
import { dedupInjectionSet } from './dedup-injection.js';
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
  type FinalScoredCandidate,
  type ScoringWeights,
} from './scorer.js';
import { logShadowComparison } from './thompson.js';
import { applyCascade } from './hub-cascade.js';
import { collapseFactFamilies } from './collapse.js';
import { expandEntityQuery } from './entity-expansion.js';
import { entitySplitRetrieval } from './entity-split.js';
import { expandQuery } from './query-expansion.js';
import { classifyQuery, getDepthForType, type QueryType } from './query-classifier.js';
import { getQueryBudget, isQueryBudgetEnabled } from './query-budget.js';
import { rerank } from './reranker.js';
import { encode, isInitialized } from '../embeddings/index.js';
import type { ScoredCandidate } from '../schema/memory.js';
import { bruteForceRetrieval } from './brute-force.js';
import { encodeEnrichedQuery } from './query-expansion-v2.js';
import { rarRetrieval } from './rar.js';
import { shouldReextract } from '../stone/reextract.js';
import { isSqlFirstEligible, sqlFirstFastPath } from './sql-first.js';

const log = createLogger('retrieval');

export interface RetrievalResult {
  candidates: FinalScoredCandidate[];
  metadata: {
    query: string;
    queryType: QueryType;
    queryEmbedding: number[] | null;
    reextractNeeded?: boolean;
    candidatesGenerated: number;
    candidatesAfterFilter: number;
    candidatesReturned: number;
    timings: {
      lexicalMs: number;
      vectorMs: number;
      mergeAndScoreMs: number;
      totalMs: number;
    };
  };
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

export async function retrieve(
  repo: IMemoryRepository,
  query: string,
  config: Config,
  limit?: number,
): Promise<RetrievalResult> {
  let maxResults = limit ?? config.maxInjectedRules;
  const totalStart = performance.now();

  const queryType = classifyQuery(query);
  const dynamicDepthEnabled = process.env.DYNAMIC_DEPTH_ENABLED === 'true';
  if (dynamicDepthEnabled) {
    maxResults = getDepthForType(queryType, maxResults);
  }

  // S25: Per-query memory budgets (data-driven, reduces context drowning)
  if (isQueryBudgetEnabled()) {
    maxResults = getQueryBudget(queryType, maxResults);
  }

  // --- R12: SQL-first fast path for simple queries ---
  if (isSqlFirstEligible(queryType)) {
    const fastResult = await sqlFirstFastPath(repo, query, queryType, config, maxResults);
    if (fastResult) {
      return fastResult;
    }
  }

  const weights = weightsFromConfig(config);
  const candidateLimit = Math.max(maxResults * config.candidateOverfetchMultiplier, 30);

  // --- Lexical search ---
  const lexStart = performance.now();
  const lexicalCandidates = await searchLexical(repo, query, candidateLimit);
  const lexicalMs = performance.now() - lexStart;

  // --- Vector search ---
  const vecStart = performance.now();
  const vectorCandidates = await searchVector(repo, query, candidateLimit);
  const vectorMs = performance.now() - vecStart;

  // --- Compute query embedding for injection features ---
  let queryEmbedding: number[] | null = null;
  if (isInitialized()) {
    try {
      const enrichedEmbedding =
        process.env.QUERY_EXPANSION_V2 === 'true' ? await encodeEnrichedQuery(query, repo) : null;
      if (enrichedEmbedding) {
        queryEmbedding = enrichedEmbedding;
      } else {
        const prefixedQuery = 'Represent this sentence for searching relevant passages: ' + query;
        queryEmbedding = await encode(prefixedQuery);
      }
    } catch {
      // Non-critical: embedding for injection features, not retrieval
    }
  }

  // --- Query expansion ---
  const queryExpansionEnabled = process.env.QUERY_EXPANSION_ENABLED === 'true';
  const multiHopExpansionOnly = process.env.MULTIHOP_EXPANSION_ONLY === 'true';
  const extraCandidates: typeof vectorCandidates = [];
  const shouldExpand = queryExpansionEnabled && (!multiHopExpansionOnly || queryType === 'multi-hop');
  if (shouldExpand) {
    const expandedQueries = expandQuery(query);
    // F3: Parallelize secondary vector searches instead of sequential await
    const expansionResults = await Promise.all(
      expandedQueries.slice(0, 4).map((eq) => searchVector(repo, eq, candidateLimit)),
    );
    for (const extra of expansionResults) {
      extraCandidates.push(...extra);
    }
  }

  // --- Entity-split retrieval for multi-hop queries ---
  const entitySplitEnabled = process.env.ENTITY_SPLIT_ENABLED !== 'false';
  const entitySplitCandidates: typeof vectorCandidates = [];
  if (
    entitySplitEnabled &&
    (queryType === 'multi-hop' || (queryType === 'temporal' && process.env.ENTITY_SPLIT_TEMPORAL === 'true'))
  ) {
    const splitResults = await entitySplitRetrieval(repo, query, candidateLimit);
    entitySplitCandidates.push(...splitResults);
  }

  // --- Brute force retrieval for coverage queries ---
  const bruteForceCandidates: ScoredCandidate[] = [];
  if (process.env.BRUTE_FORCE_ENABLED === 'true' && queryType === 'coverage') {
    try {
      const bfResults = await bruteForceRetrieval(repo, query, candidateLimit);
      bruteForceCandidates.push(...bfResults);
      if (bfResults.length > 0) {
        log.debug({ bruteForceFacts: bfResults.length }, 'Brute force retrieval results');
      }
    } catch (err) {
      log.warn({ err }, 'Brute force retrieval failed (non-critical)');
    }
  }

  // --- Merge all fact candidates ---
  const scoreStart = performance.now();
  let merged = mergeCandidates(lexicalCandidates, vectorCandidates);
  if (extraCandidates.length > 0) merged = mergeCandidates(merged, extraCandidates);
  if (entitySplitCandidates.length > 0) merged = mergeCandidates(merged, entitySplitCandidates);
  if (bruteForceCandidates.length > 0) merged = mergeCandidates(merged, bruteForceCandidates);

  // --- RAR: second retrieval pass using first-pass context ---
  const rarCandidates: ScoredCandidate[] = [];
  if (process.env.RAR_ENABLED === 'true' && (queryType === 'multi-hop' || queryType === 'temporal')) {
    const topClaims = merged
      .sort((a, b) => (b.vectorScore || 0) - (a.vectorScore || 0))
      .slice(0, 15)
      .map((c) => c.record.claim);
    const rarResults = await rarRetrieval(repo, query, topClaims, queryType, candidateLimit);
    rarCandidates.push(...rarResults);
    if (rarCandidates.length > 0) merged = mergeCandidates(merged, rarCandidates);
  }

  const injectable = filterInjectable(merged);
  const expanded = await expandEntityQuery(repo, query, injectable, candidateLimit);
  const withExpanded = expanded.length > 0 ? mergeCandidates(injectable, filterInjectable(expanded)) : injectable;

  const inhibitions = await repo.getActiveInhibitions();
  const afterInhibition = applyInhibition(
    withExpanded,
    inhibitions.map((m) => ({
      inhibitionTarget: m.inhibitionTarget ?? '',
      confidence: m.confidence,
    })),
  );

  // --- Scoring (weighted mode only, RRF killed in R11) ---
  const rerankerEnabled = process.env.RERANKER_ENABLED === 'true';
  const rankLimit = rerankerEnabled ? Math.min(maxResults * 3, afterInhibition.length) : maxResults;

  const adaptedWeights = adaptWeights(afterInhibition, weights);
  const preHubRanked = rankCandidates(afterInhibition, adaptedWeights, rankLimit);

  const preCascadeCollapsed = collapseFactFamilies(preHubRanked);
  const cascadeResult = await applyCascade(repo, preCascadeCollapsed, maxResults);
  const postCascade = collapseFactFamilies(cascadeResult.candidates);

  // --- Episode context injection (CONFIRMED KEEP from R11) ---
  const episodeContextEnabled = process.env.EPISODE_CONTEXT_ENABLED === 'true';
  const withEpisodeContext = episodeContextEnabled
    ? await expandEpisodeContext(repo, postCascade, query, maxResults)
    : postCascade;

  const deduped =
    process.env.DEDUP_INJECTION_ENABLED === 'true' ? dedupInjectionSet(withEpisodeContext) : withEpisodeContext;

  // --- Final rerank ---
  const ranked = await rerank(query, deduped, maxResults);

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
  if (reextractNeeded) {
    log.info(
      { query: query.substring(0, 80), topScore, candidateCount: ranked.length },
      'Re-extraction triggered (thin retrieval)',
    );
  }

  return {
    candidates: ranked,
    metadata: {
      query,
      queryType,
      queryEmbedding,
      // S5: Surface reextractNeeded so callers can act on it
      reextractNeeded,
      candidatesGenerated: merged.length,
      candidatesAfterFilter: afterInhibition.length,
      candidatesReturned: ranked.length,
      timings: {
        lexicalMs: Math.round(lexicalMs * 100) / 100,
        vectorMs: Math.round(vectorMs * 100) / 100,
        mergeAndScoreMs: Math.round(mergeAndScoreMs * 100) / 100,
        totalMs: Math.round(totalMs * 100) / 100,
      },
    },
  };
}
