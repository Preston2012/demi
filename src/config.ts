import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import pino from 'pino';

loadDotenv();

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().int().min(1).max(65535).default(3100),
  host: z.string().default('127.0.0.1'),
  authToken: z.string().min(32, 'AUTH_TOKEN must be at least 32 characters'),

  // Database
  dbPath: z.string().default('./data/demiurge.db'),
  walMode: z.coerce.boolean().default(true),

  // Embeddings
  modelPath: z.string().default('./models/bge-large-en-v1.5.onnx'),
  embeddingDim: z.coerce.number().int().default(1024),
  embeddingQueueSize: z.coerce.number().int().min(1).default(100),

  // Retrieval
  maxInjectedRules: z.coerce.number().int().min(1).max(100).default(65),
  lexicalWeight: z.coerce.number().min(0).max(1).default(0.3),
  vectorWeight: z.coerce.number().min(0).max(1).default(0.4),
  provenanceWeight: z.coerce.number().min(0).max(1).default(0.15),
  freshnessWeight: z.coerce.number().min(0).max(1).default(0.1),
  confirmedBonus: z.coerce.number().min(0).max(1).default(0.15),
  contradictionPenaltyBase: z.coerce.number().min(0).max(1).default(0.1),
  contradictionPenaltyMax: z.coerce.number().min(0).max(1).default(0.3),
  freshnessHalfLifeDays: z.coerce.number().min(1).default(30),
  candidateOverfetchMultiplier: z.coerce.number().min(1).max(10).default(3),

  // Trust branching
  confidenceThreshold: z.coerce.number().min(0).max(1).default(0.7),
  spotCheckRate: z.coerce.number().min(0).max(1).default(0.1),
  consensusThreshold: z.coerce.number().min(0).max(1).default(0.5),

  // Consensus
  consensusProvider: z.enum(['anthropic', 'openai', 'google']).default('anthropic'),
  consensusModel: z.string().default('claude-sonnet-4-20250514'),
  consensusMinAgreement: z.coerce.number().int().min(1).max(3).default(2),
  consensusEvaluators: z.string().optional(), // "anthropic:model,google:model,openai:model"
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  googleApiKey: z.string().optional(),

  // Promotion gate
  promotionMinAccessCount: z.coerce.number().int().min(1).default(3),
  promotionMinAgeDays: z.coerce.number().int().min(1).default(7),
  promotionConsensusRequired: z.coerce.boolean().default(true),

  // Circuit breaker
  inactivityLockDays: z.coerce.number().int().min(1).default(30),

  // Rate limits
  writeRatePerMinute: z.coerce.number().int().min(1).default(100),
  readRatePerMinute: z.coerce.number().int().min(1).default(1000),

  // Audit
  auditSnapshotIntervalHours: z.coerce.number().int().min(1).default(24),
  snapshotKey: z.string().min(32).optional(),
  backupPath: z.string().default('./backups'),

  // Thompson shadow
  thompsonShadowEnabled: z.coerce.boolean().default(true),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

function envToConfig(): Record<string, unknown> {
  const env = process.env;
  return {
    port: env.PORT,
    host: env.HOST,
    authToken: env.AUTH_TOKEN,
    dbPath: env.DB_PATH,
    walMode: env.WAL_MODE,
    modelPath: env.MODEL_PATH,
    embeddingDim: env.EMBEDDING_DIM,
    embeddingQueueSize: env.EMBEDDING_QUEUE_SIZE,
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
    promotionMinAccessCount: env.PROMOTION_MIN_ACCESS_COUNT,
    promotionMinAgeDays: env.PROMOTION_MIN_AGE_DAYS,
    promotionConsensusRequired: env.PROMOTION_CONSENSUS_REQUIRED,
    inactivityLockDays: env.INACTIVITY_LOCK_DAYS,
    writeRatePerMinute: env.WRITE_RATE_PER_MINUTE,
    readRatePerMinute: env.READ_RATE_PER_MINUTE,
    auditSnapshotIntervalHours: env.AUDIT_SNAPSHOT_INTERVAL_HOURS,
    snapshotKey: env.SNAPSHOT_KEY,
    backupPath: env.BACKUP_PATH,
    thompsonShadowEnabled: env.THOMPSON_SHADOW_ENABLED,
    logLevel: env.LOG_LEVEL,
  };
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const raw = envToConfig();
  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`[FATAL] Invalid configuration:\n${issues}`);
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

const RECOGNIZED_PROVIDERS = new Set(['anthropic', 'google', 'openai']);

/**
 * Parse CONSENSUS_EVALUATORS env var into evaluator entries.
 * Format: "anthropic:claude-haiku-4-5-20251001,google:gemini-2.5-flash,openai:gpt-4o-mini"
 * Returns empty array if not configured (consensus disabled / single-eval fallback).
 */
export function parseEvaluators(
  raw: string | undefined,
  apiKeys: { anthropic?: string; openai?: string; google?: string },
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
      transport:
        process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
    process.env.NODE_ENV === 'development' ? undefined : pino.destination(2),
  );
}
