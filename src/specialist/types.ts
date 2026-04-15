/**
 * Specialist pre-processing types.
 *
 * S25 Council R16 (unanimous): offload deterministic reasoning to code.
 * This module defines the Intermediate Representation (IR) that all
 * specialists consume. Built once per query, consumed by all active specialists.
 *
 * Design principles:
 *   - Augment, don't replace (4/4 council unanimous)
 *   - IR built once, consumed by all specialists
 *   - Raw context always preserved alongside derived evidence
 *   - Fixed pipeline composition order
 */

import type { CompiledMemory } from '../schema/memory.js';
import type { QueryType } from '../retrieval/query-classifier.js';

// ---------------------------------------------------------------------------
// Normalized Fact (IR)
// ---------------------------------------------------------------------------

/** Certainty of an assertion. */
export type FactCertainty = 'asserted' | 'planned' | 'hypothetical' | 'conditional' | 'superseded' | 'negated';

/** A single normalized fact extracted from a memory claim. */
export interface NormalizedFact {
  /** Original memory ID for provenance. */
  memoryId: string;
  /** Subject entity (from memory record). */
  subject: string;
  /** Extracted predicate/relation (e.g., "lives_in", "favorite_restaurant", "visited"). */
  predicate: string;
  /** Extracted object/value (e.g., "Portland", "Rosa Mexicano", "Italy"). */
  object: string;
  /** ISO date or null. From validFrom or extracted from claim. */
  time: string | null;
  /** End of time range, if applicable. */
  timeEnd: string | null;
  /** Whether the fact is negated ("does NOT own", "never visited"). */
  negated: boolean;
  /** Assertion certainty. */
  certainty: FactCertainty;
  /** Relevance score from retrieval. */
  score: number;
  /** Original claim text (preserved for raw context). */
  sourceText: string;
}

// ---------------------------------------------------------------------------
// Operation Set (bitmask-style, per GPT council)
// ---------------------------------------------------------------------------

/** Operations a query requires. Multiple can be active. */
export interface RequiredOperations {
  extractFact: boolean;
  resolveTime: boolean;
  aggregateCount: boolean;
  enumerateSet: boolean;
  resolveLatestState: boolean;
  synthesizeSummary: boolean;
}

// ---------------------------------------------------------------------------
// Specialist Output
// ---------------------------------------------------------------------------

/** Output from any specialist. Appended to the evidence packet. */
export interface SpecialistOutput {
  /** Which specialist produced this. */
  source: 'temporal' | 'single-hop' | 'list-enum' | 'count-agg' | 'recency' | 'cross-ref' | 'summarizer';
  /** Structured derived evidence (formatted for injection). */
  derivedEvidence: string;
  /** Facts consumed by this specialist (by memoryId). */
  factsUsed: string[];
  /** Processing time in ms. */
  processingMs: number;
}

// ---------------------------------------------------------------------------
// Evidence Packet (final output to answer model)
// ---------------------------------------------------------------------------

/**
 * Dual-channel evidence packet.
 * Council unanimous: keep raw memories, add derived evidence alongside.
 */
export interface EvidencePacket {
  /** Query that produced this packet. */
  query: string;
  /** Classified query type. */
  queryType: QueryType;
  /** Inferred operations needed. */
  operations: RequiredOperations;
  /** Normalized facts (IR). */
  facts: NormalizedFact[];
  /** Specialist outputs (derived evidence). */
  specialistOutputs: SpecialistOutput[];
  /** Original compiled memories (raw evidence, always preserved). */
  rawMemories: CompiledMemory[];
  /** Total specialist processing time. */
  totalSpecialistMs: number;
}

// ---------------------------------------------------------------------------
// Specialist Interface
// ---------------------------------------------------------------------------

/** All specialists implement this interface. */
export interface Specialist {
  /** Name for logging. */
  name: string;
  /** Whether this specialist should run for the given operations. */
  shouldRun(ops: RequiredOperations): boolean;
  /** Process facts and produce derived evidence. */
  process(facts: NormalizedFact[], query: string, queryType: QueryType): SpecialistOutput;
}
