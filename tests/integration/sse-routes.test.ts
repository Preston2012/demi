import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSseRoutes } from '../../src/mcp/sse-routes.js';
import { registerRoutes } from '../../src/rest/routes.js';
import type { CoreDispatch } from '../../src/core/dispatch.js';
import type { SseSessionManager } from '../../src/mcp/sse-routes.js';

function mockDispatch(): CoreDispatch {
  return {
    search: vi.fn().mockResolvedValue({
      payload: { memories: [], conflicts: [], metadata: { queryUsed: 'test', candidatesEvaluated: 0, retrievalTimeMs: 1 } },
      contextText: '',
      raw: { candidates: [], metadata: { query: 'test', candidatesGenerated: 0, candidatesAfterFilter: 0, candidatesReturned: 0, timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 } } },
    }),
    addMemory: vi.fn().mockResolvedValue({ id: 'mem-1', trustClass: 'auto-approved', action: 'stored', reason: 'Auto-approved' }),
    getMemory: vi.fn().mockResolvedValue({}),
    confirmMemory: vi.fn().mockResolvedValue(undefined),
    rejectMemory: vi.fn().mockResolvedValue(undefined),
    getPendingReviews: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({
      totalMemories: 0, byTrustClass: {}, byProvenance: {}, byScope: {},
      pendingReview: 0, averageConfidence: 0, oldestMemory: null, newestMemory: null,
      circuitBreakerActive: false, lastActivityAt: null, uptimeSeconds: 1, thompsonShadowEnabled: false,
    }),
    exportBrain: vi.fn().mockResolvedValue((async function* () { /* empty */ })()),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as CoreDispatch;
}

describe('SSE Routes', () => {
  let app: FastifyInstance;
  let sseManager: SseSessionManager;

  beforeAll(async () => {
    app = Fastify();

    // Add auth hook matching production behavior
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path === '/api/v1/health') return;

      const header = req.headers.authorization;
      if (!header || header !== 'Bearer test-token-aaaaaaaaaaaaaaaaaaaaaa') {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    });

    const dispatch = mockDispatch();
    sseManager = registerSseRoutes(app, dispatch);
    registerRoutes(app, dispatch, sseManager);
    await app.ready();
  });

  afterAll(async () => {
    await sseManager.closeAll();
    await app.close();
  });

  const authHeader = { authorization: 'Bearer test-token-aaaaaaaaaaaaaaaaaaaaaa' };

  // --- Auth ---

  it('GET /sse returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/sse' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /messages returns 401 without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/messages?sessionId=fake' });
    expect(res.statusCode).toBe(401);
  });

  // --- Session validation ---

  it('POST /messages returns 400 without sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('sessionId');
  });

  it('POST /messages returns 404 with unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages?sessionId=nonexistent',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('Unknown session');
  });

  // --- Health endpoint ---

  it('GET /api/v1/health shows MCP transport info', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mcp.transport).toEqual(['stdio', 'sse', 'streamable-http']);
    expect(body.mcp.activeSessions).toBe(0);
  });

  // --- Session manager ---

  it('getSessionCount returns 0 with no active sessions', () => {
    expect(sseManager.getSessionCount()).toBe(0);
  });
});
