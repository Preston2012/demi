import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { onByDefault, parseStrictBool, legacyCoerceBool } from './config/flag-defaults.js';
import pino from 'pino';

loadDotenv();

/**
 * Strict boolean schema (R29-WC-1). Replaces z.coerce.boolean(), whose
 * Boolean('false') === true inverted the `X=false` escape hatch. Accepts only
 * 'true'/'false' (case-insensitive); unset/empty uses `defaultValue`; any other
 * token is passed through so z.boolean() rejects it loudly at boot.
 */
function strictBool(defaultValue: boolean) {
  return z.preprocess((v) => {
    if (typeof v === 'boolean') return v;
    const parsed = parseStrictBool(v as string | undefined, defaultValue);
    return parsed === null ? v : parsed;
  }, z.boolean());
}

/**
 * Parse the optional DEMIURGE_CLIENT_TOKENS env (JSON array of
 * { token, userId }). Unset or empty returns []. Malformed JSON throws so a
 * misconfigured deployment fails loudly at boot rather than silently dropping
 * client identity. Shape is validated by ConfigSchema.
 */
function parseClientTokens(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) return [];
  return JSON.parse(raw);
}

export const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().int().min(1).max(65535).default(3100),
  host: z.string().default('127.0.0.1'),
  apiKey: z.string().min(32, 'DEMIURGE_API_KEY must be at least 32 characters'),
  // Deployment surface: optional per-client token registry. Each token maps to a
  // userId; a request authenticated with a client token is scoped to that userId.
  // Empty = single shared key only (every caller is 'system'), unchanged.
  clientTokens: z
    .array(
      z.object({
        token: z.string().min(16, 'client token must be at least 16 characters'),
        userId: z.string().regex(/^[a-zA-Z0-9._:@-]+$/, 'client userId must match /^[a-zA-Z0-9._:@-]+$/'),
      }),
    )
    .default([]),

  // Database
  dbPath: z.string().default('./data/demiurge.db'),
  walMode: strictBool(true),
  // S50: SQLCipher encryption-at-rest. 32-byte hex (64 chars). Optional in
  // dev/bench, REQUIRED in production, checked in loadConfig() below.
  // :memory: databases ignore this (driver rejects PRAGMA key on them).
  dbEncryptionKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'DEMIURGE_DB_KEY must be 64 hex chars (32 bytes)')
    .optional(),

  // Embeddings
  modelPath: z.string().default('./models/bge-small-en-v1.5.onnx'),
  embeddingDim: z.coerce.number().int().default(384),

  // Retrieval
  maxInjectedRules: z.coerce.number().int().min(1).max(100).default(65),
  // Packet A: revert lex default to 0.3 (Packet 1's 0.4 regressed mini ~3pp; superseded by additive fusion).
  lexicalWeight: z.coerce.number().min(0).max(1).default(0.3),
  vectorWeight: z.coerce.number().min(0).max(1).default(0.4),
  provenanceWeight: z.coerce.number().min(0).max(1).default(0.15),
  freshnessWeight: z.coerce.number().min(0).max(1).default(0.1),
  confirmedBonus: z.coerce.number().min(0).max(1).default(0.15),
  contradictionPenaltyBase: z.coerce.number().min(0).max(1).default(0.1),
  contradictionPenaltyMax: z.coerce.number().min(0).max(1).default(0.3),
  freshnessHalfLifeDays: z.coerce.number().min(1).default(180),
  candidateOverfetchMultiplier: z.coerce.number().min(1).max(10).default(3),

  // Trust branching
  confidenceThreshold: z.coerce.number().min(0).max(1).default(0.7),
  spotCheckRate: z.coerce.number().min(0).max(1).default(0.1),
  consensusThreshold: z.coerce.number().min(0).max(1).default(0.5),

  // Wedge 1.5 (S72): telemetry + security
  // S75 (brain #2596): telemetry default flipped to true. Doctrine: ALWAYS ON.
  // Storage growth handled by /opt/demiurge-telemetry-archive daily cron.
  // Wedge 4 calibrated adjudicator needs labeled run data; LME-bisect-style
  // diagnostics need historical span data. Default OFF was costing us
  // diagnostic capability. Set TELEMETRY_ENABLED=false explicitly only when
  // running a perf measurement against the off-path.
  telemetryEnabled: strictBool(true),
  telemetryDbPath: z.string().default('./data/telemetry.db'),
  telemetryRetentionDays: z.coerce.number().int().min(1).max(365).default(7),
  telemetryFlushIntervalMs: z.coerce.number().int().min(50).max(60000).default(500),
  telemetryRingBufferSize: z.coerce.number().int().min(100).max(100000).default(10000),
  telemetryBodyCapture: strictBool(false),
  telemetryFull: strictBool(false),
  adminToken: z.string().min(32).optional(),

  // Consensus
  consensusProvider: z.enum(['anthropic', 'openai', 'google', 'mistral', 'xai', 'deepseek']).default('openai'),
  consensusModel: z.string().default('gpt-4o-mini'),
  consensusMinAgreement: z.coerce.number().int().min(1).max(3).default(2),
  consensusEvaluators: z.string().optional(), // "openai:gpt-4o-mini,mistral:mistral-small-latest,xai:grok-4-1-fast-non-reasoning" (S65 M13 default lineup)
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  googleApiKey: z.string().optional(),
  // S65 M13: M13 consensus lineup adds Mistral + xAI alongside OpenAI.
  // DeepSeek included for completeness even though M13 keeps it off the
  // consensus default (DeepSeek shines on extraction, not tiny consensus prompts).
  mistralApiKey: z.string().optional(),
  xaiApiKey: z.string().optional(),
  deepseekApiKey: z.string().optional(),

  // Circuit breaker
  inactivityLockDays: z.coerce.number().int().min(1).default(30),

  // Audit
  auditSnapshotIntervalHours: z.coerce.number().int().min(1).default(24),
  snapshotKey: z.string().min(32).optional(),
  backupPath: z.string().default('./backups'),

  // Thompson shadow
  thompsonShadowEnabled: strictBool(true),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Packet 1 (linear) + Packet A (additive). Golden Stack default-ON: the
  // permanent-on baseline runs `additive`. Both modes coexist via this enum;
  // set HYBRID_FUSION_MODE=linear|disabled to override for ablation.
  hybridFusionMode: z.enum(['linear', 'additive', 'disabled']).default('additive'),
  // Golden Stack default-ON. NOTE: z.coerce.boolean() can NOT be used here:
  // Boolean('false') === true, which would defeat the X=false escape hatch.
  // onByDefault honors `!== 'false'` (I-277), so an unset flag is on and an
  // explicit `=false` disables it for ablation.
  entityBoostEnabled: z.preprocess((v) => onByDefault(v as string | undefined), z.boolean()),
  biTemporalEnabled: z.preprocess((v) => onByDefault(v as string | undefined), z.boolean()),
  // Packet C3 / Bug 1: only apply the bi-temporal "now" filter when the query
  // is current-state-intent. Historical / list / temporal queries need the
  // superseded facts retrievable. When false, falls back to v1 always-filter.
  biTemporalIntentAware: strictBool(true),
  entityBoostWeight: z.coerce.number().min(0).max(1).default(0.5),
  entityBoostMaxEntities: z.coerce.number().int().min(1).default(8),
  // Packet C3 / Bug 3: persona memories get retrieval-time boost so they
  // surface when the user asks anything where the persona constraint matters.
  personaBoostEnabled: strictBool(false),

  // W4.5 Vault: master + per-layer flags. All default false. Bench profiles
  // and bench-env.ts mirror this default exhaustively so a single missed
  // profile cannot silently enable encryption mid-suite.
  vaultEnabled: strictBool(false),
  vaultDbEncryptionEnabled: strictBool(false),
  vaultExtractionDetectionEnabled: strictBool(false),
  vaultInjectionDetectionEnabled: strictBool(false),
  // W4 Track B: read-time injection defense (L2 + L3). Default off. Mirrored
  // here for typing/completeness like the vault flags, but hot-path gating
  // reads process.env.READ_INJECTION_DEFENSE_ENABLED === 'true' directly.
  readInjectionDefenseEnabled: strictBool(false),
  vaultKeySource: z.enum(['file', 'env', 'kms']).default('file'),
  vaultKeyDir: z.string().optional(),
  vaultFilePath: z.string().optional(),

  // Wedge 2 (S74): PLAN_EXECUTOR_ENABLED is intentionally NOT in this Zod
  // schema. z.coerce.boolean() coerces any non-empty string to true, so
  // `PLAN_EXECUTOR_ENABLED=false` (as bench launchers pass) would land as
  // true, which is the W2 #1 regression. The flag is read raw at the
  // call site (src/retrieval/plan-shim.ts) via `process.env.X === 'true'`,
  // matching the rest of the codebase's flag pattern per the DEMIURGE_STATE
  // locked decision.
});

export type Config = z.infer<typeof ConfigSchema>;

function envToConfig(): Record<string, unknown> {
  const env = process.env;
  return {
    port: env.PORT,
    host: env.HOST,
    apiKey: env.DEMIURGE_API_KEY,
    clientTokens: parseClientTokens(env.DEMIURGE_CLIENT_TOKENS),
    telemetryEnabled: process.env.TELEMETRY_ENABLED,
    telemetryDbPath: process.env.TELEMETRY_DB_PATH,
    telemetryRetentionDays: process.env.TELEMETRY_RETENTION_DAYS,
    telemetryFlushIntervalMs: process.env.TELEMETRY_FLUSH_INTERVAL_MS,
    telemetryRingBufferSize: process.env.TELEMETRY_RING_BUFFER_SIZE,
    telemetryBodyCapture: process.env.TELEMETRY_BODY_CAPTURE,
    telemetryFull: process.env.TELEMETRY_FULL,
    adminToken: process.env.DEMIURGE_ADMIN_TOKEN,
    dbPath: env.DB_PATH,
    walMode: env.WAL_MODE,
    // S50: treat empty string as unset (Zod's .optional() doesn't coerce '' → undefined,
    // and the .regex() would otherwise reject '' before the prod-key guard runs).
    dbEncryptionKey: env.DEMIURGE_DB_KEY && env.DEMIURGE_DB_KEY.length > 0 ? env.DEMIURGE_DB_KEY : undefined,
    modelPath: env.MODEL_PATH,
    embeddingDim: env.EMBEDDING_DIM,
    maxInjectedRules: env.MAX_INJECTED_RULES,
    lexicalWeight: env.LEXICAL_WEIGHT,
    vectorWeight: env.VECTOR_WEIGHT,
    provenanceWeight: env.PROVENANCE_WEIGHT,
    freshnessWeight: env.FRESHNESS_WEIGHT,
    confirmedBonus: env.CONFIRMED_BONUS,
    contradictionPenaltyBase: env.CONTRADICTION_PENALTY_BASE,
    contradictionPenaltyMax: env.CONTRADICTION_PENALTY_MAX,
    freshnessHalfLifeDays: env.FRESHNESS_HALF_LIFE_DAYS,
    candidateOverfetchMultiplier: env.CANDIDATE_OVERFETCH_MULTIPLIER,
    confidenceThreshold: env.CONFIDENCE_THRESHOLD,
    spotCheckRate: env.SPOT_CHECK_RATE,
    consensusThreshold: env.CONSENSUS_THRESHOLD,
    consensusProvider: env.CONSENSUS_PROVIDER,
    consensusModel: env.CONSENSUS_MODEL,
    consensusMinAgreement: env.CONSENSUS_MIN_AGREEMENT,
    consensusEvaluators: env.CONSENSUS_EVALUATORS,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    googleApiKey: env.GOOGLE_API_KEY,
    // S65 M13: extra provider keys for M13 consensus lineup
    mistralApiKey: env.MISTRAL_API_KEY,
    xaiApiKey: env.XAI_API_KEY,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    inactivityLockDays: env.INACTIVITY_LOCK_DAYS,
    auditSnapshotIntervalHours: env.AUDIT_SNAPSHOT_INTERVAL_HOURS,
    snapshotKey: env.SNAPSHOT_KEY,
    backupPath: env.BACKUP_PATH,
    thompsonShadowEnabled: env.THOMPSON_SHADOW_ENABLED,
    logLevel: env.LOG_LEVEL,
    hybridFusionMode: env.HYBRID_FUSION_MODE,
    entityBoostEnabled: env.ENTITY_BOOST_ENABLED,
    biTemporalEnabled: env.BI_TEMPORAL_ENABLED,
    biTemporalIntentAware: env.BI_TEMPORAL_INTENT_AWARE,
    entityBoostWeight: env.ENTITY_BOOST_WEIGHT,
    entityBoostMaxEntities: env.ENTITY_BOOST_MAX_ENTITIES,
    personaBoostEnabled: env.PERSONA_BOOST_ENABLED,
    vaultEnabled: env.VAULT_ENABLED,
    vaultDbEncryptionEnabled: env.VAULT_DB_ENCRYPTION_ENABLED,
    vaultExtractionDetectionEnabled: env.VAULT_EXTRACTION_DETECTION_ENABLED,
    vaultInjectionDetectionEnabled: env.VAULT_INJECTION_DETECTION_ENABLED,
    readInjectionDefenseEnabled: env.READ_INJECTION_DEFENSE_ENABLED,
    vaultKeySource: env.VAULT_KEY_SOURCE,
    vaultKeyDir: env.DEMIURGE_KEY_DIR,
    vaultFilePath: env.DEMIURGE_VAULT_PATH,
  };
}

let _config: Config | null = null;

/**
 * The boolean env flags converted from z.coerce.boolean() to strictBool in
 * WC-1, paired with their env var + default. Used only by the boot audit log to
 * surface where the strict parse diverges from the old coercion on the live env.
 */
const AUDIT_BOOL_FIELDS: ReadonlyArray<{ env: string; field: string; default: boolean }> = [
  { env: 'WAL_MODE', field: 'walMode', default: true },
  { env: 'TELEMETRY_ENABLED', field: 'telemetryEnabled', default: true },
  { env: 'TELEMETRY_BODY_CAPTURE', field: 'telemetryBodyCapture', default: false },
  { env: 'TELEMETRY_FULL', field: 'telemetryFull', default: false },
  { env: 'THOMPSON_SHADOW_ENABLED', field: 'thompsonShadowEnabled', default: true },
  { env: 'BI_TEMPORAL_INTENT_AWARE', field: 'biTemporalIntentAware', default: true },
  { env: 'PERSONA_BOOST_ENABLED', field: 'personaBoostEnabled', default: false },
  { env: 'VAULT_ENABLED', field: 'vaultEnabled', default: false },
  { env: 'VAULT_DB_ENCRYPTION_ENABLED', field: 'vaultDbEncryptionEnabled', default: false },
  { env: 'VAULT_EXTRACTION_DETECTION_ENABLED', field: 'vaultExtractionDetectionEnabled', default: false },
  { env: 'VAULT_INJECTION_DETECTION_ENABLED', field: 'vaultInjectionDetectionEnabled', default: false },
  { env: 'READ_INJECTION_DEFENSE_ENABLED', field: 'readInjectionDefenseEnabled', default: false },
];

/**
 * WC-1 audit-mode boot log: for every strict-boolean flag, log a line when the
 * new strict parse would resolve differently from the legacy z.coerce.boolean()
 * given the live env (e.g. CAX11's THOMPSON_SHADOW_ENABLED=false, which the old
 * coercion read as ON and the strict parser correctly reads as OFF, ruling 6),
 * or when the value is not strictly true/false and will be rejected.
 */
function auditBooleanCoercion(): void {
  const logger = createLogger('config');
  for (const f of AUDIT_BOOL_FIELDS) {
    const raw = process.env[f.env];
    const strict = parseStrictBool(raw, f.default);
    const legacy = legacyCoerceBool(raw, f.default);
    if (strict === null) {
      logger.warn(
        { field: f.field, env: f.env, value: raw },
        'WC-1 config boolean: value is not strictly true/false; strict parser will reject it at boot',
      );
    } else if (strict !== legacy) {
      logger.warn(
        { field: f.field, env: f.env, value: raw, legacyCoercion: legacy, strict },
        'WC-1 config boolean: strict parse differs from legacy z.coerce.boolean()',
      );
    }
  }
}

export function loadConfig(): Config {
  if (_config) return _config;

  auditBooleanCoercion();

  const raw = envToConfig();
  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`[FATAL] Invalid configuration:\n${issues}`);
    process.exit(1);
  }

  // S50: production must have an encryption key set (unless DB is :memory:,
  // which is ephemeral and never holds real data). Refuse to boot otherwise -
  // a plaintext production DB is a security incident waiting to happen.
  if (process.env.NODE_ENV === 'production' && !result.data.dbEncryptionKey && result.data.dbPath !== ':memory:') {
    console.error(
      '[FATAL] DEMIURGE_DB_KEY is required when NODE_ENV=production. Generate one with `openssl rand -hex 32` and set it in your environment. To intentionally run without encryption (e.g. on :memory:), set DB_PATH=:memory:.',
    );
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

export interface EvaluatorEntry {
  provider: string;
  model: string;
}

const RECOGNIZED_PROVIDERS = new Set(['anthropic', 'google', 'openai', 'mistral', 'xai', 'deepseek']);

/**
 * Parse CONSENSUS_EVALUATORS env var into evaluator entries.
 * Format: "anthropic:claude-haiku-4-5-20251001,google:gemini-2.5-flash,openai:gpt-4o-mini"
 * Returns empty array if not configured (consensus disabled / single-eval fallback).
 */
export function parseEvaluators(
  raw: string | undefined,
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
    mistral?: string;
    xai?: string;
    deepseek?: string;
  },
): EvaluatorEntry[] {
  if (!raw || raw.trim().length === 0) return [];

  const entries: EvaluatorEntry[] = [];
  const logger = createLogger('config');

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      logger.warn({ entry: trimmed }, 'Malformed evaluator entry (missing colon), skipping');
      continue;
    }

    const provider = trimmed.slice(0, colonIdx).toLowerCase();
    const model = trimmed.slice(colonIdx + 1);

    if (!RECOGNIZED_PROVIDERS.has(provider)) {
      logger.warn({ provider }, 'Unknown consensus provider, skipping');
      continue;
    }

    if (!model) {
      logger.warn({ provider }, 'Empty model name for provider, skipping');
      continue;
    }

    const key = apiKeys[provider as keyof typeof apiKeys];
    if (!key) {
      logger.warn({ provider }, 'No API key for provider, skipping evaluator');
      continue;
    }

    entries.push({ provider, model });
  }

  return entries;
}

export function createLogger(name: string) {
  const level = _config?.logLevel ?? 'info';
  return pino(
    {
      name,
      level,
      // Wedge 1.5 Phase 1: redact known-secret paths before serialization.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.body.token',
          'req.body.api_key',
          'req.body.apiKey',
          'req.query.token',
          'env.*_KEY',
          'env.*_TOKEN',
          'env.*_SECRET',
          'env.*_PASSWORD',
          '*.apiKey',
          '*.api_key',
          '*.password',
          '*.secret',
          '*.token',
          'authorization',
          'auth_token',
          'bearer',
        ],
        censor: '[REDACTED]',
      },
      transport:
        process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
    process.env.NODE_ENV === 'development' ? undefined : pino.destination(2),
  );
}
