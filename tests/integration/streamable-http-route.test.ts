import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerStreamableHttpRoute } from '../../src/mcp/streamable-http-route.js';
import { registerRoutes } from '../../src/rest/routes.js';
import type { CoreDispatch } from '../../src/core/dispatch.js';

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

const VALID_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaa';
const MCP_ACCEPT = 'application/json, text/event-stream';

describe('Streamable HTTP Route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();

    // Auth hook matching production behavior (with query param support)
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path === '/api/v1/health') return;

      const queryToken = (req.query as Record<string, string>).token;
      const authHeader = queryToken
        ? `Bearer ${queryToken}`
        : req.headers.authorization;

      if (!authHeader || authHeader !== `Bearer ${VALID_TOKEN}`) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    });

    const dispatch = mockDispatch();
    registerStreamableHttpRoute(app, dispatch);
    registerRoutes(app, dispatch);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('POST /mcp returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: MCP_ACCEPT },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /mcp returns 401 with invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp?token=wrong-token-aaaaaaaaaaaaaaaaaaa',
      headers: { accept: MCP_ACCEPT },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /mcp accepts Bearer header auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, accept: MCP_ACCEPT },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
  });

  // --- tools/list ---

  it('POST /mcp returns tool list via query token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/mcp?token=${VALID_TOKEN}`,
      headers: { accept: MCP_ACCEPT },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.tools).toBeInstanceOf(Array);
    expect(body.result.tools.length).toBeGreaterThan(0);
    expect(body.result.tools[0]).toHaveProperty('name');
  });

  // --- tools/call ---

  it('POST /mcp handles tools/call for memory_stats', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/mcp?token=${VALID_TOKEN}`,
      headers: { accept: MCP_ACCEPT },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'memory_stats', arguments: {} },
        id: 2,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.content).toBeInstanceOf(Array);
  });

  // --- Health ---

  it('GET /api/v1/health shows streamable-http transport', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mcp.transport).toContain('streamable-http');
  });
});
