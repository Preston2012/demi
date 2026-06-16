import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FastifyInstance } from 'fastify';
import { loadConfig, createLogger } from './config.js';
import type { Config } from './config.js';
import type { IMemoryRepository } from './repository/interface.js';
import { SqliteMemoryRepository } from './repository/sqlite/index.js';
import { initialize as initializeEmbeddings, dispose as disposeEmbeddings } from './embeddings/index.js';
import { createCoreDispatch } from './core/dispatch.js';
import { initStorage } from './telemetry/index.js';
import { StoneStore } from './stone/index.js';
import { TemporalStore } from './temporal/index.js';
import type { CoreDispatch } from './core/dispatch.js';
import { startMcpServer } from './mcp/index.js';
import { createRestServer } from './rest/index.js';
import Database from 'better-sqlite3-multiple-ciphers';
import { createSnapshot, saveSnapshot } from './repository/audit-log.js';
import { assertWebhookConfig } from './security/alert-webhook.js';
import { bootApplyWeightTuner } from './learn/weight-tuner.js';
import { AuditAction } from './schema/audit.js';
import { dirname, join } from 'node:path';
import { bindVault, DefaultLocalVault, EnvKeySource, FileKeySource, KmsKeySource } from './security/vault/index.js';
import type { KeySource } from './security/vault/index.js';
import { availableProviders } from './llm/provider-availability.js';

/**
 * Demiurge runtime handle.
 * Returned by boot() for testing and signal handler wiring.
 */
export interface Runtime {
  config: Config;
  repo: IMemoryRepository;
  dispatch: CoreDispatch;
  mcpServer: Server;
  restServer: FastifyInstance;
  shutdown(): Promise<void>;
}

/**
 * Boot the Demiurge system.
 *
 * Initialization order:
 * 1. Config (Zod + env vars)
 * 2. SQLite repository (DB, migrations, sqlite-vec, FTS5)
 * 3. Embeddings (ONNX model preload, non-fatal if missing)
 * 4. Core dispatch (wires retrieval, write, inject, learn layers)
 * 5. MCP server (stdio transport)
 * 6. REST server (Fastify on localhost)
 *
 * On failure: rolls back everything that was initialized.
 */
export async function boot(): Promise<Runtime> {
  const config = loadConfig();
  const log = createLogger('boot');
  log.info('Demiurge boot starting');

  // Flag dependency validation (N-2: REEXTRACT requires STONE)
  if (process.env.REEXTRACT_ENABLED === 'true' && process.env.STONE_ENABLED !== 'true') {
    throw new Error('REEXTRACT_ENABLED requires STONE_ENABLED=true. STONE tables must exist for re-extraction.');
  }

  // W4 Track E: validate LLM provider availability at boot. Detect which
  // provider API keys are configured and log the set once. With zero keys the
  // engine cannot answer anything, so fail loudly here rather than lazily at
  // first query. Every cell chain is filtered to this set at call time, so a
  // single-vendor deployment (e.g. Claude-only, brain #3019) still resolves.
  const providers = availableProviders();
  if (providers.size === 0) {
    throw new Error(
      'No LLM provider API keys configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
        'GOOGLE_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY.',
    );
  }
  log.info({ providers: [...providers] }, 'LLM providers configured');

  // A8: fail-closed webhook configuration. If WEBHOOK_URL is set, the
  // receiver MUST be able to verify signatures via WEBHOOK_SECRET. Boot
  // throws here rather than silently shipping unsigned alerts into a
  // production pipeline. Set ALLOW_UNSIGNED_WEBHOOKS=true for local dev.
  assertWebhookConfig();

  let repo: SqliteMemoryRepository | null = null;
  let embeddingsLoaded = false;
  let mcpServer: Server | null = null;
  let restServer: FastifyInstance | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // 0. W4.5 Vault: resolve the KeySource BEFORE repo.initialize() so the
    // DB encryption key can be sourced from disk / env / kms before the
    // SQLCipher pragmas run. When VAULT_ENABLED=false this block is a
    // no-op and the S50 DEMIURGE_DB_KEY env path keeps working unchanged.
    let resolvedKeySource: KeySource | null = null;
    if (config.vaultEnabled) {
      resolvedKeySource = makeKeySource(config.vaultKeySource, config.vaultKeyDir);
      if (config.vaultDbEncryptionEnabled && config.dbPath !== ':memory:') {
        const dbKey = resolvedKeySource.getKey('db').toString('hex');
        config.dbEncryptionKey = dbKey;
      }
      log.info(
        { source: resolvedKeySource.sourceName, dbEncryption: config.vaultDbEncryptionEnabled },
        'Vault KeySource resolved',
      );
    }

    // 1. Database + migrations
    repo = new SqliteMemoryRepository(config);
    await repo.initialize();
    log.info('SQLite repository initialized');

    // 1a. W4.5 Vault: bind the provider AFTER repo.initialize(), the vault
    // writes to a JSONL file, not the DB, so it doesn't need the handle.
    if (config.vaultEnabled && resolvedKeySource) {
      const vaultPath = config.vaultFilePath ?? join(dirname(config.dbPath), 'vault.jsonl');
      const provider = new DefaultLocalVault(resolvedKeySource, vaultPath);
      bindVault(provider, resolvedKeySource);
      log.info({ vaultPath, provider: provider.providerName }, 'Vault provider bound');
      try {
        await repo.appendAuditLog(
          {
            memoryId: null,
            action: AuditAction.VAULT_KEY_SOURCE_LOADED,
            details: JSON.stringify({
              source: resolvedKeySource.sourceName,
              dbEncryption: config.vaultDbEncryptionEnabled,
              extractionDetection: config.vaultExtractionDetectionEnabled,
              injectionDetection: config.vaultInjectionDetectionEnabled,
              provider: provider.providerName,
            }),
          },
          'system',
        );
      } catch (err) {
        log.error({ err }, 'Failed to write vault-key-source-loaded audit entry');
      }
    }

    // Wedge 1.5 Phase 2: initialize telemetry storage (no-op when TELEMETRY_ENABLED=false)
    initStorage({
      dbPath: config.telemetryDbPath,
      enabled: config.telemetryEnabled,
      flushIntervalMs: config.telemetryFlushIntervalMs,
      ringBufferSize: config.telemetryRingBufferSize,
      dbEncryptionKey: config.dbEncryptionKey,
    });
    // C-14/WC-11: body capture stores (redacted) request/response bodies in
    // the telemetry DB. That must never be a silent state. Warn on the
    // config-schema value, whose z.coerce.boolean() mis-parse means ANY set
    // value (including 'false') trips it: deliberately loud until WC-1
    // fixes the parse; the capture path itself uses the strict parse.
    if (config.telemetryBodyCapture) {
      log.warn(
        'TELEMETRY_BODY_CAPTURE is set: request/response bodies are captured ' +
          '(redacted) into the telemetry DB when the value is exactly "true". ' +
          'Unset it unless you are debugging.',
      );
    }

    // 1b. STONE store, A4 (S71): always initialized. Audit log integrity is
    // structural; can't be gated on env. STONE_ENABLED retained as a feature
    // flag for retrieval-side expansion (compression-router, episode boost),
    // not store existence.
    const stoneStore: StoneStore = new StoneStore(repo.getDatabase());
    log.info('STONE store initialized (A4: unconditional)');

    // 1c. Temporal event store (hardcoded ON S69, every bench profile set
    // TEMPORAL_ENABLED='true', so this is the validated production state).
    const temporalStore: TemporalStore = new TemporalStore(repo.getDatabase());
    log.info('Temporal event store initialized');

    // 2. Embedding model (non-fatal, degrades to lexical-only + hash dedup)
    try {
      await initializeEmbeddings(config.modelPath);
      embeddingsLoaded = true;
      log.info('Embedding model loaded');
    } catch (err) {
      log.warn({ err }, 'Embedding model not loaded, vector search disabled');
    }

    // 2b. B1c: weight tuner auto-apply (flag-gated, OFF by default).
    // Runs the offline analyzer against the trace DB and applies
    // recommendations through three safety gates: minSampleSize (default
    // 500), minConfidence (default 'medium'), maxDeltaPerComponent
    // (default 0.05). Mutates the in-process `config` weights only -
    // does NOT modify any file on disk. A single audit-log entry
    // records the deltas for forensic visibility.
    if (process.env.WEIGHT_TUNER_AUTO_APPLY === 'true') {
      log.warn(
        { window: process.env.WEIGHT_TUNER_WINDOW_DAYS ?? '7' },
        'WEIGHT_TUNER_AUTO_APPLY=true, boot will scan telemetry and may shift retrieval weights',
      );
      const tunerResult = bootApplyWeightTuner(
        {
          lexicalWeight: config.lexicalWeight,
          vectorWeight: config.vectorWeight,
          provenanceWeight: config.provenanceWeight,
          freshnessWeight: config.freshnessWeight,
          confirmedBonus: config.confirmedBonus,
          contradictionPenaltyBase: config.contradictionPenaltyBase,
          contradictionPenaltyMax: config.contradictionPenaltyMax,
          freshnessHalfLifeDays: config.freshnessHalfLifeDays,
        },
        config.telemetryDbPath,
        (path) => {
          // W4.5: when DB encryption is on, the snapshot reader must apply
          // the same SQLCipher key pragmas as the main repo (S50 dialect),
          // otherwise the readonly open fails on an encrypted telemetry DB.
          const db = new Database(path, { readonly: true });
          if (config.dbEncryptionKey && path !== ':memory:') {
            db.pragma(`key = "x'${config.dbEncryptionKey}'"`);
            db.pragma('cipher_compatibility = 4');
          }
          return db;
        },
      );
      for (const line of tunerResult.audit) log.info({ tuner: true }, line);
      if (tunerResult.changed) {
        // Apply the merged weights in-process so dispatch picks them up.
        config.lexicalWeight = tunerResult.applied.lexicalWeight;
        config.vectorWeight = tunerResult.applied.vectorWeight;
        config.provenanceWeight = tunerResult.applied.provenanceWeight;
        config.freshnessWeight = tunerResult.applied.freshnessWeight;
        config.confirmedBonus = tunerResult.applied.confirmedBonus;
        config.contradictionPenaltyBase = tunerResult.applied.contradictionPenaltyBase;
        config.contradictionPenaltyMax = tunerResult.applied.contradictionPenaltyMax;
        config.freshnessHalfLifeDays = tunerResult.applied.freshnessHalfLifeDays;
        try {
          await repo.appendAuditLog(
            {
              memoryId: null,
              action: AuditAction.WEIGHT_TUNER_APPLIED,
              details: JSON.stringify({ applied: tunerResult.applied, audit: tunerResult.audit }),
            },
            'system',
          );
        } catch (err) {
          log.error({ err }, 'Failed to write weight-tuner audit entry (config still applied)');
        }
      }
    }

    // 3. Core dispatch
    const dispatch = createCoreDispatch(repo, config, stoneStore, temporalStore);
    log.info('Core dispatch ready');

    // 4. MCP server (stdio)
    mcpServer = await startMcpServer(dispatch);
    log.info('MCP server started on stdio');

    // 5. REST server (localhost) + SSE MCP transport
    const restResult = await createRestServer(dispatch, config);
    restServer = restResult.app;
    const sseManager = restResult.sseManager;
    log.info({ host: config.host, port: config.port }, 'REST server listening (SSE + Streamable HTTP MCP enabled)');

    // 6. Snapshot scheduler (if key configured)
    let lastSnapshotAt: string | null = null;
    if (config.snapshotKey) {
      const intervalMs = config.auditSnapshotIntervalHours * 3600000;
      const takeSnapshot = async () => {
        try {
          // R29 WB-4 (F-D6-2): snapshot the REAL chain, gated on any-chain
          // activity so empty instances never sign an empty payload. The
          // snapshot covers every user's entries (createSnapshot signs the
          // whole ordered array), not just 'system'.
          const entries = await repo!.getAllAuditEntries();
          if (entries.length > 0) {
            const snapshot = createSnapshot(entries, config.snapshotKey!);
            await saveSnapshot(snapshot, config.backupPath);
            lastSnapshotAt = new Date().toISOString();
            log.info({ lastSnapshotAt, entries: entries.length, lastHash: snapshot.lastHash }, 'Audit snapshot saved');
          }
        } catch (err) {
          log.error({ err }, 'Snapshot failed');
        }
      };
      snapshotTimer = setInterval(takeSnapshot, intervalMs);
      log.info({ intervalHours: config.auditSnapshotIntervalHours }, 'Snapshot scheduler started');
    }

    log.info('Demiurge boot complete');

    // Shutdown handler
    async function shutdown(): Promise<void> {
      log.info('Shutdown initiated');

      // Stop snapshot scheduler
      if (snapshotTimer) clearInterval(snapshotTimer);

      // Close SSE sessions before shutting down the server
      try {
        await sseManager.closeAll();
        log.info('SSE sessions closed');
      } catch (err) {
        log.error({ err }, 'SSE session close error');
      }

      // Stop accepting new requests
      try {
        await restServer!.close();
        log.info('REST server closed');
      } catch (err) {
        log.error({ err }, 'REST server close error');
      }

      try {
        await mcpServer!.close();
        log.info('MCP server closed');
      } catch (err) {
        log.error({ err }, 'MCP server close error');
      }

      // Flush dispatch buffers (Thompson shadow log)
      try {
        await dispatch.shutdown();
        log.info('Dispatch shutdown complete');
      } catch (err) {
        log.error({ err }, 'Dispatch shutdown error');
      }

      // Release ONNX session
      if (embeddingsLoaded) {
        try {
          await disposeEmbeddings();
          log.info('Embedding model released');
        } catch (err) {
          log.error({ err }, 'Embedding dispose error');
        }
      }

      // Close database last
      try {
        await repo!.close();
        log.info('Database closed');
      } catch (err) {
        log.error({ err }, 'Database close error');
      }

      log.info('Shutdown complete');
    }

    return { config, repo, dispatch, mcpServer, restServer, shutdown };
  } catch (err) {
    log.fatal({ err }, 'Boot failed, rolling back');

    // Reverse teardown of anything that was initialized
    if (restServer) await restServer.close().catch(() => {});
    if (mcpServer) await mcpServer.close().catch(() => {});
    if (embeddingsLoaded) await disposeEmbeddings().catch(() => {});
    if (repo) await repo.close().catch(() => {});

    throw err;
  }
}

function makeKeySource(kind: 'file' | 'env' | 'kms', keyDir: string | undefined): KeySource {
  switch (kind) {
    case 'file':
      return new FileKeySource(keyDir);
    case 'env':
      return new EnvKeySource();
    case 'kms':
      return new KmsKeySource();
  }
}
