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
 * Zero LLM calls. One DB query per unique hub (cached per retrieval).
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

  const hubsInjected: string[] = [];
  const existingIds = new Set(candidates.map((c) => c.id));
  // Collect all hub IDs linked to retrieved memories
  const hubIdsToFetch = new Set<string>();
  for (const c of candidates) {
    const links = await repo.getHubLinks(c.id);
    for (const link of links) {
      if (!existingIds.has(link.hubId)) {
        hubIdsToFetch.add(link.hubId);
      }
    }
  }

  if (hubIdsToFetch.size === 0) return { candidates, hubsInjected: [] };

  // Fetch hub details and build synthetic candidates
  const hubCandidates: FinalScoredCandidate[] = [];
  for (const hubId of hubIdsToFetch) {
    const hub = await repo.getHubById(hubId);
    if (!hub) continue;

    // Increment hub access count (fire-and-forget)
    repo.incrementHubAccessCount(hubId).catch(() => {});

    // Build a synthetic scored candidate for the hub
    // Hub gets a score just above the lowest ranked candidate
    const lowestScore = candidates.length > 0
      ? candidates[candidates.length - 1]!.finalScore
      : 0;

    hubCandidates.push({
      id: hubId,
      candidate: {
        id: hubId,
        record: {
          id: hubId,
          claim: hub.claim,
          subject: `hub:${hub.hubType}`,
          scope: 'global' as const,
          validFrom: null,
          validTo: null,
          provenance: 'user-confirmed' as const,
          trustClass: 'confirmed' as const,
          confidence: 1.0,
          sourceHash: hubId,
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

    hubsInjected.push(hubId);
  }

  if (hubCandidates.length === 0) return { candidates, hubsInjected: [] };

  // Insert hubs at the beginning (principles before implementations)
  const combined = [...hubCandidates, ...candidates].slice(0, maxTotal);

  log.debug({ hubCount: hubsInjected.length }, 'Hub cascade applied');
  return { candidates: combined, hubsInjected };
}
