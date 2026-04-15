import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CoreDispatch } from '../core/dispatch.js';
import { createMcpServer } from './adapter.js';
import { createLogger } from '../config.js';

const log = createLogger('mcp-http');

/**
 * Register Streamable HTTP MCP transport.
 * Used by claude.ai custom connectors.
 * Stateless: each request gets its own transport instance.
 */
export function registerStreamableHttpRoute(
  app: FastifyInstance,
  dispatch: CoreDispatch,
): void {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    // Fastify has already parsed req.body as JSON before we get here
    reply.hijack();

    const raw = reply.raw;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    raw.on('close', () => transport.close());

    const server = createMcpServer(dispatch);

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, raw, req.body);
    } catch (err) {
      log.error({ err }, 'Streamable HTTP MCP error');
      if (!raw.headersSent) {
        raw.writeHead(500, { 'Content-Type': 'application/json' });
        raw.end(JSON.stringify({ error: 'MCP request failed' }));
      }
    } finally {
      await server.close().catch(() => {});
    }
  });

  log.info('Streamable HTTP MCP route registered at POST /mcp');
}
