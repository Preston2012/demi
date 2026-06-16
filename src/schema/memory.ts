import { z } from 'zod';

// --- Enums ---

export const Provenance = {
  USER_CONFIRMED: 'user-confirmed',
  LLM_EXTRACTED_CONFIDENT: 'llm-extracted-confident',
  LLM_EXTRACTED_QUARANTINE: 'llm-extracted-quarantine',
  IMPORTED: 'imported',
} as const;

export type Provenance = (typeof Provenance)[keyof typeof Provenance];

export const ProvenanceSchema = z.enum([
  Provenance.USER_CONFIRMED,
  Provenance.LLM_EXTRACTED_CONFIDENT,
  Provenance.LLM_EXTRACTED_QUARANTINE,
  Provenance.IMPORTED,
]);

export const TrustClass = {
  CONFIRMED: 'confirmed',
  AUTO_APPROVED: 'auto-approved',
  QUARANTINED: 'quarantined',
  REJECTED: 'rejected',
} as const;

export type TrustClass = (typeof TrustClass)[keyof typeof TrustClass];

export const TrustClassSchema = z.enum([
  TrustClass.CONFIRMED,
  TrustClass.AUTO_APPROVED,
  TrustClass.QUARANTINED,
  TrustClass.REJECTED,
]);

export const ReviewStatus = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
} as const;

export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export const ReviewStatusSchema = z.enum([ReviewStatus.APPROVED, ReviewStatus.PENDING, ReviewStatus.REJECTED]);

export const Scope = {
  GLOBAL: 'global',
  PROJECT: 'project',
  SESSION: 'session',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

export const ScopeSchema = z.enum([Scope.GLOBAL, Scope.PROJECT, Scope.SESSION]);

export const PermanenceStatus = {
  PROVISIONAL: 'provisional',
  PERMANENT: 'permanent',
  PROMOTION_PENDING: 'promotion-pending',
} as const;

export type PermanenceStatus = (typeof PermanenceStatus)[keyof typeof PermanenceStatus];

export const PermanenceStatusSchema = z.enum([
  PermanenceStatus.PROVISIONAL,
  PermanenceStatus.PERMANENT,
  PermanenceStatus.PROMOTION_PENDING,
]);

export const ResolutionLevel = {
  PRINCIPLE: 1,
  PATTERN: 2,
  SPECIFIC: 3,
} as const;

export type ResolutionLevel = (typeof ResolutionLevel)[keyof typeof ResolutionLevel];

export const MemoryType = {
  DECLARATIVE: 'declarative',
  PROCEDURAL: 'procedural',
  CONSTRAINT: 'constraint',
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

export const MemoryTypeSchema = z.enum([MemoryType.DECLARATIVE, MemoryType.PROCEDURAL, MemoryType.CONSTRAINT]);

export const StorageTier = {
  ACTIVE: 'active',
  COLD: 'cold',
  ARCHIVE: 'archive',
} as const;

export type StorageTier = (typeof StorageTier)[keyof typeof StorageTier];

export const StorageTierSchema = z.enum([StorageTier.ACTIVE, StorageTier.COLD, StorageTier.ARCHIVE]);

export const InterferenceStatus = {
  ACTIVE: 'active',
  COLD: 'cold',
  ARCHIVED: 'archived',
} as const;

export type InterferenceStatus = (typeof InterferenceStatus)[keyof typeof InterferenceStatus];

export const InterferenceStatusSchema = z.enum([
  InterferenceStatus.ACTIVE,
  InterferenceStatus.COLD,
  InterferenceStatus.ARCHIVED,
]);

export const MemorySource = {
  USER: 'user',
  LLM: 'llm',
  IMPORT: 'import',
} as const;

export type MemorySource = (typeof MemorySource)[keyof typeof MemorySource];

export const MemorySourceSchema = z.enum([MemorySource.USER, MemorySource.LLM, MemorySource.IMPORT]);

// --- Trust branch action (what happened to this memory) ---

export const TrustAction = {
  CONFIRMED: 'confirmed',
  STORED: 'stored',
  QUARANTINED: 'quarantined',
  REJECTED: 'rejected',
} as const;

export type TrustAction = (typeof TrustAction)[keyof typeof TrustAction];

// --- Provenance score mapping (deterministic, no LLM) ---

export const PROVENANCE_SCORES: Record<Provenance, number> = {
  [Provenance.USER_CONFIRMED]: 1.0,
  [Provenance.LLM_EXTRACTED_CONFIDENT]: 0.7,
  [Provenance.LLM_EXTRACTED_QUARANTINE]: 0.3,
  [Provenance.IMPORTED]: 0.5,
};

// --- User ID (Packet 0: user-scoped requests) ---

/**
 * Per-tenant partition key. The API key authenticates the caller (e.g. demi-api);
 * userId says which user the caller is acting on behalf of. Demiurge owns the
 * partition, every read/write filters by user_id at the SQL layer.
 *
 * 'system' is reserved for benchmark workflows, MCP (Claude Desktop / Claude.ai),
 * and rows existing before the user_id column was introduced.
 *
 * Charset supports UUIDs, namespaced ids ("tenant:alice"), and email-style ids.
 */
export const UserIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:@-]+$/, 'user_id must match /^[a-zA-Z0-9._:@-]+$/');

export const SYSTEM_USER_ID = 'system';

// --- Memory Record (the canonical schema) ---

export const MemoryRecordSchema = z.object({
  id: z.string().uuid(),
  // Packet 0: optional in the type so existing fixtures keep compiling.
  // The repository fills in 'system' when reading rows that lack the column,
  // and the write pipeline always sets it explicitly.
  userId: z.string().min(1).max(128).optional(),
  externalRef: z.string().min(1).max(256).nullable().optional(),
  claim: z.string().min(1).max(2000),
  subject: z.string().min(1).max(500),
  scope: ScopeSchema,
  validFrom: z.string().datetime({ offset: true }).nullable(),
  validTo: z.string().datetime({ offset: true }).nullable(),
  provenance: ProvenanceSchema,
  trustClass: TrustClassSchema,
  confidence: z.number().min(0).max(1),
  sourceHash: z.string().min(1),
  supersedes: z.string().uuid().nullable(),
  conflictsWith: z.array(z.string().uuid()),
  reviewStatus: ReviewStatusSchema,
  accessCount: z.number().int().min(0),
  lastAccessed: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  embedding: z.array(z.number()).nullable(),
  permanenceStatus: PermanenceStatusSchema.default(PermanenceStatus.PROVISIONAL),

  // Hub-and-spoke (Novel Council: Fractal Hub-and-Spoke)
  hubId: z.string().uuid().nullable().default(null),
  hubScore: z.number().min(0).max(1).default(0),
  resolution: z.number().int().min(1).max(3).default(ResolutionLevel.SPECIFIC),
  memoryType: MemoryTypeSchema.default(MemoryType.DECLARATIVE),

  // Versioning (Novel Council: Memory Versioning)
  versionNumber: z.number().int().min(1).default(1),
  parentVersionId: z.string().uuid().nullable().default(null),

  // Decay management (Novel Council: Decay + Pause)
  frozenAt: z.string().datetime({ offset: true }).nullable().default(null),
  decayScore: z.number().min(0).max(1).default(1),
  storageTier: StorageTierSchema.default(StorageTier.ACTIVE),

  // Inhibitory memory (Novel Council: Inhibitory Memory)
  isInhibitory: z.boolean().default(false),
  inhibitionTarget: z.string().nullable().default(null),
  interferenceStatus: InterferenceStatusSchema.default(InterferenceStatus.ACTIVE),

  // Correction tracking
  correctionCount: z.number().int().min(0).default(0),

  // Freeze flag
  isFrozen: z.boolean().default(false),

  // Causal/narrative chains
  causedBy: z.string().uuid().nullable().default(null),
  leadsTo: z.string().uuid().nullable().default(null),

  // Fact-Family Collapse (FFC)
  canonicalFactId: z.string().nullable().default(null),
  isCanonical: z.boolean().default(true),

  // Packet A: bi-temporal validity (Graphiti pattern)
  // validAt: when the fact became true (defaults to createdAt)
  // invalidAt: when the fact stopped being true (NULL = still valid)
  validAt: z.string().datetime({ offset: true }).nullable().default(null),
  invalidAt: z.string().datetime({ offset: true }).nullable().default(null),

  // Packet C3 / Bug 3: persona flag. When true, the fact carries a persona
  // constraint (vegetarian, sober, peanut allergy, etc.) and gets a fixed
  // retrieval boost so it surfaces on adjacent / orthogonal queries.
  persona: z.boolean().default(false),

  // S59 / TEMPR: optional session and episode IDs for direct pre-rerank
  // filter speed. Distinct from the normalized episodes / episode_facts
  // tables (those carry write-side structure). Populated by writers with
  // session context (DialSim); production users may leave NULL.
  sessionId: z.string().nullable().optional(),
  episodeId: z.string().nullable().optional(),
  // D1 + A7 (S72): when the write-time temporal resolver mutates a claim,
  // rawClaim preserves the original phrasing and normalization stores
  // the audit JSON ({type, anchorDate, rulesApplied, confidence,
  // resolvedDate}). Both NULL when no mutation happened.
  rawClaim: z.string().nullable().optional(),
  normalization: z.string().nullable().optional(),
});

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

// --- Tags ---

export interface MemoryTag {
  memoryId: string;
  tag: string;
}

// --- Hub types ---

export interface MemoryHub {
  id: string;
  claim: string;
  hubType: string;
  createdAt: string;
  accessCount: number;
}

export interface HubLink {
  memoryId: string;
  hubId: string;
  linkedAt: string;
}

// --- Memory version ---

export interface MemoryVersion {
  id: string;
  memoryId: string;
  claim: string;
  changedAt: string;
  reason: string;
}

// --- Constraint ---

export interface MemoryConstraint {
  id: string;
  claim: string;
  constraintType: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
}

// --- Self-play ---

export interface SelfPlayRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  queriesGenerated: number;
  retrievalsPassed: number;
  retrievalsFailed: number;
  notes: string | null;
}

export interface SelfPlayResult {
  id: string;
  runId: string;
  query: string;
  expectedMemoryId: string | null;
  actualMemoryId: string | null;
  passed: boolean;
  scoreGap: number;
  details: string | null;
}

// --- Meta-memory (computed, not stored) ---

export interface MetaMemoryStats {
  totalMemories: number;
  topSubjects: { subject: string; count: number }[];
  coverageGaps: string[];
  stalestMemories: { id: string; claim: string; lastAccessed: string }[];
  mostAccessed: { id: string; claim: string; accessCount: number }[];
  inhibitoryCount: number;
  frozenCount: number;
  coldStorageCount: number;
  hubCount: number;
}

// --- Input for adding a new memory (user-facing, minimal) ---

export const AddMemoryInputSchema = z.object({
  user_id: UserIdSchema.optional(),
  external_ref: z.string().min(1).max(256).optional(),
  claim: z.string().min(1).max(2000),
  subject: z.string().min(1).max(500).optional(),
  scope: ScopeSchema.optional().default(Scope.GLOBAL),
  source: MemorySourceSchema.optional().default(MemorySource.LLM),
  confidence: z.number().min(0).max(1).optional(),
  validFrom: z.string().datetime({ offset: true }).optional(),
  validTo: z.string().datetime({ offset: true }).optional(),
  isInhibitory: z.boolean().optional().default(false),
  inhibitionTarget: z.string().optional(),
  memoryType: MemoryTypeSchema.optional().default(MemoryType.DECLARATIVE),
  tags: z.array(z.string()).optional(),
  causedBy: z.string().uuid().optional(),
  leadsTo: z.string().uuid().optional(),
  canonicalFactId: z.string().optional(),
  isCanonical: z.boolean().optional(),
  // Packet C3 / Bug 3: callers can mark a write as a persona fact explicitly.
  // Auto-detect (PERSONA_AUTO_DETECT=true) will set this when the claim
  // matches the persona regex; explicit input always wins.
  persona: z.boolean().optional(),
  // S59 / TEMPR: session and episode IDs for pre-rerank filter speed.
  // Set by writers with session context (e.g. DialSim runner); NULL for
  // ordinary user writes that don't carry session structure.
  sessionId: z.string().optional(),
  episodeId: z.string().optional(),
  // D1 + A7 (S72): temporal parse IR mutations. When the claim was rewritten
  // at write-time by the temporal resolver, rawClaim is the original text and
  // normalization is a JSON blob describing what rule fired and what anchor
  // was used. Both NULL when no mutation happened. See src/inject/temporal-parse-ir.ts.
  rawClaim: z.string().min(1).max(2000).optional(),
  normalization: z.string().min(1).max(2000).optional(),
});

export type AddMemoryInput = z.infer<typeof AddMemoryInputSchema>;

// --- Result from adding a memory ---

export const AddMemoryResultSchema = z.object({
  id: z.string().uuid(),
  trustClass: TrustClassSchema,
  action: z.enum(['confirmed', 'stored', 'quarantined', 'rejected', 'duplicate']),
  reason: z.string(),
  conflictsWith: z.array(z.string().uuid()).optional(),
  // S49: existing memory IDs the new write temporally superseded.
  // Set when the write had explicit validFrom and existed older same-subject
  // related claims; write/index.ts has marked those facts invalid_at.
  supersedes: z.array(z.string().uuid()).optional(),
});

export type AddMemoryResult = z.infer<typeof AddMemoryResultSchema>;

// --- Scored candidate from retrieval ---

// S59 / TEMPR: 'graph' and 'temporal' added as first-class sources for
// 4-way candidate gathering. Existing 'fts' / 'vector' / 'both' values
// remain valid for the legacy 2-way scorer path.
export const CandidateSourceSchema = z.enum(['fts', 'vector', 'graph', 'temporal', 'both']);
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

export interface ScoredCandidate {
  id: string;
  record: MemoryRecord;
  lexicalScore: number;
  vectorScore: number;
  // S59 / TEMPR: per-source raw scores from the new graph + temporal-range
  // retrievers. Default 0 when produced by lexical/vector. RRF uses rank
  // order within each source, not these values directly.
  graphScore?: number;
  temporalScore?: number;
  source: CandidateSource;

  // Novel Council additions
  hubExpansionScore: number;
  inhibitionPenalty: number;
  primingBonus: number;
  cascadeDepth: number;
}

// --- Injection payload (what the agent receives) ---

export interface InjectedMemory {
  id: string;
  claim: string;
  subject: string;
  scope: Scope;
  provenance: Provenance;
  trustClass: TrustClass;
  confidence: number;
  createdAt: string;
  score: number;
  /**
   * S55: Surfaced from MemoryRecord so the injection renderer can compute
   * age-based staleness annotations without re-querying the repo.
   */
  validFrom?: string | null;
}

export interface ConflictNotice {
  memoryId: string;
  conflictsWithId: string;
  message: string;
}

export interface KnowledgeMap {
  totalMemories: number;
  clusters: Array<{
    topic: string;
    count: number;
    avgConfidence: number;
    stalestDays: number;
    conflictCount: number;
  }>;
  summary: string;
}

export type InjectionSlot = 'invariant' | 'warning' | 'fact' | 'procedure' | 'contradiction' | 'summary' | 'bridge';

export interface CompiledMemory extends InjectedMemory {
  slot: InjectionSlot;
  position: 'system' | 'context' | 'tool';
  compressed: boolean;
}

/**
 * Per-app injection config. Selects which layers a host receives.
 * facts and L2 framing are governance (default on). L3 steering is
 * configurable. L4 answer style is opt-in and off by default (the host
 * owns its own voice). See docs/internal/STEERING_INJECTION_SPEC.md.
 */
export interface InjectionConfig {
  facts: true;
  framing: boolean;
  steering: {
    interactionPrefs: boolean;
    continuity: boolean;
  };
  answerStyle: boolean;
  format: 'structured' | 'context-string';
}

/**
 * Partial injection config for a per-request override. All fields optional;
 * `steering` is itself partial so a host can flip one sub-flag and inherit the
 * other. `facts` is never overridable (always true). Merged over the deployment
 * default by resolveInjectionConfig.
 */
export interface PartialInjectionConfig {
  framing?: boolean;
  steering?: { interactionPrefs?: boolean; continuity?: boolean };
  answerStyle?: boolean;
  format?: 'structured' | 'context-string';
}

/**
 * L2 governance framing. Built from existing trust and temporal metadata.
 * Tells the host how to treat the facts: hedge on stale, surface unresolved
 * conflicts rather than pick one, weight by confidence, abstain when
 * grounding is thin.
 */
export interface FramingBlock {
  perFact: Array<{
    memoryId: string;
    recency: 'current' | 'stale' | 'unknown';
    asOf?: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  unresolvedConflicts: Array<{ subject: string; memoryIds: string[]; note: string }>;
  abstain: boolean;
  grounding: 'none' | 'thin' | 'ok';
  instruction: string;
}

/**
 * L3 learned steering. Interaction preferences and conversational continuity.
 */
export interface SteeringBlock {
  interactionPrefs: Array<{ dimension: string; value: string }>;
  continuity: { currentFocus?: string; recentCorrections?: string[] };
  instruction: string;
}

/**
 * L4 answer style. Opt-in (config.answerStyle), default off: the host owns its
 * voice. Carries the category-appropriate answer-style guidance for the query
 * type when a host opts in.
 */
export interface AnswerStyleBlock {
  queryType: string;
  guidance: string;
}

export interface InjectionPayload {
  knowledgeMap: KnowledgeMap | null;
  memories: CompiledMemory[];
  conflicts: ConflictNotice[];
  conflictTags: Record<string, string>;
  inhibitions: Array<{
    memoryId: string;
    reason: string;
  }>;
  metadata: {
    queryUsed: string;
    candidatesEvaluated: number;
    retrievalTimeMs: number;
    hubExpansions: number;
    crossDomainHops: number;
    inhibitionsSuppressed: number;
    primingHits: number;
    queryType?: string;
    /**
     * S55: ISO timestamp captured when the payload was built. Used by the
     * renderer to compute fact-age annotations for current-state queries.
     * Optional; renderer falls back to new Date().toISOString() if absent.
     */
    nowIso?: string;
  };
  /** L2 governance framing. Undefined unless emitted (P1). */
  framing?: FramingBlock;
  /** L3 learned steering. Undefined unless emitted (P2). */
  steering?: SteeringBlock;
  /** L4 answer style. Undefined unless the host opts in (P4). */
  answerStyle?: AnswerStyleBlock;
}

// --- Delete result (consensus-gated) ---

export interface DeleteResult {
  id: string;
  deleted: boolean;
  consensusRequired: boolean;
  reason: string;
}

// --- System stats ---

export interface RepositoryStats {
  totalMemories: number;
  byTrustClass: Record<TrustClass, number>;
  byProvenance: Record<Provenance, number>;
  byScope: Record<Scope, number>;
  pendingReview: number;
  averageConfidence: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}

export interface SystemStats extends RepositoryStats {
  circuitBreakerActive: boolean;
  lastActivityAt: string | null;
  uptimeSeconds: number;
  thompsonShadowEnabled: boolean;

  // Novel Council additions
  hubCount: number;
  spokeCount: number;
  crossDomainLinkCount: number;
  inhibitionEdgeCount: number;
  procedureCount: number;
  coldStorageCount: number;
  archivedCount: number;
  frozenCount: number;
  decayPaused: boolean;
  lastSelfPlayScore: number | null;
  lastSelfPlayDate: string | null;
  memoryHealthGrade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
}

// --- Valid trust class transitions (invariant) ---

export const VALID_TRUST_TRANSITIONS: Record<TrustClass, TrustClass[]> = {
  [TrustClass.QUARANTINED]: [TrustClass.CONFIRMED, TrustClass.REJECTED],
  [TrustClass.AUTO_APPROVED]: [TrustClass.CONFIRMED, TrustClass.REJECTED],
  [TrustClass.CONFIRMED]: [], // Can only be superseded, not demoted
  [TrustClass.REJECTED]: [], // Terminal state
};

export function isValidTransition(from: TrustClass, to: TrustClass): boolean {
  return VALID_TRUST_TRANSITIONS[from].includes(to);
}
