/**
 * Wedge 2 (S74): plan-executor compatibility shim for dispatch.search.
 *
 * Responsibility:
 *   1. Gate plan execution behind PLAN_EXECUTOR_ENABLED (raw env compare).
 *   2. When ON, try to plan the query. If the planner declines (returns
 *      null), fall back to the legacy retrieve() pipeline so single-hop
 *      and open-domain queries don't regress (lock condition §6.6).
 *   3. When the planner emits a Plan, execute it and ADAPT the resulting
 *      MemoryPacket into the existing `RetrievalResult` shape that
 *      dispatch.search expects.
 *   4. P3 / Option C: when the planner accepted but execution returned
 *      zero facts AND zero refusals, fall back to legacy retrieve(). The
 *      empty-plan event is still captured in telemetry so Wedge 4's
 *      calibrator sees the signal, only the user-visible result swaps
 *      to legacy. metadata.planExecutorFellBack=true marks the path.
 *
 *      Why this changed from the prior D2 lock (surface empty as
 *      unresolvedQuestions): operator review of the T2 LOCOMO regression
 *      showed 95% of temporal queries returning zero memories in production
 *      because the decomposer + planner grammars hadn't been aligned. The
 *      D2 signal-preservation rationale still holds, but the user-facing
 *      cost of preserving that signal at the expense of correct retrieval
 *      is the wrong tradeoff for Stage 1. P3 keeps the telemetry capture
 *      while restoring legacy-parity for users. Wedge 4's calibrator can
 *      still learn from the captured packet.
 */

import type { Config } from '../config.js';
import { createLogger } from '../config.js';
import type { IMemoryRepository } from '../repository/interface.js';
import type { MemoryRecord } from '../schema/memory.js';
import { executePlan } from '../plan/executor.js';
import { planQuery } from '../plan/planner.js';
import type { AssertionTriple, MemoryPacket } from '../plan/types.js';
import { engineNow } from './engine-now.js';
import type { QueryType } from './query-classifier.js';
import { retrieve, type RetrievalResult } from './index.js';
import type { FinalScoredCandidate } from './scorer.js';
import type { ScoredCandidate } from '../schema/memory.js';
import type { StoneStore } from '../stone/index.js';

const log = createLogger('plan-shim');

export interface PlanShimDeps {
  stoneStore?: StoneStore;
  callLLM?: (prompt: string) => Promise<string>;
  userId?: string;
  nowIso?: string;
}

/**
 * Entry point called by dispatch.search instead of `retrieve()` directly.
 *
 * Returns a `RetrievalResult` so the downstream dispatch.search pipeline
 * (buildInjectionPayload, episode injection, score normalization) keeps
 * working without changes. When the plan executor ran, the full
 * `MemoryPacket` is attached on `result.memoryPacket` for callers that
 * want native access (Wedge 3 Materializer, Wedge 5 STONE-as-Source).
 */
export async function searchViaPlanOrLegacy(
  repo: IMemoryRepository,
  query: string,
  config: Config,
  limit: number | undefined,
  deps: PlanShimDeps,
): Promise<RetrievalResult> {
  // Flag read: raw env per DEMIURGE_STATE locked decision
  // ("Flag pattern !== 'true' (never === 'false'); default OFF unless
  // explicitly === 'true'"). z.coerce.boolean() coerces any non-empty
  // string to true, so `PLAN_EXECUTOR_ENABLED=false` (as bench launchers
  // pass) would become true via Zod, exactly the regression the W2 #1
  // bench hit. Match the rest of the codebase: raw string compare.
  const planExecutorEnabled = process.env.PLAN_EXECUTOR_ENABLED === 'true';
  if (!planExecutorEnabled) {
    return retrieve(repo, query, config, limit, {
      stoneStore: deps.stoneStore,
      callLLM: deps.callLLM,
      userId: deps.userId,
      nowIso: deps.nowIso,
    });
  }

  const nowIso = deps.nowIso ?? engineNow();
  const plan = planQuery(query, nowIso);

  // Planner declined: legacy retrieve owns this query (single-hop, open-domain, etc.).
  if (plan === null) {
    log.debug({ query }, 'planner declined, falling back to legacy retrieve');
    return retrieve(repo, query, config, limit, {
      stoneStore: deps.stoneStore,
      callLLM: deps.callLLM,
      userId: deps.userId,
      nowIso: deps.nowIso,
    });
  }

  // Plan succeeded → execute and adapt.
  log.debug(
    { query, plan_root: plan.root, query_type: plan.queryType, operator_count: Object.keys(plan.operators).length },
    'plan executor running',
  );
  const packet = await executePlan(plan, repo, {
    query,
    nowIso,
    userId: deps.userId ?? 'system',
  });

  // P3 fallback (per PLANNER_RERANKER_FIX_SPEC §1 Option C):
  // when the planner accepted but the executor returned zero facts AND
  // zero refusals, fall back to legacy retrieve(). Decomposer coverage
  // gaps, missing valid_from anchors, or write-path delays can leave the
  // executor with nothing to find even though the planner judged the
  // query in-scope. Legacy retrieve has different mechanics (FTS +
  // vector) and will often surface relevant memories anyway.
  //
  // The empty plan execution is still captured in telemetry, Wedge 4's
  // calibrator needs the signal of "planner thought it could answer but
  // didn't" to train against. Only the user-visible result swaps to
  // legacy. metadata.planExecutorFellBack=true lets tests assert this
  // path fired without parsing logs.
  if (packet.facts.length === 0 && packet.refusals.length === 0) {
    log.debug(
      { query, plan_root: plan.root, plan_type: plan.queryType },
      'plan empty, falling back to legacy retrieve (P3)',
    );
    const legacy = await retrieve(repo, query, config, limit, {
      stoneStore: deps.stoneStore,
      callLLM: deps.callLLM,
      userId: deps.userId,
      nowIso: deps.nowIso,
    });
    return {
      ...legacy,
      metadata: {
        ...legacy.metadata,
        planExecutorFellBack: true,
      },
    };
  }

  return adaptPacketToRetrievalResult(packet, query, plan.queryType as QueryType, repo, deps.userId ?? 'system');
}

/**
 * Adapt a MemoryPacket into the RetrievalResult shape dispatch.search
 * expects. Each fact resolves back to its source MemoryRecord via
 * `repo.getByIds` so the downstream injection pipeline has full record
 * context (claim text, provenance, validity).
 */
async function adaptPacketToRetrievalResult(
  packet: MemoryPacket,
  query: string,
  queryType: QueryType,
  repo: IMemoryRepository,
  userId: string,
): Promise<RetrievalResult> {
  const ids = uniqueSourceIds(packet.facts);
  const records = ids.length > 0 ? await repo.getByIds(ids, userId) : [];
  const byId = new Map(records.map((r) => [r.id, r]));

  const candidates: FinalScoredCandidate[] = [];
  for (const fact of packet.facts) {
    const record = byId.get(fact.assertion_id);
    if (!record) continue; // synthetic aggregate rows + dangling refs are dropped
    candidates.push(toFinalScored(fact, record));
  }

  const totalMs = packet.executionTrace.reduce((sum, t) => sum + t.duration_ms, 0);

  return {
    candidates,
    metadata: {
      query,
      queryType,
      queryEmbedding: null,
      candidatesGenerated: packet.facts.length,
      candidatesAfterFilter: candidates.length,
      candidatesReturned: candidates.length,
      timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs },
      planExecutorUsed: true,
    },
    memoryPacket: packet,
  };
}

function uniqueSourceIds(facts: AssertionTriple[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of facts) {
    if (seen.has(f.assertion_id)) continue;
    // Synthetic aggregate rows have a sentinel-prefixed assertion_id; skip them.
    if (f.assertion_id.startsWith('__aggregate__')) continue;
    seen.add(f.assertion_id);
    out.push(f.assertion_id);
  }
  return out;
}

function toFinalScored(fact: AssertionTriple, record: MemoryRecord): FinalScoredCandidate {
  const score = fact.confidence ?? record.confidence;
  const candidate: ScoredCandidate = {
    id: record.id,
    record,
    lexicalScore: 0,
    vectorScore: score,
    source: 'fts',
    hubExpansionScore: 0,
    inhibitionPenalty: 0,
    primingBonus: 0,
    cascadeDepth: 0,
  };
  return {
    id: record.id,
    candidate,
    finalScore: score,
    scoreBreakdown: {
      lexicalComponent: 0,
      vectorComponent: score,
      provenanceComponent: 0,
      freshnessComponent: 0,
      confirmedBonus: 0,
      contradictionPenalty: 0,
    },
  };
}
