import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/rest/routes.js';
import type { CoreDispatch } from '../../src/core/dispatch.js';

function mockDispatch(): CoreDispatch {
  return {
    search: vi.fn().mockResolvedValue({
      payload: { memories: [], conflicts: [], metadata: { queryUsed: 'test', candidatesEvaluated: 0, retrievalTimeMs: 1 } },
      contextText: '',
      raw: { candidates: [], metadata: { query: 'test', candidatesGenerated: 0, candidatesAfterFilter: 0, candidatesReturned: 0, timings: { lexicalMs: 0, vectorMs: 0, mergeAndScoreMs: 0, totalMs: 0 } } },
    }),
    addMemory: vi.fn().mockResolvedValue({
      id: 'mem-1', trustClass: 'auto-approved',
      action: 'stored', reason: 'Auto-approved',
    }),
    getMemory: vi.fn().mockImplementation(async () => {
      const { MemoryNotFoundError } = await import('../../src/errors.js');
      throw new MemoryNotFoundError('not-found');
    }),
    confirmMemory: vi.fn().mockResolvedValue(undefined),
    rejectMemory: vi.fn().mockResolvedValue(undefined),
    getPendingReviews: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({
      totalMemories: 10,
      byTrustClass: {}, byProvenance: {}, byScope: {},
      pendingReview: 2, averageConfidence: 0.8,
      oldestMemory: null, newestMemory: null,
      circuitBreakerActive: false,
      lastActivityAt: new Date().toISOString(),
      uptimeSeconds: 42,
      thompsonShadowEnabled: false,
    }),
    exportBrain: vi.fn().mockResolvedValue((async function* () { /* empty */ })()),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as CoreDispatch;
}

describe('REST Routes', () => {
  let app: FastifyInstance;
  let dispatch: ReturnType<typeof mockDispatch>;

  beforeAll(async () => {
    dispatch = mockDispatch();
    app = Fastify();
    registerRoutes(app, dispatch);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Health ---

  it('GET /api/v1/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  // --- Search ---

  it('POST /api/v1/memory/search calls dispatch.search', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/search',
      payload: { query: 'typescript' },
    });
    expect(res.statusCode).toBe(200);
    expect(dispatch.search).toHaveBeenCalledWith('typescript', undefined);
  });

  it('POST /api/v1/memory/search returns 400 without query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/search',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v1/memory/search returns 400 with non-string query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/search',
      payload: { query: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Write ---

  it('POST /api/v1/memory creates memory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { claim: 'User likes TS', subject: 'user' },
    });
    expect(res.statusCode).toBe(201);
    expect(dispatch.addMemory).toHaveBeenCalled();
  });

  // --- Get ---

  it('GET /api/v1/memory/:id returns 404 when not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/v1/memory/:id returns memory when found', async () => {
    (dispatch.getMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { id: 'mem-1', claim: 'test' },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/mem-1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('mem-1');
  });

  // --- Confirm / Reject ---

  it('POST /api/v1/memory/:id/confirm calls dispatch.confirmMemory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/mem-1/confirm',
    });
    expect(res.statusCode).toBe(200);
    expect(dispatch.confirmMemory).toHaveBeenCalledWith('mem-1', undefined);
  });

  it('POST /api/v1/memory/:id/reject calls dispatch.rejectMemory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/mem-1/reject',
      payload: { reason: 'junk' },
    });
    expect(res.statusCode).toBe(200);
    expect(dispatch.rejectMemory).toHaveBeenCalledWith('mem-1', 'junk');
  });

  // --- Review ---

  it('GET /api/v1/review returns pending list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/review' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('memories');
    expect(res.json()).toHaveProperty('count');
  });

  it('POST /api/v1/review/:id/decide returns 400 on bad action', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/review/mem-1/decide',
      payload: { action: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v1/review/:id/decide promotes via confirmMemory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/review/mem-1/decide',
      payload: { action: 'promote' },
    });
    expect(res.statusCode).toBe(200);
    expect(dispatch.confirmMemory).toHaveBeenCalledWith('mem-1', undefined);
  });

  // --- Stats / Export ---

  it('GET /api/v1/stats returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalMemories).toBe(10);
  });

  it('GET /api/v1/export returns brain dump', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('memories');
    expect(res.json()).toHaveProperty('count');
  });
});
