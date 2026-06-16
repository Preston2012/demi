/**
 * MCP tool schemas. Separated from handler logic so they can be
 * registered declaratively and tested independently.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Surface gate. 'internal' tools are hidden unless DEMIURGE_MCP_INTERNAL_TOOLS=true. Absent means product. */
  audience?: 'product' | 'internal';
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'memory_search',
    description:
      'Search memories and return ranked context for injection. Returns matching memories, formatted injection text, conflict flags, governance framing (recency, unresolved conflicts, per-fact confidence, abstention guidance), learned interaction preferences (steering), and optional answer-style guidance (off by default).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: {
          type: 'number',
          description: 'Max memories to return. Default 15.',
        },
        conversationId: {
          type: 'string',
          description: 'Optional conversation ID for compression router and STONE context.',
        },
        injection: {
          type: 'object',
          description:
            'Optional per-request injection override. Select which layers to return; omitted fields fall back to the deployment default. facts are always included.',
          properties: {
            framing: {
              type: 'boolean',
              description: 'L2 governance framing (recency, conflicts, confidence, abstention).',
            },
            steering: {
              type: 'object',
              properties: {
                interactionPrefs: { type: 'boolean', description: 'Learned interaction preferences.' },
                continuity: { type: 'boolean', description: 'Current focus and recent corrections.' },
              },
            },
            answerStyle: {
              type: 'boolean',
              description: 'Answer-style guidance (off by default; host owns voice).',
            },
            format: {
              type: 'string',
              enum: ['structured', 'context-string'],
              description: 'Output representation: structured fields or a compact context string.',
            },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_set_preference',
    description:
      'Set a user interaction preference: how the user wants the assistant to respond. Stored as a memory with the dimension as subject, so a new value supersedes the old one for that dimension. Keep values terse (1-2 words). Common dimensions: verbosity, tone, response_format, technical_depth, preferred_language, units.',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: {
          type: 'string',
          description: 'Preference dimension, e.g. "verbosity", "tone", "response_format".',
        },
        value: {
          type: 'string',
          description: 'Preferred value, terse, e.g. "concise", "direct", "metric".',
        },
      },
      required: ['dimension', 'value'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Add a new memory. Goes through trust branching: auto-confirm, auto-store with spot-check, quarantine, or reject. Returns the result including trust class and review status.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: 'Normalized claim statement (e.g., "User prefers TypeScript")',
        },
        subject: {
          type: 'string',
          description: 'Entity the claim is about (e.g., "user", "project-x")',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project', 'session'],
          description: 'Memory scope. Default "global".',
        },
        source: {
          type: 'string',
          enum: ['user', 'llm', 'import'],
          description: 'Memory source. Default "llm".',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score 0-1. Optional.',
        },
        validFrom: {
          type: 'string',
          description: 'ISO datetime when this fact became true. Optional.',
        },
        validTo: {
          type: 'string',
          description: 'ISO datetime when this fact stopped being true. Optional.',
        },
        isInhibitory: {
          type: 'boolean',
          description: 'If true, this memory suppresses retrieval of its target subject.',
        },
        inhibitionTarget: {
          type: 'string',
          description: 'Subject to suppress when isInhibitory is true.',
        },
        memoryType: {
          type: 'string',
          enum: ['declarative', 'procedural'],
          description: 'Memory type. Default "declarative".',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization and retrieval.',
        },
        causedBy: {
          type: 'string',
          description: 'UUID of memory that caused this one (causal chain).',
        },
        leadsTo: {
          type: 'string',
          description: 'UUID of memory this one leads to (causal chain).',
        },
      },
      required: ['claim'],
    },
  },
  {
    name: 'memory_confirm',
    description:
      'Confirm a memory. Promotes to user-confirmed trust class. Use for explicit user corrections or statements.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to confirm' },
        reason: { type: 'string', description: 'Reason for confirmation. Optional.' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_reject',
    description:
      'Reject a memory. Marks as rejected trust class. Memory stays in store for audit but is excluded from retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to reject' },
        reason: { type: 'string', description: 'Reason for rejection. Optional.' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_get',
    description: 'Get a single memory by ID with full metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to retrieve' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'review_list',
    description: 'List memories pending human review (quarantined or spot-checked).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results. Default 50.',
        },
      },
    },
  },
  {
    name: 'review_decide',
    description: 'Promote or reject a quarantined memory after review.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to decide on' },
        action: {
          type: 'string',
          enum: ['promote', 'reject'],
          description: 'Promote to confirmed or reject.',
        },
        reason: { type: 'string', description: 'Reason for decision. Optional.' },
      },
      required: ['memoryId', 'action'],
    },
  },
  {
    name: 'memory_stats',
    description:
      'Get system statistics: total memories, counts by trust class and provenance, pending reviews, circuit breaker status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'brain_export',
    description: 'Export all memories as JSON array. Full brain backup.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_freeze',
    description: 'Freeze a memory. Frozen memories skip decay but remain retrievable.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to freeze' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_unfreeze',
    description: 'Unfreeze a memory. Resumes normal decay.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to unfreeze' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_pause',
    description: 'Get or set global pause state. When paused, no new memories are captured from LLM extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        paused: { type: 'boolean', description: 'Set pause state. Omit to just read current state.' },
      },
    },
  },
  {
    name: 'memory_history',
    description: 'Get version history for a memory. Shows how it changed over time.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_correct',
    description: 'Correct a memory claim. Creates version snapshot, updates claim, increments correction count.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to correct' },
        newClaim: { type: 'string', description: 'Corrected claim text' },
        reason: { type: 'string', description: 'Reason for correction' },
      },
      required: ['memoryId', 'newClaim', 'reason'],
    },
  },
  {
    name: 'memory_tags',
    description: 'Get or set tags on a memory.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to set. Omit to just read.' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_search_tag',
    description: 'Search memories by tag.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag to search for' },
        limit: { type: 'number', description: 'Max results. Default 15.' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'memory_hubs',
    description: 'List memory hubs (principles that connect to multiple spokes).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
  },
  {
    name: 'memory_hub_members',
    description: 'List memories linked to a hub.',
    inputSchema: {
      type: 'object',
      properties: {
        hubId: { type: 'string', description: 'Hub ID' },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
      required: ['hubId'],
    },
  },
  {
    name: 'memory_cold_storage',
    description: 'List memories in cold storage (interference-based forgetting). These are stale but not deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results. Default 50.' },
      },
    },
  },
  {
    name: 'memory_resurrect',
    description: 'Resurrect a memory from cold storage back to active.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to resurrect' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'memory_meta',
    description: 'Get meta-memory stats: what the system knows about its own memories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'self_play_run',
    audience: 'internal',
    description:
      'Run a self-play evaluation batch. Tests retrieval quality by generating queries from stored memories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'self_play_latest',
    audience: 'internal',
    description: 'Get results of the most recent self-play run.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hub_candidates',
    audience: 'internal',
    description: 'Identify memories that could be promoted to hubs based on access patterns.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hub_promote',
    audience: 'internal',
    description: 'Promote a memory to a hub. Requires consensus per architecture rules.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to promote' },
        hubType: { type: 'string', description: 'Hub type. Default "principle".' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'interference_run',
    audience: 'internal',
    description: 'Run interference batch: move stale low-access memories to cold storage.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_autopsy',
    audience: 'internal',
    description:
      'Diagnose why a query failed. Traces through extraction, retrieval, injection, and answer model to identify the failure point. Requires the query, expected answer, and predicted answer.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question that was answered incorrectly' },
        expected: { type: 'string', description: 'The expected correct answer' },
        predicted: { type: 'string', description: 'The answer the system actually gave' },
        searchTerms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key terms from the expected answer to search for in memory store',
        },
      },
      required: ['query', 'expected', 'predicted', 'searchTerms'],
    },
  },
  {
    name: 'stone_search_turns',
    audience: 'internal',
    description:
      'Search raw conversation history stored in STONE (immutable log). Returns matching message turns with context. Requires STONE_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'stone_get_conversation',
    audience: 'internal',
    description: 'Get a specific conversation and all its messages from STONE. Requires STONE_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        conversationId: { type: 'string', description: 'Conversation ID' },
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'stone_list_conversations',
    audience: 'internal',
    description: 'List all conversations stored in STONE with message counts. Requires STONE_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
    },
  },
  {
    name: 'stone_get_neighbors',
    audience: 'internal',
    description:
      'Get neighboring messages around a specific turn in a conversation (episode context window). Requires STONE_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        conversationId: { type: 'string', description: 'Conversation ID' },
        sequenceNumber: { type: 'number', description: 'The turn sequence number to center on' },
        window: { type: 'number', description: 'Number of messages before and after (default: 2)' },
      },
      required: ['conversationId', 'sequenceNumber'],
    },
  },
  {
    name: 'temporal_search',
    description: 'Search temporal events (SVO tuples with timestamps) by text query. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'temporal_range',
    description: 'Get temporal events within a datetime range. ISO 8601 format. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startDatetime: { type: 'string', description: 'Start datetime (ISO 8601)' },
        endDatetime: { type: 'string', description: 'End datetime (ISO 8601)' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['startDatetime', 'endDatetime'],
    },
  },
  {
    name: 'temporal_by_subject',
    description: 'Get all temporal events for a specific subject/person. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Subject name (person, entity)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'temporal_timeline',
    description: 'Get the full event timeline ordered chronologically. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default: 100)' },
      },
    },
  },
  {
    name: 'temporal_add_events',
    description:
      'Add extracted temporal events to the store. Takes an array of SVO event objects. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        events: {
          type: 'array',
          description: 'Array of temporal event objects',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              subject: { type: 'string' },
              verb: { type: 'string' },
              object: { type: 'string' },
              eventDatetime: { type: 'string' },
              eventType: { type: 'string' },
              granularity: { type: 'string' },
              rawTemporalExpression: { type: 'string' },
            },
            required: ['id', 'subject', 'verb'],
          },
        },
      },
      required: ['events'],
    },
  },
  {
    name: 'temporal_event_count',
    description: 'Get the total count of temporal events stored. Requires TEMPORAL_ENABLED=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'memory_get_config',
    description:
      'Return the deployment default injection config (which layers this deployment serves by default) plus server name and version. Capability discovery for a host before it issues per-request injection overrides.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'memory_delete_user',
    description:
      'Permanently delete all memories and derived data for the current user (right to be forgotten or reset). Requires confirm: true. Irreversible.',
    audience: 'product',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true to proceed. Permanently deletes all stored memories for this user.',
        },
      },
      required: ['confirm'],
    },
  },
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}
