/**
 * Episode Contextualization (R10 Council #2)
 * When a fact hits in retrieval, pull sibling facts from the same session/subject.
 * Behind EPISODE_CONTEXT_ENABLED flag.
 */
import type { IMemoryRepository } from "../repository/interface.js";
import type { FinalScoredCandidate } from "./scorer.js";
import type { CandidateSource } from "../schema/memory.js";
import { createLogger } from "../config.js";

const log = createLogger("episode-context");

const MAX_SIBLINGS_PER_SESSION = 3;
const MAX_SESSIONS_EXPANDED = 3;

export async function expandEpisodeContext(
  repo: IMemoryRepository,
  candidates: FinalScoredCandidate[],
  _query: string,
  maxResults: number
): Promise<FinalScoredCandidate[]> {
  if (candidates.length === 0) return candidates;

  const subjectGroups = new Map<string, number>();
  for (const c of candidates) {
    const subj = c.candidate.record.subject || "unknown";
    const best = subjectGroups.get(subj) ?? 0;
    if (c.finalScore > best) subjectGroups.set(subj, c.finalScore);
  }

  const sortedSubjects = [...subjectGroups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SESSIONS_EXPANDED)
    .map(([s]) => s);

  const existingIds = new Set(candidates.map(c => c.id));
  const siblings: FinalScoredCandidate[] = [];

  for (const subject of sortedSubjects) {
    try {
      const sessionFacts = await repo.getBySubject(subject, MAX_SIBLINGS_PER_SESSION * 3);
      for (const fact of sessionFacts) {
        if (existingIds.has(fact.id)) continue;
        if (siblings.length >= MAX_SIBLINGS_PER_SESSION * MAX_SESSIONS_EXPANDED) break;
        existingIds.add(fact.id);
        siblings.push({
          id: fact.id,
          candidate: {
            id: fact.id,
            record: fact,
            lexicalScore: 0,
            vectorScore: 0,
            source: "lexical" as CandidateSource,
            hubExpansionScore: 0,
            inhibitionPenalty: 0,
            primingBonus: 0,
            cascadeDepth: 0,
          },
          finalScore: 0.05,
          scoreBreakdown: {
            lexicalComponent: 0,
            vectorComponent: 0,
            provenanceComponent: 0,
            freshnessComponent: 0,
            confirmedBonus: 0,
            contradictionPenalty: 0,
          },
        });
      }
    } catch (err) {
      log.warn({ subject, err }, "Failed to expand episode context");
    }
  }

  if (siblings.length > 0) {
    log.debug({ expanded: siblings.length, sessions: sortedSubjects.length }, "Episode context expanded");
  }

  return [...candidates, ...siblings].slice(0, maxResults + siblings.length);
}
