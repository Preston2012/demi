/**
 * Memory Autopsy: Diagnose why a query failed.
 *
 * Traces through the full pipeline to identify:
 * 1. Was the fact extracted? (check fact_facets + memories)
 * 2. Was it retrieved? (check vector/FTS scores)
 * 3. Was it injected? (check budget/dedup filtering)
 * 4. Was it used by the answer model? (check predicted vs expected)
 *
 * Exposed via MCP tool: memory_autopsy
 */

import { createLogger } from '../config.js';
import type { IMemoryRepository } from '../repository/interface.js';
import { searchVector } from '../retrieval/vector.js';
import { searchLexical } from '../retrieval/lexical.js';

const log = createLogger('autopsy');

export interface AutopsyResult {
  query: string;
  expectedAnswer: string;
  diagnosis: AutopsyDiagnosis;
  candidates: AutopsyCandidate[];
  recommendation: string;
}

export type AutopsyDiagnosis =
  | 'not-extracted'     // fact never made it into memory store
  | 'extracted-not-retrieved' // in store but didn't surface in search
  | 'retrieved-not-injected'  // surfaced but filtered by budget/dedup
  | 'injected-not-used'      // in context but answer model ignored it
  | 'judge-disagreement';    // answer was close, judge was harsh

export interface AutopsyCandidate {
  claim: string;
  subject: string;
  vectorScore: number;
  lexicalScore: number;
  wouldBeInjected: boolean;
  relevanceToQuery: 'high' | 'medium' | 'low' | 'none';
}

/**
 * Run autopsy on a failed question.
 */
export async function runAutopsy(
  repo: IMemoryRepository,
  query: string,
  expectedAnswer: string,
  predictedAnswer: string,
  searchTerms: string[],
): Promise<AutopsyResult> {
  const expectedLower = expectedAnswer.toLowerCase();
  const predictedLower = predictedAnswer.toLowerCase();

  // Step 1: Search for facts matching expected answer
  const vectorResults = await searchVector(repo, query, 100);
  const lexicalResults = await searchLexical(repo, query, 100);

  // Build score maps
  const vecScores = new Map(vectorResults.map(r => [r.record.id, r.vectorScore]));
  const lexScores = new Map(lexicalResults.map(r => [r.record.id, r.lexicalScore]));

  // Find candidates that contain expected answer terms

  const candidates: AutopsyCandidate[] = [];
  let bestMatch: AutopsyCandidate | null = null;

  for (const result of vectorResults) {
    const claim = result.record.claim.toLowerCase();
    const matchesExpected = searchTerms.some(t => claim.includes(t.toLowerCase()));

    const candidate: AutopsyCandidate = {
      claim: result.record.claim,
      subject: result.record.subject,
      vectorScore: vecScores.get(result.record.id) || 0,
      lexicalScore: lexScores.get(result.record.id) || 0,
      wouldBeInjected: (vecScores.get(result.record.id) || 0) > 0.3,
      relevanceToQuery: matchesExpected ? 'high' : 'low',
    };

    if (matchesExpected && (!bestMatch || candidate.vectorScore > bestMatch.vectorScore)) {
      bestMatch = candidate;
    }
    candidates.push(candidate);
  }

  // Diagnose
  let diagnosis: AutopsyDiagnosis;
  let recommendation: string;

  if (!bestMatch) {
    // No fact in the store matches expected answer
    diagnosis = 'not-extracted';
    recommendation = 'Fact was never extracted from conversation. Need better extraction prompt or re-extraction from STONE.';
  } else if (bestMatch.vectorScore < 0.3) {
    diagnosis = 'extracted-not-retrieved';
    recommendation = `Fact exists (score ${bestMatch.vectorScore.toFixed(3)}) but below retrieval threshold. Embedding mismatch between query and claim. Consider brute-force or entity expansion.`;
  } else if (!bestMatch.wouldBeInjected) {
    diagnosis = 'retrieved-not-injected';
    recommendation = 'Fact was retrieved but filtered by budget cap or dedup. Consider raising maxRules or adjusting dedup threshold.';
  } else if (predictedLower.includes(expectedLower) || expectedLower.split(' ').some(w => w.length > 3 && predictedLower.includes(w))) {
    diagnosis = 'judge-disagreement';
    recommendation = 'Answer contains expected information but judge rejected. May be a ground-truth error or overly strict judge.';
  } else {
    diagnosis = 'injected-not-used';
    recommendation = 'Fact was in context but answer model ignored or misinterpreted it. Prompt engineering or model routing issue.';
  }

  log.info({
    query: query.substring(0, 80),
    diagnosis,
    bestMatchScore: bestMatch?.vectorScore,
    candidateCount: candidates.length,
  }, 'Autopsy complete');

  return {
    query,
    expectedAnswer,
    diagnosis,
    candidates: candidates
      .filter(c => c.relevanceToQuery === 'high' || c.vectorScore > 0.4)
      .slice(0, 10),
    recommendation,
  };
}
