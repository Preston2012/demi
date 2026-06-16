/**
 * Wedge 2: Plan Executor V1, core types.
 *
 * The shapes here are the substrate Wedges 3 (Materializer) and 4 (Calibrated
 * Adjudicator) compose on top of. Three concerns live in this file:
 *
 *   1. The row shape persisted to the new `assertion_triples` table
 *      (see src/repository/sqlite/migrations.ts).
 *   2. The typed DSL plan: a flat dictionary of operator nodes (discriminated
 *      union over `kind`) referenced by string id. Plans are JSON-serializable
 *      so they can be persisted into telemetry spans and replayed.
 *   3. The `MemoryPacket` returned by the executor, which the shim in
 *      src/retrieval/plan-shim.ts adapts back into the existing `SearchResult`
 *      shape for `dispatch.search`.
 *
 * Nothing in this file executes; it is pure types + constants.
 */

// ----------------------------------------------------------------------------
// Row shape
// ----------------------------------------------------------------------------

/**
 * One row of the `assertion_triples` table.
 *
 * Hybrid extraction (D1 in the wedge plan): every assertion produces at least
 * one row. When the deterministic decomposer in src/plan/triples.ts matches a
 * pattern, `predicate` + `object` are populated and `object_literal` is null.
 * On a miss, the row is a fallback: `predicate` and `object` are null and
 * `object_literal` carries the original claim text. The schema CHECK enforces
 * `predicate IS NOT NULL OR object_literal IS NOT NULL`.
 */
export interface AssertionTriple {
  /** FK → memories.id (ON DELETE CASCADE). */
  assertion_id: string;
  /** Normalized: lowercased + trimmed. */
  subject: string;
  /** Null on fallback rows. */
  predicate: string | null;
  /** Null on fallback rows OR when the right-hand-side is a literal. */
  object: string | null;
  /** Populated on fallback (= original claim) or when RHS is free text. */
  object_literal: string | null;
  valid_from: string | null;
  valid_to: string | null;
  /** Mirrors memories.confidence at insert time. */
  confidence: number | null;
  /**
   * UUID of the cluster anchor, the lexicographically-lowest assertion_id
   * in the conflict cluster (or this row's own assertion_id when the row
   * has no conflicts). Equality-indexed via idx_triple_conflict so
   * "give me every triple in this conflict cluster" is O(log n).
   */
  conflict_set_id: string | null;
}

// ----------------------------------------------------------------------------
// Plan tree
// ----------------------------------------------------------------------------

/** Stable per-plan id; referenced by `Join.left`, `Filter.input`, etc. */
export type OperatorId = string;

export type RefusalReason =
  | 'out_of_coverage'
  | 'empty_after_plan'
  | 'round_cap_exceeded'
  | 'operator_failure'
  | 'malformed_plan';

export type Operator = Lookup | Join | Filter | Aggregate | Temporal | Refuse;

/**
 * Fetch assertions by subject + predicate, by entity-only (predicate=null),
 * or by predicate-only (entity=undefined). `direction` selects which index
 * to probe; default 'sp' (subject+predicate).
 */
export interface Lookup {
  kind: 'lookup';
  id: OperatorId;
  /** Entity to look up. Undefined → predicate-only scan via idx_triple_op. */
  entity?: string;
  /** Null → all predicates for this entity (fallback rows included). */
  predicate: string | null;
  /** Which index to probe. Default 'sp'. */
  direction?: 'sp' | 'op';
}

/**
 * Relational join over two upstream operator outputs. The graph-hop case is
 * 'object=subject': left.object equals right.subject. The other modes cover
 * set intersection and reverse-graph traversal.
 */
export interface Join {
  kind: 'join';
  id: OperatorId;
  left: OperatorId;
  right: OperatorId;
  on: 'object=subject' | 'subject=subject' | 'object=object' | 'subject=object';
}

/** Boolean filter over an assertion set. */
export interface Filter {
  kind: 'filter';
  id: OperatorId;
  input: OperatorId;
  predicate:
    | { type: 'predicate_eq'; value: string }
    | { type: 'subject_eq'; value: string }
    | { type: 'object_eq'; value: string }
    | { type: 'confidence_gte'; value: number };
}

/** Count / min / max / sum reducer. */
export interface Aggregate {
  kind: 'aggregate';
  id: OperatorId;
  input: OperatorId;
  fn: 'count' | 'min' | 'max' | 'sum';
  field?: 'confidence' | 'valid_from' | 'valid_to';
}

/** Bi-temporal slice or sort over `valid_from` / `valid_to`. */
export interface Temporal {
  kind: 'temporal';
  id: OperatorId;
  input: OperatorId;
  op:
    | { type: 'as_of'; iso: string }
    | { type: 'range'; from?: string; to?: string }
    | { type: 'order'; field: 'valid_from' | 'valid_to'; direction: 'asc' | 'desc' };
}

/** Terminating refusal. Executes to a structured position; nothing downstream runs. */
export interface Refuse {
  kind: 'refuse';
  id: OperatorId;
  reason: RefusalReason;
  detail?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Typed plan. Operators stored in a flat map keyed by id; tree shape is
 * encoded by operator inputs (Join.left/right, Filter.input, etc.).
 *
 * JSON-serializable. `topo` is an optional precomputed topological order;
 * the executor recomputes if absent.
 */
export interface Plan {
  version: 1;
  root: OperatorId;
  operators: Record<OperatorId, Operator>;
  /** Bounded-rounds cap. Default 10. */
  maxRounds: number;
  /** From src/retrieval/query-classifier.ts. */
  queryType: string;
  queryFeatures: {
    properNouns: string[];
    temporalMarkers: string[];
    multiHopHint: boolean;
  };
  topo?: OperatorId[];
}

// ----------------------------------------------------------------------------
// Execution trace + MemoryPacket
// ----------------------------------------------------------------------------

/**
 * One entry per operator invocation. Populated by the executor with the
 * closure-captured wall-clock duration and result size, the executor's
 * own record, distinct from telemetry spans (which are sampled).
 */
export interface ExecutionTraceEntry {
  operator_id: OperatorId;
  kind: Operator['kind'];
  duration_ms: number;
  /** Wedge 2: always 0 (no LLM at execute time). Wedge 4 may populate. */
  llm_calls: number;
  db_rows_scanned: number;
  cache_hits: number;
  cache_misses: number;
  result_size: number;
  refused: boolean;
}

export interface GraphPath {
  from: string;
  predicate: string;
  to: string;
}

export interface ConflictRecord {
  conflict_set_id: string;
  assertion_ids: string[];
}

export interface TemporalTimelineEntry {
  valid_from: string;
  assertion_id: string;
}

export interface EvidenceSpan {
  assertion_id: string;
  sourceMemoryId: string;
}

export interface PacketRefusal {
  operator_id: OperatorId;
  reason: RefusalReason;
  detail?: string;
}

/**
 * Native output of the plan executor. Wedges 3 + 5 consume this directly.
 * The shim adapts it back to the existing `SearchResult` shape for
 * `dispatch.search` and `dispatch.answer` consumers.
 */
export interface MemoryPacket {
  executionTrace: ExecutionTraceEntry[];
  /** Primary payload. Empty when no plan matched any rows. */
  facts: AssertionTriple[];
  graphPaths: GraphPath[];
  conflicts: ConflictRecord[];
  temporalTimeline: TemporalTimelineEntry[];
  evidenceSpans: EvidenceSpan[];
  refusals: PacketRefusal[];
  /** Populated when planner succeeded but executor returned empty (D2). */
  unresolvedQuestions: string[];
  /** Wedge 4 will populate. Wedge 2 always sets null (D4). */
  calibratedConfidence: number | null;
}

// ----------------------------------------------------------------------------
// Default cap
// ----------------------------------------------------------------------------

/**
 * Bounded-rounds executor cap. Stage 1 plans are 1-4 operators; the cap exists
 * to bound future planner bugs and adversarial inputs, not to limit Stage 1.
 */
export const DEFAULT_MAX_ROUNDS = 10;
