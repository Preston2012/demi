/**
 * Wedge 2 (S74): bounded-rounds plan executor.
 *
 * Walks the typed Plan tree in topological order, dispatches each operator,
 * accumulates an ExecutionTraceEntry per invocation, and assembles a
 * MemoryPacket from the root operator's output.
 *
 * Determinism + termination:
 *
 *   - The plan is a DAG (operator inputs are refs by id; the operators map is
 *     a flat dictionary). topoSort detects cycles and throws on malformed
 *     plans; the executor surfaces those as a `malformed_plan` refusal and
 *     terminates cleanly.
 *
 *   - Each operator runs at most once. The total number of dispatches is
 *     bounded by |operators| AND by `plan.maxRounds` (DEFAULT_MAX_ROUNDS).
 *     Exceeding the cap returns a `round_cap_exceeded` refusal.
 *
 *   - A `refuse` node terminates the walk: subsequent operators don't run.
 *     Any thrown error from an operator is captured as a synthetic
 *     `operator_failure` refusal; the walk terminates and the packet
 *     surfaces the partial trace plus the refusal.
 *
 * Telemetry:
 *
 *   - The whole walk is wrapped in span('plan.execute', ...) so per-operator
 *     spans (already emitted inside each operator's body) become its
 *     children via AsyncLocalStorage.
 *   - A single recordDecision('plan_executed') is emitted at the end with
 *     summary fields (rooted query, operator count, refused).
 *
 * Output:
 *
 *   - `facts` = output of the root operator.
 *   - `graphPaths` = (subject, predicate, object) tuples derived from facts
 *     whose predicate is non-null (Stage 1 emits single-hop paths only).
 *   - `temporalTimeline` = facts that have a valid_from date.
 *   - `evidenceSpans` = each fact pointing back at its source memory id.
 *   - `unresolvedQuestions` = [query] when the planner succeeded but the
 *     executor returned an empty fact set (locked decision D2).
 *   - `calibratedConfidence` = null (locked decision D4; Wedge 4 owns).
 */

import { span, recordDecision } from '../telemetry/index.js';
import type { IMemoryRepository } from '../repository/interface.js';
import { dispatchOperator } from './operators/index.js';
import type { OperatorContext } from './operators/context.js';
import {
  DEFAULT_MAX_ROUNDS,
  type AssertionTriple,
  type ExecutionTraceEntry,
  type GraphPath,
  type MemoryPacket,
  type Operator,
  type OperatorId,
  type PacketRefusal,
  type Plan,
  type RefusalReason,
  type TemporalTimelineEntry,
} from './types.js';

export interface ExecutePlanOptions {
  /** Query string the plan was generated from. Surfaced in `unresolvedQuestions` on empty execution. */
  query: string;
  nowIso: string;
  userId: string;
  /** Override `plan.maxRounds`. Falls back to `plan.maxRounds`, then `DEFAULT_MAX_ROUNDS`. */
  maxRounds?: number;
}

/**
 * Execute a plan against the repository. Returns a MemoryPacket.
 *
 * Never throws on operator failure or malformed plans: failures become
 * structured refusals on the returned packet. Throws only on truly
 * exceptional conditions (e.g., the repository is closed).
 */
export async function executePlan(
  plan: Plan,
  repo: IMemoryRepository,
  opts: ExecutePlanOptions,
): Promise<MemoryPacket> {
  return span(
    'plan.execute',
    async () => {
      const maxRounds = opts.maxRounds ?? plan.maxRounds ?? DEFAULT_MAX_ROUNDS;
      const trace: ExecutionTraceEntry[] = [];
      const refusals: PacketRefusal[] = [];

      // Validate + topo-sort. Either step may surface a malformed plan.
      let order: OperatorId[];
      try {
        validatePlan(plan);
        order = plan.topo ?? topoSort(plan);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        refusals.push({ operator_id: plan.root, reason: 'malformed_plan', detail });
        emitDecision(plan, refusals, trace);
        return emptyPacket(opts.query, trace, refusals);
      }

      if (order.length > maxRounds) {
        refusals.push({
          operator_id: plan.root,
          reason: 'round_cap_exceeded',
          detail: `plan has ${order.length} operators; cap is ${maxRounds}`,
        });
        emitDecision(plan, refusals, trace);
        return emptyPacket(opts.query, trace, refusals);
      }

      const outputs = new Map<OperatorId, AssertionTriple[]>();
      const ctx: OperatorContext = {
        repo,
        upstream: outputs,
        nowIso: opts.nowIso,
        userId: opts.userId,
      };

      for (const opId of order) {
        const op = plan.operators[opId];
        // validatePlan guarantees this; the !op check is defensive.
        if (!op) {
          refusals.push({ operator_id: opId, reason: 'malformed_plan', detail: 'missing operator node' });
          break;
        }

        // Explicit refuse node: surface it and stop.
        if (op.kind === 'refuse') {
          refusals.push({ operator_id: op.id, reason: op.reason, detail: op.detail });
          trace.push(makeTraceEntry(op, 0, [], true));
          break;
        }

        const start = Date.now();
        let rows: AssertionTriple[] = [];
        let refused = false;
        try {
          rows = await dispatchOperator(op, ctx);
        } catch (err) {
          refused = true;
          const detail = err instanceof Error ? err.message : String(err);
          refusals.push({ operator_id: op.id, reason: 'operator_failure', detail });
        }

        const duration_ms = Date.now() - start;
        trace.push(makeTraceEntry(op, duration_ms, rows, refused));
        outputs.set(op.id, rows);

        if (refused) break;
      }

      const rootRows = outputs.get(plan.root) ?? [];
      emitDecision(plan, refusals, trace);

      // D2: planner succeeded but executor returned empty → surface, do not fall back.
      // (The shim is the one that distinguishes "planner declined" from "planner+executor returned empty".)
      const unresolvedQuestions = rootRows.length === 0 && refusals.length === 0 ? [opts.query] : [];

      return {
        executionTrace: trace,
        facts: rootRows,
        graphPaths: buildGraphPaths(rootRows),
        conflicts: [],
        temporalTimeline: buildTimeline(rootRows),
        evidenceSpans: rootRows.map((t) => ({ assertion_id: t.assertion_id, sourceMemoryId: t.assertion_id })),
        refusals,
        unresolvedQuestions,
        calibratedConfidence: null,
      };
    },
    {
      plan_root: plan.root,
      operator_count: Object.keys(plan.operators).length,
      query_type: plan.queryType,
    },
  );
}

// ---------------------------------------------------------------------------
// Plan validation + topo sort
// ---------------------------------------------------------------------------

/**
 * Validate the plan's structural invariants:
 *  - root must exist in `operators`
 *  - every operator's input refs must exist in `operators`
 *  - no operator references itself
 *
 * Cycle detection is in `topoSort` (the DFS naturally fires on back-edges).
 */
export function validatePlan(plan: Plan): void {
  if (!plan.operators[plan.root]) {
    throw new Error(`plan.root '${plan.root}' not found in operators`);
  }
  for (const [id, op] of Object.entries(plan.operators)) {
    if (op.id !== id) {
      throw new Error(`operator key '${id}' does not match node id '${op.id}'`);
    }
    for (const ref of refsOf(op)) {
      if (ref === op.id) throw new Error(`operator '${op.id}' references itself`);
      if (!plan.operators[ref]) throw new Error(`operator '${op.id}' references unknown id '${ref}'`);
    }
  }
}

function refsOf(op: Operator): OperatorId[] {
  switch (op.kind) {
    case 'lookup':
    case 'refuse':
      return [];
    case 'join':
      return [op.left, op.right];
    case 'filter':
    case 'aggregate':
    case 'temporal':
      return [op.input];
  }
}

/**
 * Topological sort by Kahn's algorithm. Inputs come before consumers; root
 * is last. Throws on cycle.
 */
export function topoSort(plan: Plan): OperatorId[] {
  const indegree = new Map<OperatorId, number>();
  const adjacency = new Map<OperatorId, OperatorId[]>();
  for (const id of Object.keys(plan.operators)) {
    indegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const [id, op] of Object.entries(plan.operators)) {
    for (const ref of refsOf(op)) {
      adjacency.get(ref)!.push(id);
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
    }
  }

  const ready: OperatorId[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) ready.push(id);
  ready.sort(); // stable order for reproducibility

  const out: OperatorId[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    out.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const newDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newDeg);
      if (newDeg === 0) ready.push(next);
    }
    ready.sort();
  }

  if (out.length !== Object.keys(plan.operators).length) {
    throw new Error('plan contains a cycle');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packet assembly helpers
// ---------------------------------------------------------------------------

function buildGraphPaths(rows: AssertionTriple[]): GraphPath[] {
  const out: GraphPath[] = [];
  for (const t of rows) {
    if (t.predicate !== null && t.object !== null) {
      out.push({ from: t.subject, predicate: t.predicate, to: t.object });
    }
  }
  return out;
}

function buildTimeline(rows: AssertionTriple[]): TemporalTimelineEntry[] {
  const out: TemporalTimelineEntry[] = [];
  for (const t of rows) {
    if (t.valid_from !== null) {
      out.push({ valid_from: t.valid_from, assertion_id: t.assertion_id });
    }
  }
  // Stable chronological order, oldest first.
  return out.sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : 0));
}

function makeTraceEntry(
  op: Operator,
  duration_ms: number,
  rows: AssertionTriple[],
  refused: boolean,
): ExecutionTraceEntry {
  return {
    operator_id: op.id,
    kind: op.kind,
    duration_ms,
    llm_calls: 0,
    db_rows_scanned: op.kind === 'lookup' ? rows.length : 0,
    cache_hits: 0,
    cache_misses: 0,
    result_size: rows.length,
    refused,
  };
}

function emptyPacket(query: string, trace: ExecutionTraceEntry[], refusals: PacketRefusal[]): MemoryPacket {
  return {
    executionTrace: trace,
    facts: [],
    graphPaths: [],
    conflicts: [],
    temporalTimeline: [],
    evidenceSpans: [],
    refusals,
    unresolvedQuestions: refusals.length === 0 ? [query] : [],
    calibratedConfidence: null,
  };
}

function emitDecision(plan: Plan, refusals: PacketRefusal[], trace: ExecutionTraceEntry[]): void {
  // Summary decision row so dashboards can count plans, refusal kinds,
  // and operator counts without parsing spans.
  const refusalReasons: RefusalReason[] = refusals.map((r) => r.reason);
  recordDecision({
    decision_type: 'plan_executor',
    branch_taken: refusals.length === 0 ? 'success' : refusalReasons.join(','),
    inputs: {
      plan_root: plan.root,
      operator_count: Object.keys(plan.operators).length,
      query_type: plan.queryType,
    },
    outcome: refusals.length === 0 ? 'success' : 'refused',
    duration_ms: trace.reduce((s, t) => s + t.duration_ms, 0),
  });
}
