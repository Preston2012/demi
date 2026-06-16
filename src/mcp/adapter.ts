import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreDispatch } from '../core/dispatch.js';
import type { MemoryRecord, PartialInjectionConfig } from '../schema/memory.js';
import { TOOL_DEFINITIONS, getToolDefinition } from './tool-definitions.js';
import { getDeploymentInjectionConfig } from '../inject/steering.js';
import { createLogger } from '../config.js';
import { withTrace, recordError } from '../telemetry/index.js';
import { checkRateLimit } from '../security/rate-limit.js';

// Packet 0: MCP runs as user_id='system'. Dispatch methods called from this
// adapter omit the userId argument and rely on the dispatch defaults. Future
// packets will inject per-tool user_id (e.g. via Claude Desktop config).
//
// Security invariant: callers MUST NOT be able to spoof user_id via tool
// arguments. tool-definitions.ts does not declare a `user_id` property in
// any inputSchema, but MCP clients can still attach extra fields. We strip
// `user_id` from every incoming args object before dispatch sees it, and
// we use the fixed sentinel `MCP_PRINCIPAL` for rate-limit bucketing and
// any downstream call that needs an explicit user.

const log = createLogger('mcp-adapter');

const MCP_PRINCIPAL = 'system';

/**
 * Strip any caller-supplied identity fields from an args object so they
 * cannot leak into dispatch/write pipelines. Returns a new object, does
 * not mutate the input.
 */
function sanitizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id, userId, ...rest } = args as Record<string, unknown>;
  return rest;
}

export function createMcpServer(dispatch: CoreDispatch, principal: string = MCP_PRINCIPAL): Server {
  const server = new Server({ name: 'demiurge', version: '1.0.0' }, { capabilities: { tools: {} } });

  // List tools
  // Hide internal/dev tools from the product surface unless explicitly enabled.
  const exposeInternalTools = process.env.DEMIURGE_MCP_INTERNAL_TOOLS === 'true';

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.filter((t) => exposeInternalTools || t.audience !== 'internal').map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Internal tools are not part of the product surface; treat as unknown when hidden.
    if (!exposeInternalTools && getToolDefinition(name)?.audience === 'internal') {
      throw new Error(`Unknown tool: ${name}`);
    }
    log.debug({ tool: name }, 'Tool call received');

    // Wedge 1.5 Phase 2: wrap every MCP tool call in a trace. withTrace
    // short-circuits to fn() when telemetry is disabled.
    return withTrace({ entry: 'mcp', tags: { tool: name } }, async () => {
      try {
        // Wedge 1.5 Phase 3: rate-limit MCP tools at dispatch chokepoint.
        // Inside withTrace (so the rate_limit_event captures trace_id) but
        // before the actual handler runs.
        const toolName = name;
        // Security: rate-limit bucket is the resolved principal (from the
        // authenticated credential, never from args), so a hostile client
        // cannot dodge the limit by rotating fake user_ids. Defaults to
        // 'system' (MCP_PRINCIPAL) for stdio and the no-client-token case.
        const action: 'read' | 'write' | 'ingest' =
          toolName.includes('ingest') || toolName.includes('extract')
            ? 'ingest'
            : toolName.includes('write') ||
                toolName.includes('confirm') ||
                toolName.includes('reject') ||
                toolName.includes('delete')
              ? 'write'
              : 'read';
        const decision = checkRateLimit(principal, action, { endpoint: `mcp:${toolName}` });
        if (!decision.allowed) {
          throw new Error(`Rate limit exceeded for ${toolName}. Retry after ${decision.retry_after_seconds}s.`);
        }

        const result = await routeToolCall(dispatch, name, sanitizeArgs(args), principal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ tool: name, err }, 'Tool error');
        recordError({
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
          message,
          tags: { tool: name },
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    });
  });

  return server;
}

async function routeToolCall(
  dispatch: CoreDispatch,
  name: string,
  args: Record<string, unknown>,
  principal: string = 'system',
): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const injectionOverride = parseInjectionOverride(args.injection);
      const result = await dispatch.search(
        requireString(args, 'query'),
        optionalNumber(args, 'limit'),
        optionalString(args, 'conversationId'),
        principal,
        undefined,
        injectionOverride,
      );
      return {
        memories: result.payload.memories,
        contextText: result.contextText,
        conflicts: result.payload.conflicts,
        framing: result.payload.framing,
        steering: result.payload.steering,
        answerStyle: result.payload.answerStyle,
        metadata: result.payload.metadata,
      };
    }

    case 'memory_add':
      // Identity from the credential, not args (args.user_id was stripped).
      return dispatch.addMemory({ ...args, user_id: principal });

    case 'memory_set_preference':
      return dispatch.setPreference(requireString(args, 'dimension'), requireString(args, 'value'), principal);

    case 'memory_confirm':
      await dispatch.confirmMemory(requireString(args, 'memoryId'), optionalString(args, 'reason'), principal);
      return { success: true };

    case 'memory_reject':
      await dispatch.rejectMemory(requireString(args, 'memoryId'), optionalString(args, 'reason'), principal);
      return { success: true };

    case 'memory_get':
      return dispatch.getMemory(requireString(args, 'memoryId'), principal);

    case 'review_list':
      return dispatch.getPendingReviews(optionalNumber(args, 'limit'), principal);

    case 'review_decide': {
      const action = requireString(args, 'action');
      const memoryId = requireString(args, 'memoryId');
      const reason = optionalString(args, 'reason');

      if (action === 'promote') {
        await dispatch.confirmMemory(memoryId, reason, principal);
      } else {
        await dispatch.rejectMemory(memoryId, reason, principal);
      }
      return { success: true };
    }

    case 'memory_stats':
      return dispatch.getStats(principal);

    case 'brain_export': {
      const iterable = await dispatch.exportBrain(principal);
      const memories: MemoryRecord[] = [];
      for await (const record of iterable) {
        memories.push(record);
      }
      return { memories, count: memories.length };
    }

    // --- Novel tools ---

    case 'memory_freeze':
      await dispatch.freezeMemory(requireString(args, 'memoryId'));
      return { success: true };

    case 'memory_unfreeze':
      await dispatch.unfreezeMemory(requireString(args, 'memoryId'));
      return { success: true };

    case 'memory_pause': {
      const paused = args.paused;
      if (typeof paused === 'boolean') {
        await dispatch.setGlobalPause(paused);
        return { paused };
      }
      return { paused: await dispatch.getGlobalPause() };
    }

    case 'memory_history':
      return dispatch.getVersionHistory(requireString(args, 'memoryId'));

    case 'memory_correct':
      await dispatch.correctMemory(
        requireString(args, 'memoryId'),
        requireString(args, 'newClaim'),
        requireString(args, 'reason'),
      );
      return { success: true };

    case 'memory_tags': {
      const memId = requireString(args, 'memoryId');
      const tags = args.tags as string[] | undefined;
      if (tags && Array.isArray(tags)) {
        await dispatch.setMemoryTags(memId, tags);
        return { memoryId: memId, tags };
      }
      return { memoryId: memId, tags: await dispatch.getMemoryTags(memId) };
    }

    case 'memory_search_tag':
      return dispatch.searchByTag(requireString(args, 'tag'), optionalNumber(args, 'limit'));

    case 'memory_hubs':
      return dispatch.getHubs(optionalNumber(args, 'limit'));

    case 'memory_hub_members':
      return dispatch.getHubMembers(requireString(args, 'hubId'), optionalNumber(args, 'limit'));

    case 'memory_cold_storage':
      return dispatch.getColdStorage(optionalNumber(args, 'limit'));

    case 'memory_resurrect':
      await dispatch.resurrectMemory(requireString(args, 'memoryId'));
      return { success: true };

    case 'memory_meta':
      return dispatch.getMetaMemoryStats();

    case 'self_play_run':
      return dispatch.runSelfPlay();

    case 'self_play_latest':
      return dispatch.getLatestSelfPlayRun();

    case 'hub_candidates':
      return dispatch.getHubCandidates();

    case 'hub_promote':
      return dispatch.promoteToHub(requireString(args, 'memoryId'), optionalString(args, 'hubType'));

    case 'interference_run':
      return dispatch.runInterferenceBatch();

    case 'memory_autopsy': {
      const q = args.query as string;
      const expected = args.expected as string;
      const predicted = args.predicted as string;
      const searchTerms = (args.searchTerms as string[]) || [];
      return dispatch.runAutopsy(q, expected, predicted, searchTerms);
    }

    // --- STONE tools ---

    case 'stone_search_turns':
      return dispatch.stoneSearchTurns(requireString(args, 'query'), optionalNumber(args, 'limit'));

    case 'stone_get_conversation':
      return dispatch.stoneGetConversation(requireString(args, 'conversationId'));

    case 'stone_list_conversations':
      return dispatch.stoneListConversations(optionalNumber(args, 'limit'));

    case 'stone_get_neighbors':
      return dispatch.stoneGetNeighbors(
        requireString(args, 'conversationId'),
        (args.sequenceNumber as number) ?? 0,
        optionalNumber(args, 'window'),
      );

    // --- Temporal tools ---

    case 'temporal_search':
      return dispatch.temporalSearch(requireString(args, 'query'), optionalNumber(args, 'limit'));

    case 'temporal_range':
      return dispatch.temporalRange(
        requireString(args, 'startDatetime'),
        requireString(args, 'endDatetime'),
        optionalNumber(args, 'limit'),
      );

    case 'temporal_by_subject':
      return dispatch.temporalBySubject(requireString(args, 'subject'), optionalNumber(args, 'limit'));

    case 'temporal_timeline':
      return dispatch.temporalTimeline(optionalNumber(args, 'limit'));

    case 'temporal_add_events':
      return dispatch.temporalAddEvents(args.events as any[]);

    case 'temporal_event_count':
      return dispatch.temporalEventCount();

    case 'memory_get_config':
      return {
        server: { name: 'demiurge', version: '1.0.0' },
        injectionDefault: getDeploymentInjectionConfig(),
      };

    case 'memory_delete_user': {
      if ((args as Record<string, unknown> | undefined)?.confirm !== true) {
        throw new Error(
          'memory_delete_user requires confirm: true. This permanently deletes all memories for this user.',
        );
      }
      return dispatch.deleteUser(principal);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Start MCP server on stdio transport. */
export async function startMcpServer(dispatch: CoreDispatch): Promise<Server> {
  const server = createMcpServer(dispatch);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started on stdio');
  return server;
}

// --- Input helpers ---

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing required string parameter: ${key}`);
  }
  return val;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new Error(`Parameter ${key} must be a string`);
  }
  return val;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') {
    throw new Error(`Parameter ${key} must be a number`);
  }
  return val;
}

/**
 * Parse the optional per-request `injection` argument into a
 * PartialInjectionConfig. Only known boolean/enum fields are read; anything else
 * is ignored. Returns undefined when absent so dispatch falls back to the
 * deployment default. This is layer selection, not identity.
 */
function parseInjectionOverride(raw: unknown): PartialInjectionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PartialInjectionConfig = {};
  if (typeof o.framing === 'boolean') out.framing = o.framing;
  if (typeof o.answerStyle === 'boolean') out.answerStyle = o.answerStyle;
  if (o.format === 'structured' || o.format === 'context-string') out.format = o.format;
  if (o.steering && typeof o.steering === 'object') {
    const s = o.steering as Record<string, unknown>;
    const steering: { interactionPrefs?: boolean; continuity?: boolean } = {};
    if (typeof s.interactionPrefs === 'boolean') steering.interactionPrefs = s.interactionPrefs;
    if (typeof s.continuity === 'boolean') steering.continuity = s.continuity;
    out.steering = steering;
  }
  return out;
}
