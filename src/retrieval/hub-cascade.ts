import type { IMemoryRepository } from '../repository/interface.js';
import type { FinalScoredCandidate } from './scorer.js';
import { createLogger } from '../config.js';

const log = createLogger('hub-cascade');

/**
 * Hub cascade: when spokes are retrieved, surface their hubs.
 *
 * For each retrieved memory, check if it's linked to a hub.
 * If the hub isn't already in the result set, inject it at
 * the top with a small bonus. This ensures principles appear
 * alongside their implementations.
 *
 * S67 perf fix: was N+1 awaits, getHubLinks(memId) per candidate THEN
 * getHubById(hubId) per unique hub. With max-rules=65 that's up to 65+H
 * queries per retrieval (typically 65 with H=0 in benches since fixtures
 * have no hubs). Now: TWO batched repo calls, getHubLinksForMany(ids)
 * + getHubsByIds(ids). Both are single SQL round-trips with IN clauses.
 *
 * Zero LLM calls. Two DB queries per cascade, regardless of candidate count.
 */

export interface CascadedResult {
  candidates: FinalScoredCandidate[];
  hubsInjected: string[];
}

export async function applyCascade(
  repo: IMemoryRepository,
  candidates: FinalScoredCandidate[],
  maxTotal: number,
): Promise<CascadedResult> {
  if (candidates.length === 0) return { candidates, hubsInjected: [] };

  const memoryIds = candidates.map((c) => c.id);
  const existingIds = new Set(memoryIds);

  // Round-trip 1: all hub_links for the candidate set in one query.
  const links = await repo.getHubLinksForMany(memoryIds);
  if (links.length === 0) return { candidates, hubsInjected: [] };

  // Deduplicate hub ids and exclude any already present as a candidate.
  const hubIdsToFetch: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (existingIds.has(link.hubId)) continue;
    if (seen.has(link.hubId)) continue;
    seen.add(link.hubId);
    hubIdsToFetch.push(link.hubId);
  }
  if (hubIdsToFetch.length === 0) return { candidates, hubsInjected: [] };

  // Round-trip 2: all hub records in one query.
  const hubs = await repo.getHubsByIds(hubIdsToFetch);
  if (hubs.length === 0) return { candidates, hubsInjected: [] };

  // Hub gets a score just above the lowest ranked candidate.
  const lowestScore = candidates[candidates.length - 1]!.finalScore;

  const hubCandidates: FinalScoredCandidate[] = [];
  const hubsInjected: string[] = [];

  for (const hub of hubs) {
    // Increment hub access count (fire-and-forget).
    repo.incrementHubAccessCount(hub.id).catch(() => {});

    hubCandidates.push({
      id: hub.id,
      candidate: {
        id: hub.id,
        record: {
          id: hub.id,
          claim: hub.claim,
          subject: `hub:${hub.hubType}`,
          scope: 'global' as const,
          validFrom: null,
          validTo: null,
          provenance: 'user-confirmed' as const,
          trustClass: 'confirmed' as const,
          confidence: 1.0,
          sourceHash: hub.id,
          supersedes: null,
          conflictsWith: [],
          reviewStatus: 'approved' as const,
          accessCount: hub.accessCount,
          lastAccessed: new Date().toISOString(),
          createdAt: hub.createdAt,
          updatedAt: hub.createdAt,
          embedding: null,
          permanenceStatus: 'permanent' as const,
          hubId: null,
          hubScore: 0,
          resolution: 3,
          memoryType: 'declarative' as const,
          versionNumber: 1,
          parentVersionId: null,
          frozenAt: null,
          decayScore: 1,
          storageTier: 'active' as const,
          isInhibitory: false,
          inhibitionTarget: null,
          interferenceStatus: 'active' as const,
          correctionCount: 0,
          isFrozen: false,
          causedBy: null,
          leadsTo: null,
          canonicalFactId: null,
          isCanonical: true,
          validAt: null,
          invalidAt: null,
          persona: false,
        },
        lexicalScore: 0,
        vectorScore: 0,
        source: 'fts' as const,
        hubExpansionScore: 0,
        inhibitionPenalty: 0,
        primingBonus: 0,
        cascadeDepth: 0,
      },
      finalScore: lowestScore + 0.01,
      scoreBreakdown: {
        lexicalComponent: 0,
        vectorComponent: 0,
        provenanceComponent: 1.0,
        freshnessComponent: 1.0,
        confirmedBonus: 0.15,
        contradictionPenalty: 0,
      },
    });
    hubsInjected.push(hub.id);
  }

  // Insert hubs at the beginning (principles before implementations).
  const combined = [...hubCandidates, ...candidates].slice(0, maxTotal);

  log.debug({ hubCount: hubsInjected.length }, 'Hub cascade applied');
  return { candidates: combined, hubsInjected };
}
