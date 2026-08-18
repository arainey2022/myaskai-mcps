import { describe, expect, it, vi } from 'vitest';

import { handleRequest } from '../src/index.ts';
import { parseMcpHttpBody } from '../src/tools/docs-proxy.ts';
import type {
  Env,
  ExecutionContextLike,
  FetchLike,
  RateLimitBinding,
  SafeToolEvent,
} from '../src/types.ts';

interface RpcResponse {
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

function testEnv(limit: RateLimitBinding = { limit: async () => ({ success: true }) }): Env {
  return {
    DOCS_MCP_UPSTREAM: 'https://myaskai.mintlify.app/mcp',
    UPSTREAM_TIMEOUT_MS: '15000',
    MCP_RATE_LIMIT: limit,
  };
}

const ctx: ExecutionContextLike = { waitUntil: () => undefined };

async function postRpc(
  body: Record<string, unknown>,
  options: {
    path?: string;
    env?: Env;
    fetchFn?: FetchLike;
    logger?: (event: SafeToolEvent) => void;
    protocolVersion?: string;
  } = {},
): Promise<{ response: Response; rpc: RpcResponse }> {
  const response = await handleRequest(
    new Request(`https://myaskai.com${options.path ?? '/mcp'}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': options.protocolVersion ?? '2025-06-18',
        ...((options.protocolVersion ?? '').startsWith('2026')
          ? { 'mcp-method': String(body.method) }
          : {}),
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify(body),
    }),
    options.env ?? testEnv(),
    ctx,
    {
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    },
  );
  const text = await response.text();
  const rpc = parseMcpHttpBody(
    text,
    response.headers.get('content-type') ?? '',
    body.id as string | number | null,
  ) as RpcResponse;
  return { response, rpc };
}

function upstreamFetch(resultText = 'Upstream documentation'): FetchLike {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string };
    return new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: resultText }] },
      })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

describe('MCP protocol surface', () => {
  it('initializes for a 2025 Streamable HTTP client', async () => {
    const { response, rpc } = await postRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    expect(response.status, JSON.stringify(rpc)).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'myaskai-mcps', version: '1.0.0' },
    });
    const capabilities = rpc.result?.capabilities as Record<string, unknown>;
    expect(capabilities).toHaveProperty('tools');
    expect(capabilities).not.toHaveProperty('resources');
    expect(capabilities).not.toHaveProperty('prompts');
  });

  it('answers discovery for the current protocol client', async () => {
    const { response, rpc } = await postRpc(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'current-test-client',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { protocolVersion: '2026-07-28' },
    );
    expect(response.status, JSON.stringify(rpc)).toBe(200);
    expect(rpc.result?.supportedVersions).toContain('2026-07-28');
  });

  it('returns exactly three read-only tools', async () => {
    const { rpc } = await postRpc({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const tools = (rpc.result?.tools ?? []) as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_my_ask_ai',
      'query_docs_filesystem_my_ask_ai',
      'estimate-pricing',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    const pricingTool = tools.find((tool) => tool.name === 'estimate-pricing');
    const pricingSchema = pricingTool?.inputSchema as { required?: string[] };
    expect(pricingSchema.required).toEqual(['monthly_tickets']);
  });

  it.each([
    ['search_my_ask_ai', { query: 'API keys' }],
    ['query_docs_filesystem_my_ask_ai', { command: 'head -20 /quickstart.mdx' }],
  ])('calls the %s proxy tool', async (name, args) => {
    const { rpc } = await postRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { fetchFn: upstreamFetch(), logger: vi.fn() },
    );
    expect(rpc.result).toEqual({
      content: [{ type: 'text', text: 'Upstream documentation' }],
    });
  });

  it('calls pricing and returns the quote, structured overview, and Markdown', async () => {
    const { rpc } = await postRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'estimate-pricing',
        arguments: { monthly_tickets: 2000, chat_percentage: 80 },
      },
    }, { logger: vi.fn() });
    expect(rpc.result?.structuredContent).toMatchObject({
      ok: true,
      assumed_plan: 'Pro',
      pricing_overview: {
        headline: '60% AI resolution. Or your money back.',
      },
    });
    const content = rpc.result?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]?.text).toContain('"estimated_monthly_total_usd"');
    expect(content[1]?.text).toContain('## My AskAI pricing overview');
  });

  it('defaults a missing chat percentage to 100', async () => {
    const { rpc } = await postRpc({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'estimate-pricing',
        arguments: { monthly_tickets: 2000 },
      },
    }, { logger: vi.fn() });
    expect(rpc.result?.structuredContent).toMatchObject({
      ok: true,
      inputs: { chat_percentage: 100, email_percentage: 0 },
    });
  });

  it('rejects submit_feedback and does not call upstream', async () => {
    const fetchFn = vi.fn<FetchLike>();
    const { rpc } = await postRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'submit_feedback',
        arguments: { path: '/quickstart', feedback: 'No' },
      },
    }, { fetchFn });
    expect(rpc.error).toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(['resources/list', 'prompts/list'])('does not expose %s', async (method) => {
    const { rpc } = await postRpc({
      jsonrpc: '2.0', id: 6, method, params: {},
    });
    expect(rpc.error).toBeDefined();
  });
});

describe('HTTP routing and abuse protection', () => {
  it.each(['/mcp', '/mcp/', '/mcp/?client=browser'])(
    'returns the public tool manifest to a browser at %s',
    async (path) => {
      const response = await handleRequest(
        new Request(`https://myaskai.com${path}`, {
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        }),
        testEnv(),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');

      const manifest = await response.json() as {
        capabilities: Record<string, unknown>;
        tools: Array<Record<string, unknown>>;
      };
      expect(manifest.capabilities).toEqual({ tools: { listChanged: true } });
      expect(manifest).not.toHaveProperty('resources');
      expect(manifest).not.toHaveProperty('prompts');
      expect(manifest.tools.map((tool) => tool.name)).toEqual([
        'search_my_ask_ai',
        'query_docs_filesystem_my_ask_ai',
        'estimate-pricing',
      ]);
      expect(
        manifest.tools.some((tool) => tool.name === 'submit_feedback'),
      ).toBe(false);
      for (const tool of manifest.tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      const pricingTool = manifest.tools.find(
        (tool) => tool.name === 'estimate-pricing',
      );
      const pricingSchema = pricingTool?.inputSchema as { required?: string[] };
      expect(pricingSchema.required).toEqual(['monthly_tickets']);
    },
  );

  it('keeps MCP event-stream GET requests on the protocol handler', async () => {
    const response = await handleRequest(
      new Request('https://myaskai.com/mcp', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
      testEnv(),
      ctx,
    );
    expect(response.status).toBe(405);
  });

  it.each(['/mcp/', '/mcp?client=test', '/mcp/?client=test'])(
    'accepts %s',
    async (path) => {
      const { response, rpc } = await postRpc(
        { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
        { path },
      );
      expect(response.status).toBe(200);
      expect(rpc.result?.tools).toBeDefined();
    },
  );

  it.each(['/mcp-docs', '/mcp/other', '/MCP', '/mcps', '/', '/pricing'])(
    'returns 404 for %s',
    async (path) => {
      const response = await handleRequest(
        new Request(`https://myaskai.com${path}`, { method: 'POST' }),
        testEnv(),
        ctx,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it.each([
    ['GET', 405],
    ['PUT', 405],
    ['DELETE', 405],
  ])('handles %s with status %i', async (method, expectedStatus) => {
    const response = await handleRequest(
      new Request('https://myaskai.com/mcp', { method }),
      testEnv(),
      ctx,
    );
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('handles OPTIONS as a CORS preflight', async () => {
    const response = await handleRequest(
      new Request('https://myaskai.com/mcp', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://myaskai.com',
          'access-control-request-method': 'POST',
        },
      }),
      testEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://myaskai.com',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 429 when the per-IP request limit rejects a POST', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleRequest(
      new Request('https://myaskai.com/mcp', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.8' },
        body: '{}',
      }),
      testEnv({ limit }),
      ctx,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.8' });
  });
});
