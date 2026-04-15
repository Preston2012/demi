import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreDispatch } from '../core/dispatch.js';
import type { MemoryRecord } from '../schema/memory.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { createLogger } from '../config.js';

const log = createLogger('mcp-adapter');

export function createMcpServer(dispatch: CoreDispatch): Server {
  const server = new Server({ name: 'demiurge', version: '1.0.0' }, { capabilities: { tools: {} } });

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.debug({ tool: name }, 'Tool call received');

    try {
      const result = await routeToolCall(dispatch, name, args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, err }, 'Tool error');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

async function routeToolCall(dispatch: CoreDispatch, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const result = await dispatch.search(requireString(args, 'query'), optionalNumber(args, 'limit'), optionalString(args, 'conversationId'));
      return {
        memories: result.payload.memories,
        contextText: result.contextText,
        conflicts: result.payload.conflicts,
        metadata: result.payload.metadata,
      };
    }

    case 'memory_add':
      return dispatch.addMemory(args);

    case 'memory_confirm':
      await dispatch.confirmMemory(requireString(args, 'memoryId'), optionalString(args, 'reason'));
      return { success: true };

    case 'memory_reject':
      await dispatch.rejectMemory(requireString(args, 'memoryId'), optionalString(args, 'reason'));
      return { success: true };

    case 'memory_get':
      return dispatch.getMemory(requireString(args, 'memoryId'));

    case 'review_list':
      return dispatch.getPendingReviews(optionalNumber(args, 'limit'));

    case 'review_decide': {
      const action = requireString(args, 'action');
      const memoryId = requireString(args, 'memoryId');
      const reason = optionalString(args, 'reason');

      if (action === 'promote') {
        await dispatch.confirmMemory(memoryId, reason);
      } else {
        await dispatch.rejectMemory(memoryId, reason);
      }
      return { success: true };
    }

    case 'memory_stats':
      return dispatch.getStats();

    case 'brain_export': {
      const iterable = await dispatch.exportBrain();
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
