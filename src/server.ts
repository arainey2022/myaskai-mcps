import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type {
  Env,
  FetchLike,
  SafeLogger,
  SafeToolEvent,
  SafeUsageEvent,
} from './types.ts';
import {
  callDocsTool,
  DEFAULT_DOCS_MCP_UPSTREAM,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from './tools/docs-proxy.ts';
import {
  DEFAULT_CHAT_PERCENTAGE,
  pricingToolResult,
  PRICING_TOOL_NAME,
} from './tools/pricing.ts';

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const SEARCH_DESCRIPTION =
  'How do I, where can I find, does My AskAI support, setup, integration, API, feature, or troubleshooting questions: search the My AskAI knowledge base for relevant information, examples, API references, and guides. Use this first for broad or conceptual questions. The result includes documentation links and paths. Use query_docs_filesystem_my_ask_ai to read a full page.';

export const FILESYSTEM_DESCRIPTION =
  'Full page, exact wording, API schema, show the file, list documentation files, or search the docs filesystem: run a read-only command against a virtual in-memory filesystem that contains only the My AskAI documentation and OpenAPI files. Use this after search_my_ask_ai identifies a useful path, or use it directly when you know the path. Use head or cat to read an .mdx page, rg for exact searches, and tree or ls for structure. The call is stateless. Supported commands include rg, grep, find, tree, ls, cat, head, tail, stat, wc, sort, uniq, cut, sed, awk, and jq. Output can be truncated, so prefer targeted commands.';

export const PRICING_DESCRIPTION =
  'Cost, price, how much, quote, per ticket, or monthly bill: estimate the expected monthly My AskAI price. Use this for pricing questions and plan-cost comparisons. Ask for monthly support tickets when they are missing. Chat percentage is optional and defaults to 100% when it is missing. The result includes a deterministic Pro and Scale quote, structured plan data, and a Markdown overview of Pro, Scale, and Enterprise.';

export const SERVER_INSTRUCTIONS =
  'Use search_my_ask_ai for broad documentation, setup, integration, API, feature, and troubleshooting questions. Use query_docs_filesystem_my_ask_ai for exact text, complete pages, known paths, and OpenAPI files. Use estimate_pricing for cost, price, quote, per-ticket, and monthly-bill questions. Ask for monthly ticket volume before calling estimate_pricing when it is missing; chat_percentage is optional and defaults to 100. All tools are public and read-only. They do not provide access to private customer data, so do not use them for account-specific questions.';

export const SEARCH_INPUT_SCHEMA = z.object({
  query: z.string().describe('Search query'),
});

export const FILESYSTEM_INPUT_SCHEMA = z.object({
  command: z.string().describe(
    'A read-only command for the virtual documentation filesystem, such as `rg -il "keyword" /` or `head -80 /index.mdx`.',
  ),
});

export const PRICING_INPUT_SCHEMA = z.object({
  monthly_tickets: z.number().int().describe(
    'Monthly support ticket or conversation count.',
  ),
  chat_percentage: z.number().optional().describe(
    `Optional percentage of tickets that are chat, from 0 to 100. Defaults to ${DEFAULT_CHAT_PERCENTAGE} when missing.`,
  ),
});

export function browserManifest(): Record<string, unknown> {
  return {
    server: {
      name: 'myaskai',
      version: '1.0.0',
      transport: 'http',
    },
    instructions: SERVER_INSTRUCTIONS,
    capabilities: {
      tools: { listChanged: true },
    },
    tools: [
      {
        name: 'search_my_ask_ai',
        title: 'Search My AskAI documentation',
        description: SEARCH_DESCRIPTION,
        inputSchema: z.toJSONSchema(SEARCH_INPUT_SCHEMA),
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: 'query_docs_filesystem_my_ask_ai',
        title: 'Query My AskAI documentation files',
        description: FILESYSTEM_DESCRIPTION,
        inputSchema: z.toJSONSchema(FILESYSTEM_INPUT_SCHEMA),
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: PRICING_TOOL_NAME,
        title: 'Estimate My AskAI pricing',
        description: PRICING_DESCRIPTION,
        inputSchema: z.toJSONSchema(PRICING_INPUT_SCHEMA),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ],
  };
}

export interface ServerDependencies {
  fetchFn?: FetchLike;
  logger?: SafeLogger;
  sourceHost?: string;
}

export function createUsageLogger(env: Env, sourceHost: string): SafeLogger {
  return (event: SafeToolEvent) => {
    const usageEvent: SafeUsageEvent = {
      ...event,
      source_host: sourceHost,
    };
    console.info(usageEvent);
    try {
      env.MCP_USAGE.writeDataPoint({
        indexes: [sourceHost],
        blobs: [event.tool, event.outcome],
        doubles: [event.duration_ms, event.upstream_status ?? 0],
      });
    } catch {
      console.warn({
        event: 'mcp_usage_write_error',
        source_host: sourceHost,
      });
    }
  };
}

export function createServer(env: Env, dependencies: ServerDependencies = {}): McpServer {
  const logger = dependencies.logger
    ?? createUsageLogger(env, dependencies.sourceHost ?? 'unknown');
  const fetchFn = dependencies.fetchFn ?? fetch;
  const upstreamUrl = env.DOCS_MCP_UPSTREAM || DEFAULT_DOCS_MCP_UPSTREAM;
  const parsedTimeout = Number.parseInt(env.UPSTREAM_TIMEOUT_MS, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const server = new McpServer(
    { name: 'myaskai', version: '1.0.0' },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    'search_my_ask_ai',
    {
      title: 'Search My AskAI documentation',
      description: SEARCH_DESCRIPTION,
      inputSchema: SEARCH_INPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query }) => callDocsTool(
      'search_my_ask_ai',
      { query },
      { upstreamUrl, timeoutMs, fetchFn, logger },
    ),
  );

  server.registerTool(
    'query_docs_filesystem_my_ask_ai',
    {
      title: 'Query My AskAI documentation files',
      description: FILESYSTEM_DESCRIPTION,
      inputSchema: FILESYSTEM_INPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ command }) => callDocsTool(
      'query_docs_filesystem_my_ask_ai',
      { command },
      { upstreamUrl, timeoutMs, fetchFn, logger },
    ),
  );

  server.registerTool(
    PRICING_TOOL_NAME,
    {
      title: 'Estimate My AskAI pricing',
      description: PRICING_DESCRIPTION,
      inputSchema: PRICING_INPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ monthly_tickets, chat_percentage }) => {
      const startedAt = Date.now();
      const result = pricingToolResult(
        monthly_tickets,
        chat_percentage ?? DEFAULT_CHAT_PERCENTAGE,
      );
      logger({
        event: 'mcp_tool',
        tool: PRICING_TOOL_NAME,
        outcome: result.isError ? 'tool_error' : 'ok',
        duration_ms: Date.now() - startedAt,
      });
      return result;
    },
  );

  return server;
}
