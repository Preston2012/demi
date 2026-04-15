import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { CoreDispatch } from '../core/dispatch.js';
import type { Config } from '../config.js';
import { registerRoutes } from './routes.js';
import { registerSseRoutes } from '../mcp/sse-routes.js';
import type { SseSessionManager } from '../mcp/sse-routes.js';
import { registerStreamableHttpRoute } from '../mcp/streamable-http-route.js';
import { createLogger } from '../config.js';

const log = createLogger('rest-server');

function isAuthorized(header: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export interface RestServerResult {
  app: FastifyInstance;
  sseManager: SseSessionManager;
}

/**
 * Create and start the REST server.
 * Binds to 127.0.0.1 by default (security: no external access without tunnel/proxy).
 */
export async function createRestServer(
  dispatch: CoreDispatch,
  config: Config,
): Promise<RestServerResult> {
  const app = Fastify({ logger: false });

  // Auth middleware: timing-safe Bearer token check
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/api/v1/health') return;

    const queryToken = (req.query as Record<string, string>).token;
    const authHeader = queryToken
      ? `Bearer ${queryToken}`
      : req.headers.authorization;

    if (!isAuthorized(authHeader, config.authToken)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // Request logging
  app.addHook('onResponse', async (req, reply) => {
    const logPath = req.url.split('?')[0];
    log.debug(
      `${req.method} ${logPath} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
    );
  });

  // SSE MCP transport routes
  const sseManager = registerSseRoutes(app, dispatch);

  // Streamable HTTP MCP transport route (claude.ai custom connectors)
  registerStreamableHttpRoute(app, dispatch);

  // REST API routes
  registerRoutes(app, dispatch, sseManager, config);

  await app.listen({ host: config.host, port: config.port });
  log.info(`REST server listening on ${config.host}:${config.port}`);

  return { app, sseManager };
}
