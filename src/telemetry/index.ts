/**
 * Wedge 1.5 Phase 1: telemetry module public API.
 *
 * Single import surface for the rest of the codebase. Phase 1 explicitly
 * does NOT import this from any production code yet (verification step
 * in the packet checks this). Phase 2 wires it into dispatch.search/
 * answer/ingest.
 */

export type {
  Trace,
  Span,
  Tags,
  DecisionEvent,
  ConflictEvent,
  RefusalEvent,
  LlmCallEvent,
  CacheEvent,
  AuthEvent,
  RateLimitEvent,
  ErrorEvent,
  DeprecationEvent,
  BodyEvent,
  RetrievalEvent,
  InjectionEvent,
  TelemetryEvent,
  SamplingDecision,
  IsoTimestamp,
  Uuid,
} from './types.js';

export { initStorage, getStorage, resetStorage, TelemetryStorage, newUuid } from './storage.js';

export type { StorageConfig } from './storage.js';

export {
  withTrace,
  span,
  spanSync,
  getActiveTrace,
  getActiveTraceId,
  recordDecision,
  recordRefusal,
  recordConflict,
  recordLlmCall,
  recordCacheEvent,
  recordError,
  recordBody,
  recordRetrieval,
  recordInjection,
  setTraceTags,
  setTraceUserId,
} from './trace.js';

export type { TraceContext } from './trace.js';

export { shouldSample, getSampleRate, DEFAULT_SAMPLING } from './sampling.js';

export { runTelemetryMigrations, pruneOldEvents } from './migrations.js';

// Wedge 1.5 Phase 3: read-side query layer.
export {
  queryTraces,
  queryDecisions,
  queryRefusals,
  queryCostByProvider,
  queryErrors,
  queryCacheHitRates,
  queryRateLimitSummary,
  queryPromGauges,
  pruneOlderThan,
} from './query.js';

export type {
  TimeWindow,
  TraceRow,
  DecisionRow,
  RefusalRow,
  CostRollup,
  ErrorRow,
  CacheHitRate,
  RateLimitSummary,
  PromGauges,
} from './query.js';

// Wedge 2 operator cost breakdown (lock criterion)
export { getOperatorCostBreakdown, getOperatorCostBreakdownWindow } from './operator-cost-breakdown.js';
export type { OperatorCostRow } from './operator-cost-breakdown.js';
