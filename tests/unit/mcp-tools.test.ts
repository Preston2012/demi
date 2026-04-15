import { describe, it, expect, vi, beforeAll } from 'vitest';
import { TOOL_DEFINITIONS, getToolDefinition } from '../../src/mcp/tool-definitions.js';

// Mock MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

// Dynamic import for adapter (uses createLogger)
let createMcpServer: typeof import('../../src/mcp/adapter.js').createMcpServer;

beforeAll(async () => {
  process.env.AUTH_TOKEN = 'a'.repeat(32);
  process.env.LOG_LEVEL = 'error';
  const { loadConfig } = await import('../../src/config.js');
  loadConfig();
  const mod = await import('../../src/mcp/adapter.js');
  createMcpServer = mod.createMcpServer;
});

// --- Tool Definitions ---

describe('Tool Definitions', () => {
  it('has 37 tools defined', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(37);
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('required fields are defined for tools that need them', () => {
    const searchTool = getToolDefinition('memory_search');
    expect((searchTool!.inputSchema as Record<string, unknown>).required).toContain('query');

    const addTool = getToolDefinition('memory_add');
    expect((addTool!.inputSchema as Record<string, unknown>).required).toContain('claim');

    const decideTool = getToolDefinition('review_decide');
    const required = (decideTool!.inputSchema as Record<string, unknown>).required as string[];
    expect(required).toContain('memoryId');
    expect(required).toContain('action');
  });

  it('stats and export have no required fields', () => {
    const stats = getToolDefinition('memory_stats');
    expect((stats!.inputSchema as Record<string, unknown>).required).toBeUndefined();

    const exp = getToolDefinition('brain_export');
    expect((exp!.inputSchema as Record<string, unknown>).required).toBeUndefined();
  });

  it('getToolDefinition returns undefined for unknown tool', () => {
    expect(getToolDefinition('nonexistent')).toBeUndefined();
  });
});

// --- MCP Adapter Routing ---

describe('MCP Adapter', () => {
  it('registers list and call handlers', () => {
    const server = createMcpServer({} as any);
    expect(server.setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it('memory_search requires query string', async () => {
    const server = createMcpServer({ search: vi.fn() } as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    const result = await callHandler({
      params: { name: 'memory_search', arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('unknown tool returns error', async () => {
    const server = createMcpServer({} as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    const result = await callHandler({
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('successful tool call returns JSON content', async () => {
    const mockDispatch = {
      getStats: vi.fn().mockResolvedValue({
        totalMemories: 42,
        pendingReview: 3,
        circuitBreakerActive: false,
      }),
    };

    const server = createMcpServer(mockDispatch as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    const result = await callHandler({
      params: { name: 'memory_stats', arguments: {} },
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalMemories).toBe(42);
  });

  it('memory_add passes args through to dispatch.addMemory', async () => {
    const mockDispatch = {
      addMemory: vi.fn().mockResolvedValue({
        id: 'test-id',
        trustClass: 'auto-approved',
        action: 'stored',
        reason: 'Auto-approved',
      }),
    };

    const server = createMcpServer(mockDispatch as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    const result = await callHandler({
      params: {
        name: 'memory_add',
        arguments: { claim: 'User likes TS', subject: 'user' },
      },
    });

    expect(mockDispatch.addMemory).toHaveBeenCalledWith(
      expect.objectContaining({ claim: 'User likes TS', subject: 'user' }),
    );
    expect(result.isError).toBeUndefined();
  });

  it('review_decide promote maps to confirmMemory', async () => {
    const mockDispatch = {
      confirmMemory: vi.fn().mockResolvedValue(undefined),
    };

    const server = createMcpServer(mockDispatch as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    await callHandler({
      params: {
        name: 'review_decide',
        arguments: { memoryId: 'mem-1', action: 'promote', reason: 'Good' },
      },
    });

    expect(mockDispatch.confirmMemory).toHaveBeenCalledWith('mem-1', 'Good');
  });

  it('review_decide reject maps to rejectMemory', async () => {
    const mockDispatch = {
      rejectMemory: vi.fn().mockResolvedValue(undefined),
    };

    const server = createMcpServer(mockDispatch as any);
    const callHandler = (server.setRequestHandler as ReturnType<typeof vi.fn>).mock.calls[1]![1] as Function;

    await callHandler({
      params: {
        name: 'review_decide',
        arguments: { memoryId: 'mem-1', action: 'reject' },
      },
    });

    expect(mockDispatch.rejectMemory).toHaveBeenCalledWith('mem-1', undefined);
  });
});
