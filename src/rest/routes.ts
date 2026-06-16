import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CoreDispatch } from '../core/dispatch.js';
import type { Config } from '../config.js';
import type { MemoryRecord } from '../schema/memory.js';
import { UserIdSchema, SYSTEM_USER_ID } from '../schema/memory.js';
import type { SseSessionManager } from '../mcp/sse-routes.js';
import { DemiurgeError } from '../errors.js';
import { withTrace, recordError } from '../telemetry/index.js';
import { z } from 'zod';

/**
 * Packet 0: every user-scoped route requires a `user_id`. Writes carry it
 * in the body, reads in the query string. The route layer validates with
 * UserIdSchema (charset + length), then delegates to dispatch which scopes
 * SQL by user_id at the repository layer.
 *
 * /api/v1/health is exempt.
 * MCP transport (/sse, /messages) is on a separate auth path and runs as
 * user_id='system' for now (Claude Desktop / Claude.ai connectors).
 */

const SearchBodySchema = z.object({
  user_id: UserIdSchema,
  query: z.string().min(1).max(10000),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const ConfirmRejectBodySchema = z.object({
  user_id: UserIdSchema,
  reason: z.string().optional(),
});

const ReviewDecideBodySchema = z.object({
  user_id: UserIdSchema,
  action: z.enum(['promote', 'reject']),
  reason: z.string().optional(),
});

/**
 * Extract user_id from a request, body for writes, query for reads.
 * Returns null when absent so each route can 400 with a consistent message.
 */
function extractUserIdFromQuery(req: FastifyRequest): string | null {
  const fromQuery = (req.query as Record<string, unknown>)?.user_id;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : null;
}

/**
 * Wedge 1.5 Phase 2 helper: wrap a dispatch call in a trace with error capture.
 * When telemetry is disabled, withTrace short-circuits to fn() directly.
 */
async function traceDispatch<T>(endpoint: string, method: string, fn: () => Promise<T>): Promise<T> {
  return withTrace({ entry: 'rest', tags: { endpoint, method } }, async () => {
    try {
      return await fn();
    } catch (err) {
      recordError({
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
        message: err instanceof Error ? err.message : String(err),
        endpoint,
      });
      throw err;
    }
  });
}

/**
 * REST routes. Thin adapter over CoreDispatch.
 * No business logic, every route delegates to dispatch.
 */

export function registerRoutes(
  app: FastifyInstance,
  dispatch: CoreDispatch,
  // A7: sseManager + config used to feed the rich health response; that
  // moved to /admin/health, so the REST surface no longer needs them.
  // Parameters kept for back-compat with existing callers (server.ts).
  _sseManager?: SseSessionManager,
  _config?: Config,
): void {
  // Global error handler, maps DemiurgeError statusCodes to HTTP
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DemiurgeError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    return reply.status(500).send({ error: 'Internal server error' });
  });

  // A7: minimal public health probe. No auth required, but also no config
  // leakage. The rich diagnostic payload (consensus evaluators, MCP
  // transports, session counts) lives at /admin/health behind the admin
  // token; this endpoint must stay scrape-safe for monitoring tools that
  // don't carry credentials.
  app.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Search memories (per-user)
  app.post('/api/v1/memory/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SearchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    return traceDispatch('/api/v1/memory/search', 'POST', () =>
      dispatch.search(parsed.data.query, parsed.data.limit, undefined, parsed.data.user_id),
    );
  });

  // Add memory (user_id + external_ref carried in body and validated by the
  // write pipeline's own Zod parser; we still require user_id at the route
  // boundary for fast-fail).
  app.post('/api/v1/memory', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userIdParse = UserIdSchema.safeParse(body.user_id);
    if (!userIdParse.success) {
      return reply.status(400).send({ error: 'user_id required and must match /^[a-zA-Z0-9._:@-]+$/' });
    }
    const result = await traceDispatch('/api/v1/memory', 'POST', () => dispatch.addMemory(req.body));
    // 200 for external_ref idempotency hits, 201 for new resources.
    const status = result.action === 'duplicate' ? 200 : 201;
    return reply.status(status).send(result);
  });

  // Get single memory (user_id in query)
  app.get('/api/v1/memory/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = extractUserIdFromQuery(req);
    const userIdParse = UserIdSchema.safeParse(userId);
    if (!userIdParse.success) {
      return reply.status(400).send({ error: 'user_id query param required' });
    }
    const { id } = req.params as { id: string };
    return traceDispatch('/api/v1/memory/:id', 'GET', () => dispatch.getMemory(id, userIdParse.data));
  });

  // Confirm memory
  app.post('/api/v1/memory/:id/confirm', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ConfirmRejectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { id } = req.params as { id: string };
    await traceDispatch('/api/v1/memory/:id/confirm', 'POST', () =>
      dispatch.confirmMemory(id, parsed.data.reason, parsed.data.user_id),
    );
    return { success: true };
  });

  // Reject memory
  app.post('/api/v1/memory/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ConfirmRejectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { id } = req.params as { id: string };
    await traceDispatch('/api/v1/memory/:id/reject', 'POST', () =>
      dispatch.rejectMemory(id, parsed.data.reason, parsed.data.user_id),
    );
    return { success: true };
  });

  // Review queue (user_id optional via query, defaults to system for legacy
  // ops scripts that pre-date the user partition). New tenants pass user_id.
  app.get('/api/v1/review', async (req: FastifyRequest) => {
    const { limit } = req.query as { limit?: string };
    const userId = extractUserIdFromQuery(req) ?? SYSTEM_USER_ID;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const results = await traceDispatch('/api/v1/review', 'GET', () => dispatch.getPendingReviews(parsedLimit, userId));
    return { memories: results, count: results.length };
  });

  // Review decision
  app.post('/api/v1/review/:id/decide', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ReviewDecideBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'action must be "promote" or "reject"' });
    }
    const { id } = req.params as { id: string };

    await traceDispatch('/api/v1/review/:id/decide', 'POST', async () => {
      if (parsed.data.action === 'promote') {
        await dispatch.confirmMemory(id, parsed.data.reason, parsed.data.user_id);
      } else {
        await dispatch.rejectMemory(id, parsed.data.reason, parsed.data.user_id);
      }
    });
    return { success: true };
  });

  // Stats (per-user; defaults to system for legacy ops scripts)
  app.get('/api/v1/stats', async (req: FastifyRequest) => {
    const userId = extractUserIdFromQuery(req) ?? SYSTEM_USER_ID;
    return traceDispatch('/api/v1/stats', 'GET', () => dispatch.getStats(userId));
  });

  // Brain export (per-user; defaults to system for legacy ops scripts)
  app.get('/api/v1/export', async (req: FastifyRequest) => {
    const userId = extractUserIdFromQuery(req) ?? SYSTEM_USER_ID;
    return traceDispatch('/api/v1/export', 'GET', async () => {
      const iterable = await dispatch.exportBrain(userId);
      const memories: MemoryRecord[] = [];
      for await (const record of iterable) {
        memories.push(record);
      }
      return { memories, count: memories.length };
    });
  });

  // Account deletion: cascade-wipe a user's memories + audit + episodes +
  // state_packs + summaries. System user is protected.
  app.delete('/api/v1/users/:user_id/memories', async (req: FastifyRequest, reply: FastifyReply) => {
    const { user_id } = req.params as { user_id: string };
    const parsed = UserIdSchema.safeParse(user_id);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid user_id' });
    }
    if (user_id === SYSTEM_USER_ID) {
      return reply.status(403).send({ error: 'Cannot delete system user' });
    }
    const counts = await traceDispatch('/api/v1/users/:user_id/memories', 'DELETE', () => dispatch.deleteUser(user_id));
    return reply.status(200).send({ ...counts, success: true });
  });
}
