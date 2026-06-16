import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { CoreDispatch } from '../core/dispatch.js';
import type { Config } from '../config.js';
import { registerRoutes } from './routes.js';
import { registerSseRoutes } from '../mcp/sse-routes.js';
import type { SseSessionManager } from '../mcp/sse-routes.js';
import { registerStreamableHttpRoute } from '../mcp/streamable-http-route.js';
import { createLogger } from '../config.js';
import { resolvePrincipal } from '../security/auth.js';
import {
  checkRateLimit,
  classifyAction,
  checkAuthFailureBucket,
  recordAuthFailure,
  limiterKeyFor,
} from '../security/rate-limit.js';
import { getStorage, newUuid } from '../telemetry/index.js';
import type { AuthEvent } from '../telemetry/index.js';
import { registerAdminRoutes } from './admin-routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved client identity, set by the onRequest auth hook (deployment surface). */
    principal?: { userId: string; viaClientToken: boolean };
  }
}

const log = createLogger('rest-server');

export interface RestServerResult {
  app: FastifyInstance;
  sseManager: SseSessionManager;
}

/**
 * Create and start the REST server.
 * Binds to 127.0.0.1 by default (security: no external access without tunnel/proxy).
 */
/**
 * Client-token scoping: stamp the principal's user_id into REST request
 * bodies/queries so a scoped client cannot act as another user.
 *
 * S83: applies ONLY to /api/v1/* routes. MCP transports (/mcp, /sse,
 * /messages) carry JSON-RPC envelopes that the MCP SDK validates with strict
 * schemas; stamping user_id into those corrupted every message (-32700
 * "Invalid JSON-RPC message") and silently killed all claude.ai connector
 * handshakes. MCP routes thread the principal via
 * createMcpServer(dispatch, req.principal.userId) instead, so the stamp is
 * both harmful and unnecessary there.
 */
export function enforceClientTokenScope(req: FastifyRequest): void {
  if (!req.principal?.viaClientToken) return;
  const path = req.url.split('?')[0]!;
  if (!path.startsWith('/api/v1/')) return;
  const uid = req.principal.userId;
  if (req.body && typeof req.body === 'object') {
    (req.body as Record<string, unknown>).user_id = uid;
  }
  if (req.query && typeof req.query === 'object') {
    (req.query as Record<string, unknown>).user_id = uid;
  }
}

export async function createRestServer(dispatch: CoreDispatch, config: Config): Promise<RestServerResult> {
  // C-15: bodyLimit is Fastify's default 1MiB, declared explicitly so the
  // cap is a stated decision rather than an inherited default.
  // C-16: no CORS plugin is registered, deliberately: the server is
  // localhost-only and emits no CORS headers, so browsers cross-origin
  // get secure-by-default denial.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // Tolerate an empty body on application/json requests. Clients (axios,
  // fetch defaults) often send Content-Type: application/json on a bodyless
  // DELETE; the default parser rejects an empty body, which surfaced as a 500.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === undefined || body === null || (typeof body === 'string' && body.trim() === '')) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Wedge 1.5 Phase 2: scoped auth via security/auth.ts
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/api/v1/health') return;

    // A10: failed-auth throttle. If this IP has burned through its
    // per-minute auth-failure quota, refuse to even attempt verification.
    // Prevents brute force without affecting legitimate users (each IP
    // gets AUTH_FAIL_PER_MIN attempts before a AUTH_FAIL_LOCKOUT_SEC
    // cooldown). Runs BEFORE verifyBearer so the constant-time compare
    // is never reached for a locked-out caller.
    const clientIp = req.ip || 'unknown';
    const lockout = checkAuthFailureBucket(clientIp);
    if (!lockout.allowed) {
      return reply
        .status(429)
        .header('Retry-After', String(lockout.retry_after_seconds))
        .send({ error: 'too many failed auth attempts', retry_after_seconds: lockout.retry_after_seconds });
    }

    // A1: query-string token (?token=...) is only honored for the SSE GET
    // path, where native browser EventSource cannot set Authorization
    // headers. Everywhere else, REST API, admin, metrics, streamable HTTP -
    // tokens MUST come via the Authorization header so they do not leak
    // into proxy logs, referer headers, or browser history.
    const isSseGetPath = path === '/sse' && req.method === 'GET';
    const queryToken = isSseGetPath ? (req.query as Record<string, string>).token : undefined;
    const authHeader = queryToken ? `Bearer ${queryToken}` : req.headers.authorization;

    const authResult = resolvePrincipal(authHeader, {
      apiKey: config.apiKey,
      clientTokens: config.clientTokens,
    });

    if (!authResult.ok) {
      // A10: record the failure so repeated bad attempts eventually trip
      // the per-IP bucket and downgrade subsequent 401s to 429s.
      const after = recordAuthFailure(clientIp);

      const storage = getStorage();
      if (storage?.isEnabled()) {
        const eventName = authResult.reason === 'missing' ? 'missing_token' : 'invalid_token';
        const ev: AuthEvent = {
          auth_id: newUuid(),
          event: eventName,
          endpoint: path,
          reason: authResult.reason,
          created_at: new Date().toISOString(),
        };
        storage.enqueue({ kind: 'auth_event', payload: ev });
      }
      if (after.locked) {
        return reply
          .status(429)
          .header('Retry-After', String(after.retry_after_seconds))
          .send({ error: 'too many failed auth attempts', retry_after_seconds: after.retry_after_seconds });
      }
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Deployment surface: stash the resolved principal for the routes and MCP
    // transports. viaClientToken=true means a scoped client; false means the
    // shared key (userId 'system').
    req.principal = { userId: authResult.userId, viaClientToken: authResult.viaClientToken };

    const storage = getStorage();
    if (storage?.isEnabled()) {
      const ev: AuthEvent = {
        auth_id: newUuid(),
        event: 'success',
        endpoint: path,
        created_at: new Date().toISOString(),
      };
      storage.enqueue({ kind: 'auth_event', payload: ev });
    }
  });

  // Wedge 1.5 Phase 3: per-user token-bucket rate limiter. Runs regardless
  // of TELEMETRY_ENABLED, enforcement is independent of telemetry, only
  // event emission is gated.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    // Skip rate-limit on health, admin, and metrics endpoints
    if (path === '/api/v1/health' || path.startsWith('/admin/') || path === '/metrics') return;

    // S84: bucket on the RESOLVED principal, never the cooperative x-user-id
    // header. Pre-S84, master-key drivers and gated client-token connectors
    // both fell into one shared 'anonymous' bucket and starved each other
    // (brain #3531/#3519).
    const principalKey = limiterKeyFor(req.principal);
    const action = classifyAction(req.method, path);
    const decision = checkRateLimit(principalKey, action, { endpoint: path });

    if (!decision.allowed) {
      reply
        .status(429)
        .header('Retry-After', String(decision.retry_after_seconds))
        .send({ error: 'rate limit exceeded', retry_after_seconds: decision.retry_after_seconds });
    }
  });

  // Deployment surface: a client-token request is locked to its userId. Force
  // user_id in body and query so a scoped client cannot read/write as another
  // user. Shared-key requests (viaClientToken false) keep cooperative user_id.
  app.addHook('preHandler', async (req) => {
    enforceClientTokenScope(req);
  });

  // Request logging
  app.addHook('onResponse', async (req, reply) => {
    const logPath = req.url.split('?')[0];
    log.debug(`${req.method} ${logPath} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`);
  });

  // SSE MCP transport routes
  const sseManager = registerSseRoutes(app, dispatch);

  // Streamable HTTP MCP transport route (claude.ai custom connectors)
  registerStreamableHttpRoute(app, dispatch);

  // REST API routes
  registerRoutes(app, dispatch, sseManager, config);

  // Wedge 1.5 Phase 3: admin telemetry endpoints + Prometheus /metrics.
  // A7: /admin/health (rich diagnostics) lives in this module so it shares
  // the admin auth guard with the rest of the telemetry surface.
  registerAdminRoutes(app, config, sseManager);

  await app.listen({ host: config.host, port: config.port });
  log.info(`REST server listening on ${config.host}:${config.port}`);

  return { app, sseManager };
}
