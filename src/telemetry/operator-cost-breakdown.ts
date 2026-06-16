/**
 * Operator cost breakdown queries.
 *
 * Wedge 2 lock criterion deliverable. Aggregates plan operator spans by
 * `kind` for cost analysis. Sources from the live spans table populated
 * by operatorSpan() in src/plan/operators/operator-span.ts.
 *
 * Usage:
 *   const breakdown = getOperatorCostBreakdown(db, traceId);
 *   // breakdown = [
 *   //   { op_kind: 'Lookup',    call_count: 4, total_ms: 12, avg_ms: 3.0, total_rows: 220 },
 *   //   { op_kind: 'Join',      call_count: 2, total_ms: 8,  avg_ms: 4.0, total_rows: 18 },
 *   //   ...
 *   // ]
 *
 * Returns one row per operator kind that fired at least once during the
 * trace. Sorted by total_ms descending so the bottleneck operator is on
 * top.
 */
import type Database from 'better-sqlite3-multiple-ciphers';

export interface OperatorCostRow {
  op_kind: string;
  call_count: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  total_rows: number;
}

/**
 * Per-operator cost breakdown for a single trace.
 *
 * Returns empty array if the trace has no plan operator spans (legacy
 * retrieval path, no plan executor activity).
 */
export function getOperatorCostBreakdown(db: Database.Database, traceId: string): OperatorCostRow[] {
  const rows = db
    .prepare(
      `
      SELECT
        json_extract(tags, '$.kind') AS op_kind,
        COUNT(*) AS call_count,
        SUM(duration_ms) AS total_ms,
        AVG(duration_ms) AS avg_ms,
        MAX(duration_ms) AS max_ms,
        COALESCE(
          SUM(CAST(json_extract(tags, '$.result_count') AS INTEGER)),
          0
        ) AS total_rows
      FROM spans
      WHERE trace_id = ?
        AND name LIKE 'plan.%'
        AND json_extract(tags, '$.kind') IS NOT NULL
      GROUP BY op_kind
      ORDER BY total_ms DESC
      `,
    )
    .all(traceId) as Array<{
    op_kind: string;
    call_count: number;
    total_ms: number;
    avg_ms: number;
    max_ms: number;
    total_rows: number;
  }>;

  return rows.map((r) => ({
    op_kind: r.op_kind,
    call_count: r.call_count,
    total_ms: r.total_ms,
    avg_ms: Math.round(r.avg_ms * 100) / 100,
    max_ms: r.max_ms,
    total_rows: r.total_rows,
  }));
}

/**
 * Cross-trace cost breakdown over a time window. Useful for
 * 'which operator is the system bottleneck this hour' queries.
 */
export function getOperatorCostBreakdownWindow(
  db: Database.Database,
  fromIso: string,
  toIso: string,
): OperatorCostRow[] {
  const rows = db
    .prepare(
      `
      SELECT
        json_extract(s.tags, '$.kind') AS op_kind,
        COUNT(*) AS call_count,
        SUM(s.duration_ms) AS total_ms,
        AVG(s.duration_ms) AS avg_ms,
        MAX(s.duration_ms) AS max_ms,
        COALESCE(
          SUM(CAST(json_extract(s.tags, '$.result_count') AS INTEGER)),
          0
        ) AS total_rows
      FROM spans s
      JOIN traces t ON t.trace_id = s.trace_id
      WHERE t.started_at >= ?
        AND t.started_at <  ?
        AND s.name LIKE 'plan.%'
        AND json_extract(s.tags, '$.kind') IS NOT NULL
      GROUP BY op_kind
      ORDER BY total_ms DESC
      `,
    )
    .all(fromIso, toIso) as Array<{
    op_kind: string;
    call_count: number;
    total_ms: number;
    avg_ms: number;
    max_ms: number;
    total_rows: number;
  }>;

  return rows.map((r) => ({
    op_kind: r.op_kind,
    call_count: r.call_count,
    total_ms: r.total_ms,
    avg_ms: Math.round(r.avg_ms * 100) / 100,
    max_ms: r.max_ms,
    total_rows: r.total_rows,
  }));
}
