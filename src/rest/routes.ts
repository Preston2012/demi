import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CoreDispatch } from '../core/dispatch.js';
import type { Config } from '../config.js';
import { parseEvaluators } from '../config.js';
import type { MemoryRecord } from '../schema/memory.js';
import type { SseSessionManager } from '../mcp/sse-routes.js';
import { DemiurgeError } from '../errors.js';
import { z } from 'zod';

const SearchBodySchema = z.object({
  query: z.string().min(1).max(10000),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const ConfirmRejectBodySchema = z.object({
  reason: z.string().optional(),
}).optional().default({});

const ReviewDecideBodySchema = z.object({
  action: z.enum(['promote', 'reject']),
  reason: z.string().optional(),
});

/**
 * REST routes. Thin adapter over CoreDispatch.
 * No business logic — every route delegates to dispatch.
 */

export function registerRoutes(
  app: FastifyInstance,
  dispatch: CoreDispatch,
  sseManager?: SseSessionManager,
  config?: Config,
): void {
  // Global error handler — maps DemiurgeError statusCodes to HTTP
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DemiurgeError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    return reply.status(500).send({ error: 'Internal server error' });
  });

  // Health check (no auth)
  app.get('/api/v1/health', async () => {
    const apiKeys = {
      anthropic: config?.anthropicApiKey,
      openai: config?.openaiApiKey,
      google: config?.googleApiKey,
    };
    const evaluators = config?.consensusEvaluators
      ? parseEvaluators(config.consensusEvaluators, apiKeys)
      : [];
    const consensusEnabled = evaluators.length >= 2;

    return {
      status: 'ok',
      mcp: {
        transport: ['stdio', 'sse', 'streamable-http'],
        activeSessions: sseManager?.getSessionCount() ?? 0,
      },
      consensus: {
        enabled: consensusEnabled,
        evaluators: evaluators.map((e) => `${e.provider}:${e.model}`),
        minAgreement: config?.consensusMinAgreement ?? 2,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // Search memories
  app.post('/api/v1/memory/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SearchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    return dispatch.search(parsed.data.query, parsed.data.limit);
  });

  // Add memory
  app.post('/api/v1/memory', async (req: FastifyRequest, reply: FastifyReply) => {
    // Pass body directly — write pipeline's Zod parser validates
    const result = await dispatch.addMemory(req.body);
    return reply.status(201).send(result);
  });

  // Get single memory
  app.get('/api/v1/memory/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return dispatch.getMemory(id); // Throws MemoryNotFoundError → 404 via error handler
  });

  // Confirm memory
  app.post('/api/v1/memory/:id/confirm', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const parsed = ConfirmRejectBodySchema.parse(req.body);
    await dispatch.confirmMemory(id, parsed.reason);
    return { success: true };
  });

  // Reject memory
  app.post('/api/v1/memory/:id/reject', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const parsed = ConfirmRejectBodySchema.parse(req.body);
    await dispatch.rejectMemory(id, parsed.reason);
    return { success: true };
  });

  // Review queue
  app.get('/api/v1/review', async (req: FastifyRequest) => {
    const { limit } = req.query as { limit?: string };
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const results = await dispatch.getPendingReviews(parsedLimit);
    return { memories: results, count: results.length };
  });

  // Review decision
  app.post('/api/v1/review/:id/decide', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewDecideBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'action must be "promote" or "reject"' });
    }

    if (parsed.data.action === 'promote') {
      await dispatch.confirmMemory(id, parsed.data.reason);
    } else {
      await dispatch.rejectMemory(id, parsed.data.reason);
    }
    return { success: true };
  });

  // Stats
  app.get('/api/v1/stats', async () => {
    return dispatch.getStats();
  });

  // Brain export
  app.get('/api/v1/export', async () => {
    const iterable = await dispatch.exportBrain();
    const memories: MemoryRecord[] = [];
    for await (const record of iterable) {
      memories.push(record);
    }
    return { memories, count: memories.length };
  });
}
