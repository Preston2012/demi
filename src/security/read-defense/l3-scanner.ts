/**
 * W4 Track B L3: payload-level injection scanner.
 *
 * Spec: docs/internal/WEDGE_4_TRACK_B_DESIGN.md §3.2.
 *
 * Runs once per query, after the payload is assembled, as a single LLM call
 * over the concatenated context the answer model would see. Catches emergent
 * payload-level attacks that no single-memory scan (L2) can see.
 *
 * Posture:
 *   - injection verdict  -> drop the whole payload to a safe-empty result
 *     (the answer model gets no memory context for this query; equivalent to a
 *     cold answer). Conservative v1 behavior; selective removal is W6+.
 *   - clean verdict      -> payload passes unchanged.
 *   - provider exhausted -> FAIL OPEN (payload unchanged). A defense-in-depth
 *     layer sitting behind L1+L2 must not block all reads on an LLM outage.
 *   - unparseable verdict -> FAIL OPEN.
 *
 * Mirrors Track A calibrated-teacher's call/catch/parse structure.
 */

import { runProviderChain, ProviderChainExhaustedError } from '../../llm/provider-chain.js';
import { recordDecision, recordError } from '../../telemetry/index.js';
import { L3_SYSTEM_PROMPT } from './track-b-l3-prompt.js';
import { chainForCell } from '../../llm/cells.js';
import { NULL_REDACTOR } from './redactor.js';
import { NULL_ROUTER } from './router.js';
import { formatForContext } from '../../inject/index.js';
import type { InjectionPayload } from '../../schema/memory.js';

interface L3Verdict {
  injection: boolean;
  reason: string;
}

/** Drop a payload to a safe-empty result: no memories reach the answer model. */
function safeEmpty(payload: InjectionPayload): InjectionPayload {
  return { ...payload, memories: [], conflicts: [], conflictTags: {} };
}

/**
 * Scan the assembled payload. Returns the payload unchanged when clean or on
 * any failure (fail-open); returns a safe-empty payload on a positive
 * injection verdict.
 */
export async function applyL3Defense(payload: InjectionPayload): Promise<InjectionPayload> {
  if (payload.memories.length === 0) return payload; // nothing to scan

  const assembled = formatForContext(payload);
  if (!assembled) return payload;

  let chain;
  try {
    // W4 Track E: the injection-l3 cell drives the chain, availability-filtered
    // so a single-vendor client still resolves a scanner model.
    chain = await runProviderChain(L3_SYSTEM_PROMPT, assembled, {
      chain: chainForCell('injection-l3'),
      cell: 'injection-l3',
      cacheKey: 'demiurge:track-b:l3:v1',
    });
  } catch (err) {
    const attempts = err instanceof ProviderChainExhaustedError ? err.attempts : [];
    recordError({
      error_type: 'read_defense.l3_provider_chain_exhausted',
      message: err instanceof Error ? err.message : String(err),
      tags: { source: 'l3-scanner', attempts: JSON.stringify(attempts) },
    });
    return payload; // FAIL-OPEN
  }

  let verdict: L3Verdict;
  try {
    const cleaned = chain.text.replace(/```json|```/g, '').trim();
    verdict = JSON.parse(cleaned) as L3Verdict;
  } catch {
    recordError({
      error_type: 'read_defense.l3_parse_failed',
      message: chain.text.slice(0, 200),
      tags: { source: 'l3-scanner', model_used: chain.model },
    });
    return payload; // FAIL-OPEN on unparseable verdict
  }

  if (verdict.injection) {
    recordDecision({
      decision_type: 'read_injection_l3',
      branch_taken: 'refuse',
      outcome: 'payload_injection_detected',
      inputs: { reason: verdict.reason?.slice(0, 200), model_used: chain.model },
    });
    // Wire the (no-op in v1) sensitive-content seams so the W6 real impls drop
    // in without re-architecture. Both record a read_defense_null_stub.
    NULL_ROUTER.route(payload, 'injection');
    const redacted = NULL_REDACTOR.redact(payload, []);
    return safeEmpty(redacted);
  }

  recordDecision({
    decision_type: 'read_injection_l3',
    branch_taken: 'accept',
    outcome: 'clean',
    inputs: { model_used: chain.model },
  });
  return payload;
}
