/**
 * Operator-level cost telemetry helper.
 *
 * Wraps span() for plan operators, adding a result_count tag derived
 * from the operator output length. Makes per-operator cost queryable
 * post-hoc from the spans table:
 *
 *   SELECT
 *     json_extract(tags, '$.kind') AS op_kind,
 *     COUNT(*) AS call_count,
 *     SUM(duration_ms) AS total_ms,
 *     SUM(CAST(json_extract(tags, '$.result_count') AS INTEGER)) AS total_rows
 *   FROM spans
 *   WHERE trace_id = ? AND name LIKE 'plan.%'
 *   GROUP BY op_kind;
 *
 * Wedge 2 lock criterion: "Telemetry shows operator-level cost breakdown".
 *
 * span() already captures duration_ms (latency). result_count is the
 * cheap output-size dimension. LLM calls are recorded separately via
 * recordLlmCall in llm-call paths; no plan operator directly calls an
 * LLM today.
 *
 * Implementation: span() reads the tags object after fn() resolves and
 * before enqueue. Mutating the object inside the wrapped fn captures
 * the result count before the event is enqueued. The mutation is
 * confined to a local copy of the caller-supplied tags so the caller
 * does not see the result_count append.
 */
import type { AssertionTriple } from '../types.js';
import { span } from '../../telemetry/index.js';
import type { Tags } from '../../telemetry/types.js';

export async function operatorSpan(
  name: string,
  fn: () => Promise<AssertionTriple[]>,
  baseTags: Tags,
): Promise<AssertionTriple[]> {
  const tags: Tags = { ...baseTags };
  return span(
    name,
    async () => {
      const result = await fn();
      tags.result_count = result.length;
      return result;
    },
    tags,
  );
}
