/**
 * Wedge 1.5 Phase 3: admin REST routes + Prometheus /metrics.
 *
 * All /admin/* endpoints require an ADMIN_TOKEN bearer token (scope='admin').
 * /metrics is public by default (matches scrape conventions) but can be
 * gated behind admin auth via PROMETHEUS_REQUIRE_AUTH=true.
 *
 * All telemetry queries respect the same TimeWindow shape (since/until/limit)
 * parsed from query params.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { parseEvaluators } from '../config.js';
import { verifyBearer } from '../security/auth.js';
import type { SseSessionManager } from '../mcp/sse-routes.js';
import {
  queryTraces,
  queryDecisions,
  queryRefusals,
  queryCostByProvider,
  queryErrors,
  queryCacheHitRates,
  queryRateLimitSummary,
  queryPromGauges,
  pruneOlderThan,
  type TimeWindow,
} from '../telemetry/query.js';

function requireAdmin(config: Config) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const result = verifyBearer(req.headers.authorization, 'admin', {
      apiKey: config.apiKey,
      adminToken: config.adminToken,
      benchToken: process.env.BENCH_TOKEN,
      benchModeEnabled: process.env.BENCH_MODE === 'true',
    });
    if (!result.ok) {
      const status = result.reason === 'wrong_scope' ? 403 : 401;
      reply.status(status).send({ error: 'admin auth required', reason: result.reason });
    }
  };
}

function parseWindow(query: Record<string, string | undefined>): TimeWindow {
  return {
    since: query.since,
    until: query.until,
    limit: query.limit ? Number(query.limit) : undefined,
  };
}

export function registerAdminRoutes(app: FastifyInstance, config: Config, sseManager?: SseSessionManager): void {
  const adminGuard = requireAdmin(config);

  // A7: rich health/diagnostic payload moved here from /api/v1/health so
  // unauthenticated callers can't fingerprint the consensus evaluators,
  // MCP transports, or active session counts of a deployment.
  app.get('/admin/health', { preHandler: adminGuard }, async () => {
    const apiKeys = {
      anthropic: config.anthropicApiKey,
      openai: config.openaiApiKey,
      google: config.googleApiKey,
    };
    const evaluators = config.consensusEvaluators ? parseEvaluators(config.consensusEvaluators, apiKeys) : [];
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
        minAgreement: config.consensusMinAgreement ?? 2,
      },
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/admin/telemetry/traces', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryTraces(parseWindow(q)) };
  });

  app.get('/admin/telemetry/decisions', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryDecisions({ ...parseWindow(q), decision_type: q.type }) };
  });

  app.get('/admin/telemetry/refusals', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryRefusals(parseWindow(q)) };
  });

  app.get('/admin/telemetry/cost', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryCostByProvider(parseWindow(q)) };
  });

  app.get('/admin/telemetry/errors', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryErrors({ ...parseWindow(q), error_type: q.type }) };
  });

  app.get('/admin/telemetry/cache-rates', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryCacheHitRates(parseWindow(q)) };
  });

  app.get('/admin/security/rate-limits', { preHandler: adminGuard }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { rows: queryRateLimitSummary(parseWindow(q)) };
  });

  app.post('/admin/telemetry/prune', { preHandler: adminGuard }, async (req, reply) => {
    const body = (req.body ?? {}) as { days?: unknown };
    const days = typeof body.days === 'number' ? body.days : Number(body.days);
    if (!Number.isFinite(days) || days < 1) {
      reply.status(400).send({ error: 'days must be a finite number >= 1' });
      return;
    }
    return pruneOlderThan(days);
  });

  // Prometheus /metrics
  const metricsHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    const g = queryPromGauges();
    const lines = [
      '# HELP demiurge_traces_total Total traces in last 24h',
      '# TYPE demiurge_traces_total counter',
      `demiurge_traces_total ${g.traces_total}`,
      '# HELP demiurge_errors_total Total errors in last 24h',
      '# TYPE demiurge_errors_total counter',
      `demiurge_errors_total ${g.errors_total}`,
      '# HELP demiurge_refusals_total Total refusals in last 24h',
      '# TYPE demiurge_refusals_total counter',
      `demiurge_refusals_total ${g.refusals_total}`,
      '# HELP demiurge_conflicts_total Total conflicts in last 24h',
      '# TYPE demiurge_conflicts_total counter',
      `demiurge_conflicts_total ${g.conflicts_total}`,
      '# HELP demiurge_rate_limit_throttled_total Total rate-limit throttles in last 24h',
      '# TYPE demiurge_rate_limit_throttled_total counter',
      `demiurge_rate_limit_throttled_total ${g.rate_limit_throttled_total}`,
      '# HELP demiurge_llm_calls_total Total LLM calls in last 24h',
      '# TYPE demiurge_llm_calls_total counter',
      `demiurge_llm_calls_total ${g.llm_calls_total}`,
      '# HELP demiurge_llm_cost_usd_24h Total LLM cost in last 24h (USD)',
      '# TYPE demiurge_llm_cost_usd_24h gauge',
      `demiurge_llm_cost_usd_24h ${g.llm_cost_usd_24h}`,
      '# HELP demiurge_request_duration_ms Request duration percentiles in last 24h',
      '# TYPE demiurge_request_duration_ms gauge',
      `demiurge_request_duration_ms{quantile="0.5"} ${g.request_duration_ms_p50}`,
      `demiurge_request_duration_ms{quantile="0.95"} ${g.request_duration_ms_p95}`,
      `demiurge_request_duration_ms{quantile="0.99"} ${g.request_duration_ms_p99}`,
    ];
    reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  };

  if (process.env.PROMETHEUS_REQUIRE_AUTH === 'true') {
    app.get('/metrics', { preHandler: adminGuard }, metricsHandler);
  } else {
    app.get('/metrics', metricsHandler);
  }
}
