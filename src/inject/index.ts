import type { InjectionPayload, CompiledMemory, InjectionConfig, MemoryRecord } from '../schema/memory.js';
import type { IMemoryRepository } from '../repository/interface.js';
import type { RetrievalResult } from '../retrieval/index.js';
import { detectAllConflicts, buildConflictTagMap } from './conflict.js';
import { buildMetaMemoryHeader } from './meta.js';
import { compileBudget } from './budget.js';
import { buildTimeline } from './timeline.js';
import { classifyQuery } from '../retrieval/query-classifier.js';
import { createLogger } from '../config.js';
import { dedupFacts } from './compress.js';
import { DEFAULT_INJECTION_CONFIG, buildFramingBlock, buildSteeringBlock, buildAnswerStyleBlock } from './steering.js';
import { engineNow } from '../retrieval/engine-now.js';
import { spanSync, recordInjection, recordDecision } from '../telemetry/index.js';
import { detectSecretsInText, isVaultEnabled } from '../security/vault/index.js';
import { applyL2Defense } from '../security/read-defense/l2-scanner.js';

const log = createLogger('inject');

/**
 * Build injection payload from retrieval results.
 */
export function buildInjectionPayload(
  retrievalResult: RetrievalResult,
  maxRules: number = 15,
  nowIso?: string,
  config: InjectionConfig = DEFAULT_INJECTION_CONFIG,
  interactionPrefs: MemoryRecord[] = [],
  continuity: { currentFocus?: string; recentCorrections?: string[] } = {},
): InjectionPayload {
  return spanSync('inject.run', () => {
    // S4: pass through INJECT_TOKEN_BUDGET (env, off by default). When set,
    // the compiler drops lowest-scored survivors that would push the
    // cumulative claim-token estimate past the cap, preventing silent LLM
    // context overflow on long-claim corpora.
    const budget = compileBudget(retrievalResult.candidates, maxRules);
    const candidates = budget.candidates;

    if (budget.dropped.length > 0) {
      log.debug(
        {
          dropped: budget.dropped.length,
          allocation: budget.allocation,
          estimatedTokens: budget.estimatedTokens,
        },
        'Budget compiler active',
      );
    }

    const memories: CompiledMemory[] = candidates.map((c) => ({
      id: c.id,
      claim: c.candidate.record.claim,
      subject: c.candidate.record.subject,
      scope: c.candidate.record.scope,
      provenance: c.candidate.record.provenance,
      trustClass: c.candidate.record.trustClass,
      confidence: c.candidate.record.confidence,
      createdAt: c.candidate.record.createdAt,
      score: c.finalScore,
      // S55: surface validFrom for age-aware staleness annotation in renderer.
      validFrom: c.candidate.record.validFrom,
      slot: 'fact' as const,
      position: 'context' as const,
      compressed: false,
    }));

    const compressed = dedupFacts(memories);

    // W4.5 Position 2: injection-time second-pass scan. If Position 1
    // (extraction-time) missed an unencrypted secret, this is the last
    // line of defense before the answer LLM sees it. We do NOT call the
    // vault here (no encryption on the read path), just redact in place
    // and emit a loud decision so the FP/FN gap surfaces in telemetry.
    if (process.env.VAULT_INJECTION_DETECTION_ENABLED === 'true' && isVaultEnabled()) {
      for (const mem of compressed) {
        const detection = detectSecretsInText(mem.claim);
        if (!detection.hasSecrets) continue;
        mem.claim = detection.redactedText;
        for (const span of detection.spans) {
          recordDecision({
            decision_type: 'vault_injection_caught_unencrypted',
            branch_taken: 'redacted',
            outcome: 'caught_at_injection',
            inputs: { pattern: span.pattern, memoryId: mem.id, stage: 'injection-scan' },
          });
        }
      }
    }

    // W4 Track B L2: retrieval-time per-memory injection scan. Drops any
    // retrieved memory whose claim matches an injection pattern before it
    // reaches the answer model (catches memories that bypassed write-time L1).
    // Flag off => working === compressed => byte-identical read path.
    let working = compressed;
    if (process.env.READ_INJECTION_DEFENSE_ENABLED === 'true') {
      working = applyL2Defense(compressed);
    }

    const conflicts = detectAllConflicts(candidates);
    const conflictTagMap = buildConflictTagMap(candidates);
    const conflictTags = Object.fromEntries(conflictTagMap);

    if (conflicts.length > 0) {
      log.info(
        { conflictCount: conflicts.length, memoryCount: memories.length },
        'Conflicts detected in injection payload',
      );
    }

    // B1a: link this injection back to the retrieval that produced it so
    // the offline weight tuner can correlate "did we inject the right
    // facts" against follow-up retrievals. Telemetry is best-effort -
    // the helper short-circuits when TELEMETRY_ENABLED=false or when no
    // retrievalId was captured upstream.
    if (retrievalResult.metadata.retrievalId) {
      recordInjection({
        retrieval_id: retrievalResult.metadata.retrievalId,
        injected_ids: working.map((m) => m.id),
        injected_token_estimate: budget.estimatedTokens,
        budget_dropped: budget.dropped.length,
      });
    }

    const payload: InjectionPayload = {
      knowledgeMap: null,
      memories: working,
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
        // S55: capture clock for age-aware annotations. Defaults to wall-clock
        // when caller doesn't override (production path); tests inject a fixed
        // ISO string for deterministic assertions.
        nowIso: nowIso ?? engineNow(),
      },
    };

    // P0 seams. Both return undefined today (ships dark). P1 fills framing,
    // P2 fills steering. Gated by config so the default profile can switch
    // layers off without code changes.
    payload.framing = buildFramingBlock(payload, config);
    payload.steering = buildSteeringBlock(payload, config, interactionPrefs, continuity);
    payload.answerStyle = buildAnswerStyleBlock(payload, config);

    return payload;
  });
}

/**
 * Format injection payload with optional meta-memory header.
 */
export async function formatForContextWithMeta(payload: InjectionPayload, repo?: IMemoryRepository): Promise<string> {
  const lines: string[] = [];

  if (repo) {
    try {
      const meta = await buildMetaMemoryHeader(repo);
      lines.push('[' + meta + ']');
      lines.push('');
    } catch {
      // Meta-memory failure is non-critical
    }
  }

  lines.push(formatForContext(payload));
  return lines.join('\n');
}

type QueryFormatMode = 'relevance' | 'chronological' | 'entity-grouped';

function detectFormatMode(query?: string): QueryFormatMode {
  if (!query) return 'relevance';
  const q = query.toLowerCase();
  if (/\b(when|before|after|first|last|earlier|later|timeline|sequence|order|date|year|month)\b/.test(q)) {
    return 'chronological';
  }
  const names = query.match(/\b[A-Z][a-z]{2,}\b/g);
  const uniqueNames = names ? new Set(names).size : 0;
  if (uniqueNames >= 2) return 'entity-grouped';
  return 'relevance';
}

/**
 * U8: Build memory map header.
 */
function buildMemoryMap(memories: CompiledMemory[]): string {
  const subjectCounts = new Map<string, number>();
  for (const m of memories) {
    const subj = m.subject || 'General';
    subjectCounts.set(subj, (subjectCounts.get(subj) || 0) + 1);
  }
  const sorted = Array.from(subjectCounts.entries()).sort((a, b) => b[1] - a[1]);
  const parts = sorted.map(function (entry) {
    return entry[1] + ' about ' + entry[0];
  });
  return '[Memory: ' + memories.length + ' facts \u2014 ' + parts.join(', ') + ']';
}

/**
 * U6: Build entity profiles from injected memories.
 * 2-3 sentence bio per subject from top claims.
 */
function buildEntityProfiles(memories: CompiledMemory[]): string {
  const bySubject = new Map<string, CompiledMemory[]>();
  for (const m of memories) {
    const subj = m.subject || 'General';
    if (subj === 'General' || subj.startsWith('hub:')) continue;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj)!.push(m);
  }

  if (bySubject.size === 0) return '';

  const lines: string[] = [];
  lines.push('[Entity Profiles]');

  for (const [subject, mems] of Array.from(bySubject.entries())) {
    if (mems.length < 3) continue;
    // Take top 5 by score for the bio
    const top = mems
      .slice()
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 5);
    const claims = top.map(function (m) {
      return m.claim;
    });
    lines.push(subject + ' (' + mems.length + ' facts): ' + claims.join('. ') + '.');
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * P3: Get semantic label for a fact based on its rank position.
 */
function getSemanticLabel(rankPosition: number): string {
  if (rankPosition <= 5) return 'KEY';
  if (rankPosition <= 15) return 'SUPPORTING';
  return '';
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

/**
 * S55: Age-aware staleness annotation for current-state queries.
 *
 * Packet A (H1): also surfaces an absolute "[YYYY-MM-DD] " prefix from
 * validFrom for temporal / temporal-multi-hop queries, ungated from the
 * staleness threshold (every temporal fact carries its date).
 *
 * Returns a prefix like "[as-of 2010-01-01] " when ALL of:
 *   - queryType === 'current-state'
 *   - validFrom is non-null
 *   - Age of fact at nowIso exceeds STALE_AGE_THRESHOLD_MONTHS (default 24)
 *
 * Returns "[YYYY-MM-DD] " when queryType is temporal / temporal-multi-hop and
 * validFrom is non-null (threshold-independent).
 *
 * Otherwise returns empty string. Caller concatenates the prefix to the
 * rendered claim line.
 *
 * Threshold tunable via env var STALE_AGE_THRESHOLD_MONTHS. The 24-month
 * default sits comfortably below the stale-memory bench's 10+ year fixtures
 * but above typical fresh-fact lifetimes.
 */
export function buildAgeAnnotation(
  validFrom: string | null | undefined,
  queryType: string | undefined,
  nowIso: string,
): string {
  // Packet A H1: surface an absolute date on every temporal fact, ungated from
  // the 24-month staleness threshold. Absolute dates beat relative ages for
  // ordering, so every temporal fact carries a date the model can order on
  // instead of only the near-zero fraction with a date baked into the claim.
  // valid_from is the mention date (a proxy for the event date); acceptable
  // here because LME sessions are roughly chronological.
  if (queryType === 'temporal' || queryType === 'temporal-multi-hop') {
    if (!validFrom) return '';
    return '[' + validFrom.slice(0, 10) + '] ';
  }

  if (queryType !== 'current-state') return '';
  if (!validFrom) return '';

  const thresholdMonths = parseInt(process.env.STALE_AGE_THRESHOLD_MONTHS || '24', 10);
  if (Number.isNaN(thresholdMonths) || thresholdMonths <= 0) return '';

  const validFromMs = Date.parse(validFrom);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(validFromMs) || Number.isNaN(nowMs)) return '';

  const ageMonths = (nowMs - validFromMs) / (1000 * 60 * 60 * 24 * (365.25 / 12));
  if (ageMonths < thresholdMonths) return '';

  // YYYY-MM-DD slice of validFrom (canonical ISO date prefix).
  const datePrefix = validFrom.slice(0, 10);
  return '[as-of ' + datePrefix + '] ';
}

export function formatForContext(
  payload: InjectionPayload,
  format: 'structured' | 'context-string' = 'structured',
): string {
  if (payload.memories.length === 0) {
    return '';
  }
  // Deployment surface: a host that asked for 'context-string' wants a compact,
  // self-contained prose block it can paste inline, not the sectioned structured
  // form. Governance instruction first, then the facts as plain text, then a
  // short preferences line.
  if (format === 'context-string') {
    const parts: string[] = [];
    if (payload.framing?.instruction) parts.push(payload.framing.instruction);
    parts.push(payload.memories.map((m) => m.claim).join(' '));
    if (payload.steering?.interactionPrefs && payload.steering.interactionPrefs.length > 0) {
      parts.push(
        'Preferences: ' + payload.steering.interactionPrefs.map((p) => `${p.dimension}=${p.value}`).join(', ') + '.',
      );
    }
    return parts.join('\n\n');
  }

  // S67: capture nowIso once at the top of the function so every
  // buildAgeAnnotation call inside the rendering loops sees the same value
  // and we don't pay a Date.toISOString() per fact.
  const nowIsoForAge = payload.metadata.nowIso ?? engineNow();

  const lines: string[] = [];

  const hubs = payload.memories.filter(function (m) {
    return m.subject.startsWith('hub:');
  });
  const procedural = payload.memories.filter(function (m) {
    return !m.subject.startsWith('hub:');
  });

  // S67: reuse the queryType already classified at buildInjectionPayload time
  // instead of re-running classifyQuery. Falls back only when caller built the
  // payload outside the canonical pipeline (tests sometimes do). Resolved here
  // (ahead of the render) so both the CURRENT DATE header and the timeline gate
  // share one value.
  const queryType =
    payload.metadata.queryType ??
    (payload.metadata.queryUsed ? classifyQuery(payload.metadata.queryUsed) : 'single-hop');

  // Packet A H3: surface a single reference "now" for temporal queries so the
  // model can compute elapsed time ("how many weeks ago"). Sourced from
  // nowIsoForAge (the question's reference date once dispatch forwards nowIso
  // into the payload). Emitted once, at the very top, before the timeline and
  // facts. Non-temporal queries get nothing.
  if (queryType === 'temporal' || queryType === 'temporal-multi-hop') {
    lines.push('CURRENT DATE: ' + nowIsoForAge.slice(0, 10));
    lines.push('');
  }

  // U8: Memory map header
  lines.push(buildMemoryMap(procedural));
  lines.push('');

  // U6: Entity profiles
  const profiles = buildEntityProfiles(procedural);
  if (profiles) {
    lines.push(profiles);
    lines.push('');
  }

  // U7: Timeline for temporal queries (queryType resolved above).
  // S65: also fire on temporal-multi-hop. Compound type was added in
  // classifier (S30) so multi-entity temporal queries keep both multi-hop
  // bridge retrieval AND timeline injection. Inject side was missed.
  if (queryType === 'temporal' || queryType === 'temporal-multi-hop') {
    const { timeline } = buildTimeline(procedural);
    if (timeline) {
      lines.push(timeline);
      lines.push('');
    }
  }

  lines.push('--- Memory Context (' + payload.memories.length + ' rules) ---');

  // Typed injection: hubs first
  if (hubs.length > 0) {
    lines.push('Principles:');
    for (const m of hubs) {
      lines.push('  - ' + m.claim);
    }
    lines.push('');
  }

  const fmt = process.env.INJECT_FORMAT || 'full';
  const formatMode = detectFormatMode(payload.metadata.queryUsed);

  // P3 + P2: Build rank map from original score order before any re-sorting
  const rankMap = new Map<CompiledMemory, number>();
  for (let i = 0; i < procedural.length; i++) {
    rankMap.set(procedural[i]!, i + 1);
  }

  // S67: chronological / entity-grouped sort fires regardless of fmt mode.
  // Previously this sort was gated behind `if (fmt === 'packed')` and never
  // ran in production benches (default fmt='full'). Brain #2161 documents
  // the dead-code finding from BEAM event_ordering -19.6pp diagnosis.
  let orderedProcedural = procedural.slice();
  if (formatMode === 'chronological') {
    orderedProcedural.sort(function (a, b) {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  } else if (formatMode === 'entity-grouped') {
    orderedProcedural.sort(function (a, b) {
      const subjCmp = a.subject.localeCompare(b.subject);
      if (subjCmp !== 0) return subjCmp;
      return b.score - a.score;
    });
  } else if (fmt === 'packed' && formatMode === 'relevance') {
    // C9: Sandwich ordering for packed-relevance only.
    orderedProcedural = applySandwichOrdering(procedural);
  }

  let memId = 1;

  if (fmt === 'packed') {
    // Group by subject
    const groups = new Map<string, typeof orderedProcedural>();
    for (let k = 0; k < orderedProcedural.length; k++) {
      const m = orderedProcedural[k]!;
      const subj = m.subject || 'General';
      if (!groups.has(subj)) groups.set(subj, []);
      groups.get(subj)!.push(m);
    }

    for (const entry of Array.from(groups.entries())) {
      const subject = entry[0];
      const mems = entry[1];
      lines.push('\n[' + subject + ']');
      mems.sort(function (a, b) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      for (let j = 0; j < mems.length; j++) {
        const mem = mems[j]!;
        const rank = rankMap.get(mem) || memId;
        const label = getSemanticLabel(rank);
        const id = '[M' + memId + ']';
        const cTag = payload.conflictTags[mem.id] || '';
        const ann = buildAgeAnnotation(mem.validFrom, payload.metadata.queryType, nowIsoForAge);
        if (label) {
          lines.push((cTag ? cTag + ' ' : '') + label + ' ' + id + ': ' + ann + mem.claim);
        } else {
          lines.push((cTag ? cTag + ' ' : '') + id + ' ' + ann + mem.claim);
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
      const id2 = '[M' + memId + ']';
      const cTag2 = payload.conflictTags[mem2.id] || '';
      const ann2 = buildAgeAnnotation(mem2.validFrom, payload.metadata.queryType, nowIsoForAge);
      if (fmt === 'clean') {
        if (label2) {
          lines.push((cTag2 ? cTag2 + ' ' : '') + label2 + ' ' + id2 + ': ' + ann2 + mem2.claim);
        } else {
          lines.push((cTag2 ? cTag2 + ' ' : '') + id2 + ' ' + ann2 + mem2.claim);
        }
      } else {
        lines.push(
          (cTag2 ? cTag2 + ' ' : '') +
            id2 +
            ' ' +
            ann2 +
            mem2.claim +
            ' (subject: ' +
            mem2.subject +
            ', confidence: ' +
            mem2.confidence.toFixed(2) +
            ', provenance: ' +
            mem2.provenance +
            ')',
        );
      }
      idx++;
      memId++;
    }
  }

  if (fmt === 'full' && payload.conflicts.length > 0) {
    lines.push('');
    lines.push('Conflicts detected:');
    for (let c = 0; c < payload.conflicts.length; c++) {
      lines.push('- ' + payload.conflicts[c]!.message);
    }
  }

  lines.push('---');
  return lines.join('\n');
}
