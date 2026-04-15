import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CoreDispatch } from '../core/dispatch.js';
import { createMcpServer } from './adapter.js';
import { createLogger } from '../config.js';

const log = createLogger('mcp-sse');

const MAX_SESSIONS = 10;

interface ActiveSession {
  transport: SSEServerTransport;
  server: Server;
  createdAt: string;
}

export interface SseSessionManager {
  getSessionCount(): number;
  closeAll(): Promise<void>;
}

/**
 * Register SSE MCP transport routes on the Fastify server.
 *
 * GET /sse       — establish SSE stream (returns event stream with session ID)
 * POST /messages — receive JSON-RPC messages from client
 *
 * Each SSE connection gets its own MCP Server instance sharing the same
 * CoreDispatch. Sessions are tracked and cleaned up on disconnect.
 */
export function registerSseRoutes(
  app: FastifyInstance,
  dispatch: CoreDispatch,
): SseSessionManager {
  const sessions = new Map<string, ActiveSession>();

  // GET /sse — establish SSE connection
  app.get('/sse', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (sessions.size >= MAX_SESSIONS) {
      return reply.status(503).send({ error: 'Too many active SSE sessions' });
    }

    // Take over the response from Fastify
    reply.hijack();

    const raw: ServerResponse = reply.raw;
    const transport = new SSEServerTransport('/messages', raw);
    const server = createMcpServer(dispatch);
    const sessionId = transport.sessionId;

    transport.onclose = () => {
      if (!sessions.has(sessionId)) return; // re-entry guard: server.close() triggers onclose again
      log.info({ sessionId }, 'SSE session closed');
      sessions.delete(sessionId);
      server.close().catch((err) => {
        log.error({ err, sessionId }, 'Error closing MCP server for session');
      });
    };

    transport.onerror = (error: Error) => {
      log.error({ err: error, sessionId }, 'SSE transport error');
    };

    sessions.set(sessionId, {
      transport,
      server,
      createdAt: new Date().toISOString(),
    });

    try {
      await server.connect(transport);
      log.info({ sessionId, activeSessions: sessions.size }, 'SSE session established');
    } catch (err) {
      log.error({ err, sessionId }, 'Failed to connect MCP server to SSE transport');
      sessions.delete(sessionId);
      if (!raw.headersSent) {
        raw.writeHead(500, { 'Content-Type': 'application/json' });
      }
      raw.end(JSON.stringify({ error: 'Failed to establish MCP session' }));
    }
  });

  // POST /messages?sessionId=xxx — receive JSON-RPC messages
  app.post('/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = (req.query as Record<string, string>).sessionId;

    if (!sessionId) {
      return reply.status(400).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing sessionId query parameter' },
        id: null,
      });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return reply.status(404).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unknown session' },
        id: null,
      });
    }

    // Let the transport handle the response directly
    reply.hijack();

    await session.transport.handlePostMessage(
      req.raw as IncomingMessage,
      reply.raw,
      req.body,
    );
  });

  return {
    getSessionCount: () => sessions.size,
    closeAll: async () => {
      const closing = [...sessions.values()].map(async (s) => {
        try {
          await s.transport.close();
        } catch (err) {
          log.error({ err }, 'Error closing SSE session during shutdown');
        }
      });
      await Promise.allSettled(closing);
      sessions.clear();
    },
  };
}
