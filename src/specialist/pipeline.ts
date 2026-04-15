/**
 * Specialist pipeline.
 *
 * Fixed composition order (Council R16, 4/4 unanimous):
 *   1. Recency Resolver
 *   2. Temporal Specialist
 *   3. Count Aggregator
 *   4. List Enumerator
 *   5. Single-Hop Fact Extractor
 *   6. Cross-Reference (multi-hop entity intersection)
 *
 * Key principles:
 *   - Augment, don't replace (4/4 unanimous)
 *   - Loose budget BEFORE specialists, tight AFTER (3/4)
 *   - Each specialist appends to the evidence packet, never overwrites
 *   - Raw memories always preserved
 *   - Total specialist overhead target: p50 <40ms, p95 <120ms
 */

import type { CompiledMemory } from '../schema/memory.js';
import type { QueryType } from '../retrieval/query-classifier.js';
import type { EvidencePacket, NormalizedFact, Specialist, SpecialistOutput } from './types.js';
import { buildIR } from './ir.js';
import { createLogger } from '../config.js';
import { recencyResolverSpecialist } from "./recency.js";
import { temporalSpecialist } from "./temporal.js";
import { crossReferenceSpecialist } from "./cross-ref.js";
import { listEnumeratorSpecialist } from "./list-enum.js";
import { countAggregatorSpecialist } from "./count-agg.js";
import { singleHopSpecialist } from "./single-hop.js";

const log = createLogger('specialist-pipeline');

// ---------------------------------------------------------------------------
// Specialist Registry
// ---------------------------------------------------------------------------

const specialists: Specialist[] = [];

export function registerSpecialist(specialist: Specialist): void {
  specialists.push(specialist);
  log.info({ name: specialist.name, position: specialists.length }, 'Specialist registered');
}

// ---------------------------------------------------------------------------
// Pipeline Execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// S27 fix #14: Conflict Arbitration (post-specialist)
// Priority: recency > temporal > cross-ref > list > count > single-hop
// If recency marks a fact SUPERSEDED, remove it from single-hop BEST MATCH
// and any other specialist that promotes it.
// ---------------------------------------------------------------------------

function resolveConflicts(outputs: SpecialistOutput[], facts: NormalizedFact[]): void {
  // Step 1: Collect superseded memory IDs from recency output
  const supersededIds = new Set<string>();
  const recencyOutput = outputs.find(o => o.source === 'recency');
  if (recencyOutput) {
    // Parse [SUPERSEDED] tags from recency output
    const lines = recencyOutput.derivedEvidence.split("\n");
    for (const line of lines) {
      if (line.includes('[SUPERSEDED]')) {
        // Extract memory ID from format: [SUPERSEDED] value (date) [memId]
        const idMatch = line.match(/\[(mem_[a-f0-9-]+|[a-f0-9-]{36})\]/);
        if (idMatch) supersededIds.add(idMatch[1]!);
      }
    }
  }

  // Also collect from facts array (recency mutates certainty in Stage 3 fix #13)
  for (const fact of facts) {
    if (fact.certainty === 'superseded') {
      supersededIds.add(fact.memoryId);
    }
  }

  if (supersededIds.size === 0) return;

  // Step 2: Scan other specialist outputs and annotate conflicts
  for (const output of outputs) {
    if (output.source === 'recency') continue; // recency is the authority

    let modified = false;
    let evidence = output.derivedEvidence;

    // Check if any BEST MATCH or promoted fact is superseded
    for (const id of supersededIds) {
      if (evidence.includes(id)) {
        // If single-hop BEST MATCH references a superseded fact, flag it
        if (output.source === 'single-hop' && evidence.includes('BEST MATCH') && evidence.includes(id)) {
          evidence = evidence.replace(
            /BEST MATCH:.*$/m,
            'BEST MATCH: [CONFLICT — this fact was superseded by a more recent update. See RECENCY STATE RESOLUTION above.]'
          );
          modified = true;
        }
        // For any specialist: annotate superseded references
        if (!modified) {
          evidence = evidence + "\n[NOTE: Some facts referenced above have been superseded. Defer to RECENCY STATE RESOLUTION.]";
          modified = true;
        }
      }
    }

    if (modified) {
      output.derivedEvidence = evidence;
    }
  }
}

export function runSpecialistPipeline(
  memories: CompiledMemory[],
  query: string,
  queryType: QueryType,
): EvidencePacket {
  const pipelineStart = performance.now();

  const { facts, operations } = buildIR(memories, query, queryType);

  const specialistOutputs: SpecialistOutput[] = [];

  for (const specialist of specialists) {
    if (!specialist.shouldRun(operations)) continue;

    try {
      const start = performance.now();
      const output = specialist.process(facts, query, queryType);
      output.processingMs = performance.now() - start;

      // Skip empty evidence (specialist had nothing to contribute)
      if (!output.derivedEvidence || output.derivedEvidence.trim().length === 0) continue;

      specialistOutputs.push(output);

      log.debug({
        specialist: specialist.name,
        ms: output.processingMs.toFixed(1),
        factsUsed: output.factsUsed.length,
      }, 'Specialist completed');
    } catch (err) {
      log.warn({ specialist: specialist.name, err }, 'Specialist failed (non-critical, skipping)');
    }
  }

  const totalSpecialistMs = performance.now() - pipelineStart;

  if (totalSpecialistMs > 120) {
    log.warn({ totalMs: totalSpecialistMs.toFixed(1) }, 'Specialist pipeline exceeded p95 target (120ms)');
  }

  // S27 fix #14: resolve conflicts between specialist outputs
  resolveConflicts(specialistOutputs, facts);

  return {
    query,
    queryType,
    operations,
    facts,
    specialistOutputs,
    rawMemories: memories,
    totalSpecialistMs,
  };
}

// ---------------------------------------------------------------------------
// Evidence Packet Formatting
// ---------------------------------------------------------------------------

// S27 fix #15: Raw memories first, computed evidence last.
// LLMs have recency bias in attention. Computed evidence (specialist resolutions)
// goes LAST so it gets privileged attention and overrides any raw memory contradictions.
export function formatEvidencePacket(packet: EvidencePacket): string {
  const sections: string[] = [];

  // Raw memories first (context, but lower priority)
  sections.push('[MEMORY EVIDENCE]');
  for (let i = 0; i < packet.rawMemories.length; i++) {
    const mem = packet.rawMemories[i]!;
    sections.push(`M${i + 1} [${mem.subject}]: ${mem.claim}`);
  }

  // Computed evidence last (specialist resolutions, highest priority)
  if (packet.specialistOutputs.length > 0) {
    sections.push('');
    sections.push('[COMPUTED EVIDENCE — use these resolved values over raw memories above]');
    for (const output of packet.specialistOutputs) {
      sections.push(output.derivedEvidence);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Pipeline Initialization
// ---------------------------------------------------------------------------

export function isSpecialistPipelineEnabled(): boolean {
  return process.env.SPECIALIST_ROUTING === 'true';
}

/**
 * Pipeline order (S27 Council R17 reorder):
 *   1. Recency Resolver (MUST be first — mutates facts array certainty)
 *   2. Temporal Specialist
 *   3. Cross-Reference (before list/count/single-hop for multi-entity context)
 *   4. List Enumerator
 *   5. Count Aggregator (operates on canonicalized list items)
 *   6. Single-Hop Fact Extractor (last — benefits from all prior context)
 */
export function initializeSpecialists(): void {
  specialists.length = 0;

  try {
    
    registerSpecialist(recencyResolverSpecialist);

    
    registerSpecialist(temporalSpecialist);

    
    registerSpecialist(crossReferenceSpecialist);

    
    registerSpecialist(listEnumeratorSpecialist);

    
    registerSpecialist(countAggregatorSpecialist);

    
    registerSpecialist(singleHopSpecialist);

    log.info({ count: specialists.length }, 'Specialist pipeline initialized');
  } catch (err) {
    log.error({ err }, 'Failed to initialize specialists');
  }
}
