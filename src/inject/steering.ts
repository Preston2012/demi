import { TrustClass } from '../schema/memory.js';
import type {
  InjectionPayload,
  InjectionConfig,
  PartialInjectionConfig,
  FramingBlock,
  SteeringBlock,
  MemoryRecord,
  AnswerStyleBlock,
} from '../schema/memory.js';
import type { IMemoryRepository } from '../repository/interface.js';
import { INTERACTION_DIMENSIONS } from '../write/subject-cardinality.js';
import { CATEGORY_PROMPTS } from './prompts.js';
import type { QueryType } from '../retrieval/query-classifier.js';
import { onByDefault, offByDefault } from '../config/flag-defaults.js';

/**
 * Default injection profile for a bolt-on host: facts plus L2 framing plus
 * L3 steering, L4 answer style off (host owns its voice), structured format.
 * A host overrides this per integration.
 */
export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  facts: true,
  framing: true,
  steering: {
    interactionPrefs: true,
    continuity: true,
  },
  answerStyle: false,
  format: 'structured',
};

/**
 * Deployment-default injection config from env. A deployment chooses which
 * layers it serves by default; defaults match DEFAULT_INJECTION_CONFIG so an
 * unconfigured deployment behaves exactly as before. On-by-default layers use
 * onByDefault (`!== 'false'`); the off-by-default answerStyle uses offByDefault
 * (`=== 'true'`). Read at call time so tests and dogfood can flip env per run.
 */
export function getDeploymentInjectionConfig(): InjectionConfig {
  const fmt: 'structured' | 'context-string' =
    process.env.INJECT_FORMAT === 'context-string' ? 'context-string' : 'structured';
  return {
    facts: true,
    framing: onByDefault(process.env.INJECT_FRAMING),
    steering: {
      interactionPrefs: onByDefault(process.env.INJECT_STEERING_PREFS),
      continuity: onByDefault(process.env.INJECT_STEERING_CONTINUITY),
    },
    answerStyle: offByDefault(process.env.INJECT_ANSWER_STYLE),
    format: fmt,
  };
}

/**
 * Resolve the effective injection config for a request. Precedence, lowest to
 * highest: DEFAULT_INJECTION_CONFIG, then the deployment default, then the
 * per-request override. Field-level merge; the `steering` sub-object merges per
 * key so an override of one sub-flag keeps the other from the base. `facts` is
 * always true and is never overridable.
 */
export function resolveInjectionConfig(
  deploymentDefault: InjectionConfig = DEFAULT_INJECTION_CONFIG,
  override?: PartialInjectionConfig,
): InjectionConfig {
  const base = deploymentDefault;
  return {
    facts: true,
    framing: override?.framing ?? base.framing,
    steering: {
      interactionPrefs: override?.steering?.interactionPrefs ?? base.steering.interactionPrefs,
      continuity: override?.steering?.continuity ?? base.steering.continuity,
    },
    answerStyle: override?.answerStyle ?? base.answerStyle,
    format: override?.format ?? base.format,
  };
}

/**
 * L2 governance framing. Built from trust and temporal metadata already on
 * the payload. Tells the host how to treat the facts: hedge on stale, surface
 * unresolved conflicts rather than pick one, weight by confidence, abstain
 * when there are no facts. See docs/internal/STEERING_INJECTION_SPEC.md.
 */
export function buildFramingBlock(payload: InjectionPayload, config: InjectionConfig): FramingBlock | undefined {
  if (!config.framing) return undefined;

  const tagOf = (id: string): string | undefined => payload.conflictTags[id];

  const perFact: FramingBlock['perFact'] = payload.memories.map((m) => {
    const tag = tagOf(m.id);
    const recency: 'current' | 'stale' | 'unknown' =
      tag === '[SUPERSEDED]' ? 'stale' : tag === '[CONFLICT-UNRESOLVED]' ? 'unknown' : 'current';
    const confidence: 'high' | 'medium' | 'low' =
      m.trustClass === TrustClass.CONFIRMED ? 'high' : m.trustClass === TrustClass.AUTO_APPROVED ? 'medium' : 'low';
    return {
      memoryId: m.id,
      recency,
      asOf: m.validFrom ?? undefined,
      confidence,
    };
  });

  // Only surface conflicts that supersession did NOT resolve. A pair where one
  // side is [CURRENT] and the other [SUPERSEDED] is resolved and is carried by
  // recency. Genuinely ambiguous pairs are tagged [CONFLICT-UNRESOLVED].
  const subjectOf = new Map(payload.memories.map((m) => [m.id, m.subject]));
  const seen = new Set<string>();
  const unresolvedConflicts: FramingBlock['unresolvedConflicts'] = [];
  for (const n of payload.conflicts) {
    if (tagOf(n.memoryId) !== '[CONFLICT-UNRESOLVED]') continue;
    const key = [n.memoryId, n.conflictsWithId].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unresolvedConflicts.push({
      subject: subjectOf.get(n.memoryId) ?? 'unknown',
      memoryIds: [n.memoryId, n.conflictsWithId],
      note: n.message,
    });
  }

  const hasStale = perFact.some((f) => f.recency === 'stale');
  const hasLowConfidence = perFact.some((f) => f.confidence === 'low');
  const abstain = payload.memories.length === 0;
  // Grounding sufficiency: none = no facts; thin = facts present but none is
  // both current and at least medium confidence; ok = at least one solid fact.
  // Threshold-free: derived from the recency and confidence classes above, not
  // an asserted relevance-score cutoff. Score-based or LLM-judge sufficiency is
  // future work.
  const hasSolid = perFact.some((f) => f.recency === 'current' && f.confidence !== 'low');
  const grounding: 'none' | 'thin' | 'ok' = abstain ? 'none' : hasSolid ? 'ok' : 'thin';

  const lines: string[] = [];
  if (abstain) {
    lines.push(
      'The memory contains no relevant facts for this query. Say you do not have that information rather than guessing.',
    );
  } else {
    lines.push('Use the memory facts below to inform your reply.');
    if (hasStale) {
      lines.push('Facts marked stale may be outdated. State them with their date and do not present them as current.');
    }
    if (unresolvedConflicts.length > 0) {
      lines.push(
        'Some facts conflict and are unresolved. Surface the disagreement to the user rather than choosing one.',
      );
    }
    if (hasLowConfidence) {
      lines.push('Hedge on facts marked low confidence.');
    }
    if (grounding === 'thin') {
      lines.push(
        'No fact here is both current and confident, so grounding is thin. If the facts do not directly answer the question, say you are not certain rather than asserting.',
      );
    }
  }

  return {
    perFact,
    unresolvedConflicts,
    abstain,
    grounding,
    instruction: lines.join(' '),
  };
}

/**
 * Fetch the user's current interaction preferences for the steering layer.
 * One getBySubject per known dimension, filtered to current (invalidAt null).
 * buildSteeringBlock picks the latest per dimension. Cheap: a handful of
 * indexed lookups, no embedding, no query matching.
 */
export async function fetchInteractionPrefs(repo: IMemoryRepository, userId?: string): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = [];
  for (const dim of INTERACTION_DIMENSIONS) {
    const rows = await repo.getBySubject(dim, 5, userId);
    for (const r of rows) {
      if (r.invalidAt === null) out.push(r);
    }
  }
  return out;
}

/**
 * Fetch conversational continuity for the steering layer: the current focus
 * (most recent episode) and the user's recent corrections (current facts that
 * superseded an earlier value). Both are query-independent, so they are
 * fetched here rather than from the query-matched pool.
 */
export async function fetchContinuity(
  repo: IMemoryRepository,
  userId?: string,
): Promise<{ currentFocus?: string; recentCorrections?: string[] }> {
  const out: { currentFocus?: string; recentCorrections?: string[] } = {};
  const ep = await repo.getRecentEpisode(userId);
  if (ep) {
    const focus = ep.title || ep.subject || ep.summary;
    if (focus) out.currentFocus = focus;
  }
  const corrections = await repo.getRecentCorrections(3, userId);
  if (corrections.length > 0) {
    out.recentCorrections = corrections.map((m) => `${m.subject}: ${m.claim}`);
  }
  return out;
}

/**
 * L3 learned steering. Emits the user's current interaction preferences and
 * conversational continuity (current focus and recent corrections) so a host
 * adapts verbosity, tone, format, and carries forward in-flight context.
 * Preferences and continuity are fetched separately (they do not match the
 * query) and passed in. See docs/internal/STEERING_INJECTION_SPEC.md.
 */
export function buildSteeringBlock(
  _payload: InjectionPayload,
  config: InjectionConfig,
  prefs: MemoryRecord[] = [],
  continuity: { currentFocus?: string; recentCorrections?: string[] } = {},
): SteeringBlock | undefined {
  const wantPrefs = config.steering.interactionPrefs;
  const wantContinuity = config.steering.continuity;
  if (!wantPrefs && !wantContinuity) return undefined;

  // One current value per dimension, latest wins. The fetch already filters to
  // current records; this guards against more than one current row per subject.
  const latestByDim = new Map<string, MemoryRecord>();
  if (wantPrefs) {
    for (const m of prefs) {
      const dim = m.subject.toLowerCase();
      const existing = latestByDim.get(dim);
      if (!existing) {
        latestByDim.set(dim, m);
        continue;
      }
      const a = Date.parse(m.validFrom ?? m.createdAt);
      const b = Date.parse(existing.validFrom ?? existing.createdAt);
      if (Number.isFinite(a) && Number.isFinite(b) && a > b) latestByDim.set(dim, m);
    }
  }

  const interactionPrefs = Array.from(latestByDim.values()).map((m) => ({
    dimension: m.subject,
    value: m.claim,
  }));

  const cont = wantContinuity ? continuity : {};
  const hasContinuity = !!cont.currentFocus || (cont.recentCorrections?.length ?? 0) > 0;

  if (interactionPrefs.length === 0 && !hasContinuity) return undefined;

  const lines: string[] = [];
  if (interactionPrefs.length > 0) {
    lines.push(
      'Apply the user interaction preferences: ' +
        interactionPrefs.map((p) => `${p.dimension} ${p.value}`).join('; ') +
        '.',
    );
  }
  if (cont.currentFocus) {
    lines.push(`The user is currently focused on: ${cont.currentFocus}.`);
  }
  if ((cont.recentCorrections?.length ?? 0) > 0) {
    lines.push(`Recently corrected by the user: ${cont.recentCorrections!.join('; ')}.`);
  }

  return {
    interactionPrefs,
    continuity: cont,
    instruction: lines.join(' '),
  };
}

/**
 * L4 answer-style. Opt-in (config.answerStyle), default off: the host owns its
 * voice. When on, returns the category-appropriate answer-style guidance for
 * the query type. See docs/internal/STEERING_INJECTION_SPEC.md.
 */
export function buildAnswerStyleBlock(
  payload: InjectionPayload,
  config: InjectionConfig,
): AnswerStyleBlock | undefined {
  if (!config.answerStyle) return undefined;
  const queryType = payload.metadata.queryType;
  if (!queryType) return undefined;
  const guidance = CATEGORY_PROMPTS[queryType as QueryType];
  if (!guidance) return undefined;
  return { queryType, guidance };
}
