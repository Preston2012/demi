/**
 * Adversarial Consensus: Multi-model validation for write pipeline.
 * Pro tier feature. ~15-20% of writes escalated here.
 *
 * Architecture:
 *   1. Primary extraction model proposes facts
 *   2. Validator model (different provider) checks each fact
 *   3. Red-team model (Grok) tries to find flaws
 *   4. Consensus: 2/3 agree = confirmed, split = quarantine
 *
 * Multi-provider requirement (A-3): same model 3x catches noise, not bias.
 * Must use different providers for genuine consensus.
 *
 * Flag: CONSENSUS_ENABLED=true (default: false, Pro tier only)
 */



export type ConsensusVerdict = 'confirmed' | 'rejected' | 'quarantine';

export interface ConsensusVote {
  model: string;
  provider: string;
  verdict: 'accept' | 'reject' | 'uncertain';
  reason: string;
  confidence: number;
  latencyMs: number;
}

export interface ConsensusResult {
  factId: string;
  claim: string;
  votes: ConsensusVote[];
  finalVerdict: ConsensusVerdict;
  consensusScore: number;
  escalationReason: string;
}

/** Reasons a fact gets escalated to consensus */
export type EscalationReason =
  | 'low-confidence'     // extraction confidence < 0.7
  | 'conflict-detected'  // contradicts existing fact
  | 'sensitive-subject'  // involves health, legal, financial
  | 'temporal-ambiguity' // unclear time references
  | 'spot-check';        // random sample for quality monitoring

/**
 * Determine if a fact should be escalated to consensus.
 * ~15-20% of writes based on empirical calibration.
 */
export function shouldEscalate(
  claim: string,
  confidence: number,
  hasConflict: boolean,
  spotCheckRate = 0.05,
): { escalate: boolean; reason: EscalationReason } {
  if (process.env.CONSENSUS_ENABLED !== 'true') {
    return { escalate: false, reason: 'spot-check' };
  }

  if (hasConflict) return { escalate: true, reason: 'conflict-detected' };
  if (confidence < 0.7) return { escalate: true, reason: 'low-confidence' };

  const lc = claim.toLowerCase();
  const sensitivePatterns = /\b(health|medical|legal|financial|salary|diagnosis|medication|died|death|divorce|pregnant)\b/;
  if (sensitivePatterns.test(lc)) return { escalate: true, reason: 'sensitive-subject' };

  const temporalAmbiguity = /\b(recently|sometime|a while ago|not sure when|around)\b/;
  if (temporalAmbiguity.test(lc)) return { escalate: true, reason: 'temporal-ambiguity' };

  if (Math.random() < spotCheckRate) return { escalate: true, reason: 'spot-check' };

  return { escalate: false, reason: 'spot-check' };
}

/**
 * Build validation prompt for a consensus voter.
 */
export function buildValidationPrompt(
  claim: string,
  sourceContext: string,
  existingFacts: string[],
  role: 'validator' | 'red-team',
): string {
  const existingContext = existingFacts.length > 0
    ? `\nEXISTING FACTS ABOUT THIS SUBJECT:\n${existingFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n`
    : '';

  if (role === 'red-team') {
    return `You are an adversarial fact checker. Your job is to find flaws.

PROPOSED FACT: ${claim}

SOURCE CONTEXT: ${sourceContext}
${existingContext}
Try to find ANY reason this fact should NOT be stored:
- Is it actually supported by the source context?
- Does it contradict existing facts?
- Is it too vague or ambiguous to be useful?
- Does it contain hallucinated details not in the source?
- Is it a duplicate of an existing fact?

Respond with exactly one line:
ACCEPT: [reason] OR REJECT: [reason] OR UNCERTAIN: [reason]`;
  }

  return `You are validating whether a proposed fact is accurate and worth storing.

PROPOSED FACT: ${claim}

SOURCE CONTEXT: ${sourceContext}
${existingContext}
Check:
1. Is this fact supported by the source context?
2. Does it conflict with existing facts?
3. Is it specific enough to be useful?

Respond with exactly one line:
ACCEPT: [reason] OR REJECT: [reason] OR UNCERTAIN: [reason]`;
}

/**
 * Parse a consensus vote from model response.
 */
export function parseVote(response: string, model: string, provider: string, latencyMs: number): ConsensusVote {
  const line = response.trim().split('\n')[0] || '';

  if (line.startsWith('ACCEPT')) {
    return { model, provider, verdict: 'accept', reason: line.substring(8).trim(), confidence: 0.9, latencyMs };
  }
  if (line.startsWith('REJECT')) {
    return { model, provider, verdict: 'reject', reason: line.substring(8).trim(), confidence: 0.9, latencyMs };
  }
  return { model, provider, verdict: 'uncertain', reason: line.substring(11).trim() || 'unclear response', confidence: 0.5, latencyMs };
}

/**
 * Determine final verdict from votes.
 * 2/3 agree = that verdict. Split = quarantine.
 */
export function resolveConsensus(votes: ConsensusVote[]): { verdict: ConsensusVerdict; score: number } {
  const accepts = votes.filter(v => v.verdict === 'accept').length;
  const rejects = votes.filter(v => v.verdict === 'reject').length;
  const total = votes.length;

  if (total === 0) return { verdict: 'quarantine', score: 0 };

  const acceptRatio = accepts / total;
  const rejectRatio = rejects / total;

  if (acceptRatio >= 0.67) return { verdict: 'confirmed', score: acceptRatio };
  if (rejectRatio >= 0.67) return { verdict: 'rejected', score: rejectRatio };
  return { verdict: 'quarantine', score: Math.max(acceptRatio, rejectRatio) };
}

/**
 * Default model configuration for consensus.
 * Must use different providers (A-3).
 */
export function getConsensusModels(): Array<{ model: string; provider: string; role: 'validator' | 'red-team' }> {
  return [
    {
      model: process.env.CONSENSUS_VALIDATOR_1 || 'gpt-4.1-mini',
      provider: 'openai',
      role: 'validator',
    },
    {
      model: process.env.CONSENSUS_VALIDATOR_2 || 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      role: 'validator',
    },
    {
      model: process.env.CONSENSUS_RED_TEAM || 'grok-4-1-fast-non-reasoning',
      provider: 'xai',
      role: 'red-team',
    },
  ];
}
