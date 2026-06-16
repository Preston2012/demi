/**
 * Per-query routing classifier.
 *
 * Lock: docs/internal/LOCK_ROUTING_CHAINS_PACKET.md (S77).
 *
 * Classifies an incoming query into a routing cell. The four answer cells are
 * mapped by queryType; coding queries are detected by pure regex (no LLM, the
 * cost doctrine #2579/#2580 forbids it) and win over queryType. queryType is
 * already classified upstream, and coding detection is local regex that meets
 * the <10ms p99 routing SLO trivially.
 *
 * Flag: QUERY_ROUTING_CLASSIFIER_ENABLED is default-ON (routing is the
 * product; a bare clone runs it). Disable coding detection with the explicit
 * `=false` escape hatch (I-277/A-162: `!== 'false'`, never `=== 'false'`).
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { Cell } from '../llm/cells.js';
import { recordDecision } from '../telemetry/index.js';

// Classifier-collapse (S77): single-hop and multi-hop are indistinguishable at
// the question and both best-served by mini, so the single-hop + reasoning
// answer cells merge into one conversational cell. queryType still drives
// retrieval (bridge / statePack / timeline / brute-force / summaries), so it
// still matters; only the answer-model split collapses.
const CONVERSATIONAL_TYPES: ReadonlySet<QueryType> = new Set([
  'single-hop',
  'current-state',
  'coverage',
  'summarization',
  'multi-hop',
  'open-domain',
]);
const TEMPORAL_TYPES: ReadonlySet<QueryType> = new Set(['temporal', 'temporal-multi-hop']);
const SYNTHESIS_TYPES: ReadonlySet<QueryType> = new Set(['synthesis', 'narrative']);

export type CodingWeight = 'none' | 'light' | 'heavy';

// Strong, unambiguous code symbols: fences, arrow fns, call syntax, member
// access, statement terminators, console. Deliberately NOT bare English words
// like "class"/"return"/"import" (those false-positive on natural questions).
const CODE_SYMBOLS = /```|=>|;\s*$|\bconsole\.|\w+\.\w+\(|\b\w+\(\)/;

// A coding verb paired with a code-domain noun. Tested on the lowercased query.
const CODING_VERB =
  /\b(write|implement|refactor|debug|fix|optimi[sz]e|compile|build|patch|rewrite|generate|add|create)\b[\s\S]*\b(code|function|method|class|script|module|component|api|endpoint|regex|algorithm|parser|compiler|server|handler|query|test|bug|check|null|exception)\b/;

// A source-file extension reference (".ts", ".py", ...).
const FILE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|cc|c|h|rb|sql|sh|yaml|yml|json|php|swift|kt|scala)\b/;

// Stack-trace / runtime-error fingerprints. The CamelCase form (TypeError,
// NullPointerException) is matched on the original casing.
const STACK_TRACE_LOWER =
  /\b(traceback|stack ?trace|undefined is not|cannot read propert|null pointer|segfault|segmentation fault)\b/;
const STACK_TRACE_CAMEL = /[A-Za-z]\w*(Error|Exception)\b/;

// Heavy markers: architectural / multi-file / algorithmic / large-scope work.
// Presence of any of these is itself sufficient to mark a query as coding
// (heavy), so "design a distributed rate limiter" routes to heavy-coding even
// though "design" is not in the coding-verb list. Note: no trailing word
// boundary on the group, because several markers are prefixes of longer words
// (migrat -> migrate/migration, paralleli[sz] -> parallelize, concurren ->
// concurrent/concurrency, scalab -> scalability).
const HEAVY_MARKERS =
  /\b(architect|architecture|system design|distributed|microservice|multi-?file|across (files|modules|the codebase|services)|entire[\s\S]*?(codebase|module|system|app|project|service)|whole[\s\S]*?(codebase|module|system|app|project)|migrat|concurren|paralleli[sz]|scalab|optimi[sz]e the algorithm|refactor (the|this) (entire|whole))/;

/**
 * Classify a query's coding weight. Pure, deterministic, no LLM. Returns
 * 'none' for non-code queries, 'light' for routine code (small functions,
 * edits, glue), 'heavy' for architectural / multi-file / algorithmic work.
 */
export function detectCoding(query: string): CodingWeight {
  const q = query.toLowerCase();
  const heavy = HEAVY_MARKERS.test(q);
  const isCoding =
    heavy ||
    CODE_SYMBOLS.test(q) ||
    CODING_VERB.test(q) ||
    FILE_EXT.test(q) ||
    STACK_TRACE_LOWER.test(q) ||
    STACK_TRACE_CAMEL.test(query);
  if (!isCoding) return 'none';
  return heavy ? 'heavy' : 'light';
}

/**
 * Route a query to a cell.
 *
 * Coding detection (light/heavy) fires unless QUERY_ROUTING_CLASSIFIER_ENABLED
 * is explicitly `=false`, and wins over queryType: the answer-quality cliff for
 * code on a non-coding model is steeper than for multi-hop reasoning on a
 * coding model. Otherwise queryType maps to one of the four answer cells.
 *
 * `query` is optional: callers that only have the queryType (e.g. the legacy
 * routeAnswerModel signature, bench runners) pass none, so coding detection is
 * inert and the answer cell is chosen purely by queryType.
 */
export function routeToCell(queryType: QueryType, query: string = ''): Cell {
  const codingOn = process.env.QUERY_ROUTING_CLASSIFIER_ENABLED !== 'false';

  if (codingOn && query) {
    const coding = detectCoding(query);
    if (coding === 'heavy') return record('heavy-coding', queryType, coding);
    if (coding === 'light') return record('light-coding', queryType, coding);
  }

  if (TEMPORAL_TYPES.has(queryType)) return record('temporal-answer', queryType, 'none');
  if (SYNTHESIS_TYPES.has(queryType)) return record('synthesis-answer', queryType, 'none');
  if (CONVERSATIONAL_TYPES.has(queryType)) return record('conversational-answer', queryType, 'none');

  // All 10 QueryType values are mapped above; default for safety.
  return record('conversational-answer', queryType, 'none');
}

function record(cell: Cell, queryType: QueryType, coding: CodingWeight): Cell {
  recordDecision({
    decision_type: 'query_route_cell',
    branch_taken: cell,
    inputs: { queryType, coding },
  });
  return cell;
}
