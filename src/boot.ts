import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FastifyInstance } from 'fastify';
import { loadConfig, createLogger } from './config.js';
import type { Config } from './config.js';
import type { IMemoryRepository } from './repository/interface.js';
import { SqliteMemoryRepository } from './repository/sqlite/index.js';
import { initialize as initializeEmbeddings, dispose as disposeEmbeddings } from './embeddings/index.js';
import { createCoreDispatch } from './core/dispatch.js';
import { StoneStore } from './stone/index.js';
import { TemporalStore } from './temporal/index.js';
import type { CoreDispatch } from './core/dispatch.js';
import { startMcpServer } from './mcp/index.js';
import { createRestServer } from './rest/index.js';
import { createSnapshot, saveSnapshot } from './repository/audit-log.js';

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
 * 3. Embeddings (ONNX model preload — non-fatal if missing)
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

  let repo: SqliteMemoryRepository | null = null;
  let embeddingsLoaded = false;
  let mcpServer: Server | null = null;
  let restServer: FastifyInstance | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // 1. Database + migrations
    repo = new SqliteMemoryRepository(config);
    await repo.initialize();
    log.info('SQLite repository initialized');

    // 1b. STONE store (if enabled)
    let stoneStore: StoneStore | null = null;
    if (process.env.STONE_ENABLED === 'true') {
      stoneStore = new StoneStore(repo.getDatabase());
      log.info('STONE store initialized');
    }

    // 1c. Temporal event store (if enabled)
    let temporalStore: TemporalStore | null = null;
    if (process.env.TEMPORAL_ENABLED === 'true') {
      temporalStore = new TemporalStore(repo.getDatabase());
      log.info('Temporal event store initialized');
    }

    // 2. Embedding model (non-fatal — degrades to lexical-only + hash dedup)
    try {
      await initializeEmbeddings(config.modelPath);
      embeddingsLoaded = true;
      log.info('Embedding model loaded');
    } catch (err) {
      log.warn({ err }, 'Embedding model not loaded — vector search disabled');
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
          const latestHash = await repo!.getLatestAuditHash();
          if (latestHash) {
            const snapshot = createSnapshot([], config.snapshotKey!);
            await saveSnapshot(snapshot, config.backupPath);
            lastSnapshotAt = new Date().toISOString();
            log.info({ lastSnapshotAt, latestHash }, 'Audit snapshot saved');
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
