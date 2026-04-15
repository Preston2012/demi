import type {
  InjectionPayload,
  CompiledMemory,
} from "../schema/memory.js";
import type { IMemoryRepository } from "../repository/interface.js";
import type { RetrievalResult } from "../retrieval/index.js";
import { detectAllConflicts, buildConflictTagMap } from "./conflict.js";
import { buildMetaMemoryHeader } from "./meta.js";
import { compileBudget } from "./budget.js";
import { buildTimeline } from "./timeline.js";
import { classifyQuery } from "../retrieval/query-classifier.js";
import { createLogger } from "../config.js";
import { normalizeTemporal } from "./temporal-normalize.js";
import { compressFacts, dedupFacts } from "./compress.js";

const log = createLogger("inject");

/**
 * Build injection payload from retrieval results.
 */
export function buildInjectionPayload(
  retrievalResult: RetrievalResult,
  maxRules: number = 15,
): InjectionPayload {
  const budget = compileBudget(retrievalResult.candidates, maxRules);
  const candidates = budget.candidates;

  if (budget.dropped.length > 0) {
    log.debug(
      { dropped: budget.dropped.length, allocation: budget.allocation },
      "Budget compiler active",
    );
  }

  const memories: CompiledMemory[] = candidates.map((c) => ({
    id: c.id,
    claim: normalizeTemporal(c.candidate.record.claim, c.candidate.record.validFrom),
    subject: c.candidate.record.subject,
    scope: c.candidate.record.scope,
    provenance: c.candidate.record.provenance,
    trustClass: c.candidate.record.trustClass,
    confidence: c.candidate.record.confidence,
    createdAt: c.candidate.record.createdAt,
    score: c.finalScore,
    slot: "fact" as const,
    position: "context" as const,
    compressed: false,
  }));

  // R12: Subject-grouped compression (reduces token count, preserves information)
  const compressed = dedupFacts(compressFacts(memories));

  const conflicts = detectAllConflicts(candidates);
  const conflictTagMap = buildConflictTagMap(candidates);
  const conflictTags = Object.fromEntries(conflictTagMap);

  if (conflicts.length > 0) {
    log.info(
      { conflictCount: conflicts.length, memoryCount: memories.length },
      "Conflicts detected in injection payload",
    );
  }

  return {
    knowledgeMap: null,
    memories: compressed,
    conflicts,
    conflictTags,
    inhibitions: [],
    metadata: {
      queryUsed: retrievalResult.metadata.query,
      candidatesEvaluated: retrievalResult.metadata.candidatesGenerated,
      retrievalTimeMs: retrievalResult.metadata.timings.totalMs,
      hubExpansions: 0,
      crossDomainHops: 0,
      inhibitionsSuppressed: 0,
      primingHits: 0,
      queryType: retrievalResult.metadata.queryType,
    },
  };
}

/**
 * Format injection payload with optional meta-memory header.
 */
export async function formatForContextWithMeta(
  payload: InjectionPayload,
  repo?: IMemoryRepository,
): Promise<string> {
  const lines: string[] = [];

  if (repo) {
    try {
      const meta = await buildMetaMemoryHeader(repo);
      lines.push("[" + meta + "]");
      lines.push("");
    } catch {
      // Meta-memory failure is non-critical
    }
  }

  lines.push(formatForContext(payload));
  return lines.join("\n");
}

type QueryFormatMode = "relevance" | "chronological" | "entity-grouped";

function detectFormatMode(query?: string): QueryFormatMode {
  if (!query) return "relevance";
  const q = query.toLowerCase();
  if (
    /\b(when|before|after|first|last|earlier|later|timeline|sequence|order|date|year|month)\b/.test(q)
  ) {
    return "chronological";
  }
  const names = query.match(/\b[A-Z][a-z]{2,}\b/g);
  const uniqueNames = names ? new Set(names).size : 0;
  if (uniqueNames >= 2) return "entity-grouped";
  return "relevance";
}

/**
 * U8: Build memory map header.
 */
function buildMemoryMap(memories: CompiledMemory[]): string {
  const subjectCounts = new Map<string, number>();
  for (const m of memories) {
    const subj = m.subject || "General";
    subjectCounts.set(subj, (subjectCounts.get(subj) || 0) + 1);
  }
  const sorted = Array.from(subjectCounts.entries()).sort((a, b) => b[1] - a[1]);
  const parts = sorted.map(function(entry) { return entry[1] + " about " + entry[0]; });
  return "[Memory: " + memories.length + " facts \u2014 " + parts.join(", ") + "]";
}

/**
 * U6: Build entity profiles from injected memories.
 * 2-3 sentence bio per subject from top claims.
 */
function buildEntityProfiles(memories: CompiledMemory[]): string {
  const bySubject = new Map<string, CompiledMemory[]>();
  for (const m of memories) {
    const subj = m.subject || "General";
    if (subj === "General" || subj.startsWith("hub:")) continue;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj)!.push(m);
  }

  if (bySubject.size === 0) return "";

  const lines: string[] = [];
  lines.push("[Entity Profiles]");

  for (const [subject, mems] of Array.from(bySubject.entries())) {
    if (mems.length < 3) continue;
    // Take top 5 by score for the bio
    const top = mems.slice().sort(function(a, b) { return b.score - a.score; }).slice(0, 5);
    const claims = top.map(function(m) { return m.claim; });
    lines.push(subject + " (" + mems.length + " facts): " + claims.join(". ") + ".");
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * P3: Get semantic label for a fact based on its rank position.
 */
function getSemanticLabel(rankPosition: number): string {
  if (rankPosition <= 5) return "KEY";
  if (rankPosition <= 15) return "SUPPORTING";
  return "";
}

/**
 * C9: Sandwich ordering.
 * Best facts at positions 1-5 and last 5.
 * Based on Liu et al. 2023 "Lost in the Middle."
 */
function applySandwichOrdering(memories: CompiledMemory[]): CompiledMemory[] {
  if (memories.length <= 10) return memories;

  // memories arrive sorted by score descending from budget compiler
  const top5 = memories.slice(0, 5);
  const bottom5 = memories.slice(-5);
  const middle = memories.slice(5, memories.length - 5);

  // Sandwich: top5, then middle (lower attention zone), then bottom5 (high attention again)
  return top5.concat(middle).concat(bottom5);
}

export function formatForContext(payload: InjectionPayload): string {
  if (payload.memories.length === 0) {
    return "";
  }

  // STRIP mode: raw facts only, no decoration
  if (process.env.STRIP_INJECTION === "true") {
    const stripLines: string[] = [];
    stripLines.push("--- Memory Context (" + payload.memories.length + " rules) ---");
    for (let i = 0; i < payload.memories.length; i++) {
      stripLines.push("[M" + (i+1) + "] " + payload.memories[i]!.claim);
    }
    stripLines.push("---");
    return stripLines.join("\n");
  }

  const lines: string[] = [];

  const hubs = payload.memories.filter(function(m) { return m.subject.startsWith("hub:"); });
  const procedural = payload.memories.filter(function(m) { return !m.subject.startsWith("hub:"); });

  // U8: Memory map header
  lines.push(buildMemoryMap(procedural));
  lines.push("");

  // U6: Entity profiles
  const profiles = buildEntityProfiles(procedural);
  if (profiles) {
    lines.push(profiles);
    lines.push("");
  }

  // U7: Timeline for temporal queries
  const queryType = payload.metadata.queryUsed
    ? classifyQuery(payload.metadata.queryUsed)
    : "single-hop";

  if (queryType === "temporal") {
    const { timeline } = buildTimeline(procedural);
    if (timeline) {
      lines.push(timeline);
      lines.push("");
    }
  }

  lines.push(
    "--- Memory Context (" + payload.memories.length + " rules) ---",
  );

  // Typed injection: hubs first
  if (hubs.length > 0) {
    lines.push("Principles:");
    for (const m of hubs) {
      lines.push("  - " + m.claim);
    }
    lines.push("");
  }

  const fmt = process.env.INJECT_FORMAT || "full";
  const formatMode = detectFormatMode(payload.metadata.queryUsed);

  // P3 + P2: Build rank map from original score order before any re-sorting
  const rankMap = new Map<CompiledMemory, number>();
  for (let i = 0; i < procedural.length; i++) {
    rankMap.set(procedural[i]!, i + 1);
  }

  // C9: Sandwich ordering for packed format
  let orderedProcedural = procedural;
  if (fmt === "packed" && formatMode === "relevance") {
    orderedProcedural = applySandwichOrdering(procedural);
  }

  let memId = 1;

  if (fmt === "packed") {
    if (formatMode === "chronological") {
      orderedProcedural.sort(function(a, b) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    } else if (formatMode === "entity-grouped") {
      orderedProcedural.sort(function(a, b) {
        const subjCmp = a.subject.localeCompare(b.subject);
        if (subjCmp !== 0) return subjCmp;
        return b.score - a.score;
      });
    }

    // Group by subject
    const groups = new Map<string, typeof orderedProcedural>();
    for (let k = 0; k < orderedProcedural.length; k++) {
      const m = orderedProcedural[k]!;
      const subj = m.subject || "General";
      if (!groups.has(subj)) groups.set(subj, []);
      groups.get(subj)!.push(m);
    }

    for (const entry of Array.from(groups.entries())) {
      const subject = entry[0];
      const mems = entry[1];
      lines.push("\n[" + subject + "]");
      mems.sort(function(a, b) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      for (let j = 0; j < mems.length; j++) {
        const mem = mems[j]!;
        const rank = rankMap.get(mem) || memId;
        const label = getSemanticLabel(rank);
        const id = "[M" + memId + "]"; const cTag = payload.conflictTags[mem.id] || "";
        if (label) {
          lines.push((cTag ? cTag + " " : "") + label + " " + id + ": " + mem.claim);
        } else {
          lines.push((cTag ? cTag + " " : "") + id + " " + mem.claim);
        }
        memId++;
      }
    }
  } else {
    let idx = 1;
    for (let n = 0; n < orderedProcedural.length; n++) {
      const mem2 = orderedProcedural[n]!;
      const rank2 = rankMap.get(mem2) || idx;
      const label2 = getSemanticLabel(rank2);
      const id2 = "[M" + memId + "]"; const cTag2 = payload.conflictTags[mem2.id] || "";
      if (fmt === "clean") {
        if (label2) {
          lines.push((cTag2 ? cTag2 + " " : "") + label2 + " " + id2 + ": " + mem2.claim);
        } else {
          lines.push((cTag2 ? cTag2 + " " : "") + id2 + " " + mem2.claim);
        }
      } else {
        lines.push(
          (cTag2 ? cTag2 + " " : "") + id2 + " " + mem2.claim + " (subject: " + mem2.subject + ", confidence: " + mem2.confidence.toFixed(2) + ", provenance: " + mem2.provenance + ")",
        );
      }
      idx++;
      memId++;
    }
  }

  if (fmt === "full" && payload.conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts detected:");
    for (let c = 0; c < payload.conflicts.length; c++) {
      lines.push("- " + payload.conflicts[c]!.message);
    }
  }

  lines.push("---");
  return lines.join("\n");
}
