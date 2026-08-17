import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Env, FetchLike, SafeLogger } from './types.ts';
import {
  callDocsTool,
  consoleSafeLogger,
  DEFAULT_DOCS_MCP_UPSTREAM,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from './tools/docs-proxy.ts';
import {
  DEFAULT_CHAT_PERCENTAGE,
  pricingToolResult,
  PRICING_TOOL_NAME,
} from './tools/pricing.ts';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SEARCH_DESCRIPTION =
  'Search the My AskAI knowledge base for relevant information, examples, API references, and guides. Use this for broad or conceptual questions. The result includes documentation links and paths. Use query_docs_filesystem_my_ask_ai to read a full page.';

const FILESYSTEM_DESCRIPTION =
  'Run a read-only command against a virtual in-memory filesystem that contains only the My AskAI documentation and OpenAPI files. Use head or cat to read an .mdx page, rg for exact searches, and tree or ls for structure. The call is stateless. Supported commands include rg, grep, find, tree, ls, cat, head, tail, stat, wc, sort, uniq, cut, sed, awk, and jq. Output can be truncated, so prefer targeted commands.';

const PRICING_DESCRIPTION =
  'Estimate the expected monthly My AskAI price. Ask for monthly support tickets. Chat percentage is optional and defaults to 100% when it is missing. The result includes a deterministic Pro and Scale quote, structured plan data, and a Markdown overview of Pro, Scale, and Enterprise.';

export interface ServerDependencies {
  fetchFn?: FetchLike;
  logger?: SafeLogger;
}

export function createServer(env: Env, dependencies: ServerDependencies = {}): McpServer {
  const logger = dependencies.logger ?? consoleSafeLogger;
  const fetchFn = dependencies.fetchFn ?? fetch;
  const upstreamUrl = env.DOCS_MCP_UPSTREAM || DEFAULT_DOCS_MCP_UPSTREAM;
  const parsedTimeout = Number.parseInt(env.UPSTREAM_TIMEOUT_MS, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const server = new McpServer(
    { name: 'myaskai-mcps', version: '1.0.0' },
    {
      instructions:
        'Use these public, read-only tools for My AskAI documentation and pricing. They do not provide access to private customer data.',
    },
  );

  server.registerTool(
    'search_my_ask_ai',
    {
      title: 'Search My AskAI documentation',
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
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
      inputSchema: z.object({
        command: z.string().describe(
          'A read-only command for the virtual documentation filesystem, such as `rg -il "keyword" /` or `head -80 /quickstart.mdx`.',
        ),
      }),
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
      inputSchema: z.object({
        monthly_tickets: z.number().int().describe(
          'Monthly support ticket or conversation count.',
        ),
        chat_percentage: z.number().optional().describe(
          `Optional percentage of tickets that are chat, from 0 to 100. Defaults to ${DEFAULT_CHAT_PERCENTAGE} when missing.`,
        ),
      }),
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
