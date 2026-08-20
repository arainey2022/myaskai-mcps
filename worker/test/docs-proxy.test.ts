import { describe, expect, it, vi } from 'vitest';

import {
  callDocsTool,
  DOCS_TOOL_NAMES,
  MAX_UPSTREAM_RESPONSE_BYTES,
  parseMcpHttpBody,
} from '../src/tools/docs-proxy.ts';
import type { FetchLike, SafeToolEvent } from '../src/types.ts';

const toolResult = {
  content: [{ type: 'text' as const, text: 'Documentation result' }],
};

function jsonResponse(result: unknown, id = 'request-id'): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

describe('Mintlify MCP response parsing', () => {
  it('parses JSON', () => {
    expect(parseMcpHttpBody(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: toolResult }),
      'application/json',
      1,
    ).result).toEqual(toolResult);
  });

  it('parses server-sent events', () => {
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: toolResult })}\n\n`;
    expect(parseMcpHttpBody(body, 'text/event-stream', 1).result).toEqual(toolResult);
  });

  it('rejects malformed responses', () => {
    expect(() => parseMcpHttpBody('not json', 'application/json', 1)).toThrow();
    expect(() => parseMcpHttpBody('data: nope\n\n', 'text/event-stream', 1)).toThrow();
  });
});

describe('documentation proxy', () => {
  it('uses only the fixed allowlist', () => {
    expect(DOCS_TOOL_NAMES).toEqual([
      'search_my_ask_ai',
      'query_docs_filesystem_my_ask_ai',
    ]);
  });

  it.each(DOCS_TOOL_NAMES)('preserves valid upstream results for %s', async (tool) => {
    const fetchFn: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(body.params.name).toBe(tool);
      return jsonResponse(toolResult, body.id);
    };
    const args = tool === 'search_my_ask_ai'
      ? { query: 'API keys' }
      : { command: 'head -20 /quickstart.mdx' };
    await expect(callDocsTool(tool, args, { fetchFn, logger: vi.fn() }))
      .resolves.toEqual(toolResult);
  });

  it('sends only fixed headers, the selected input, and the fixed upstream URL', async () => {
    const fetchFn = vi.fn<FetchLike>(async (input, init) => {
      expect(input).toBe('https://myaskai.mintlify.app/mcp');
      expect(init?.headers).toEqual({
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      });
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { arguments: Record<string, unknown> };
      };
      expect(body.params.arguments).toEqual({ query: 'safe query' });
      return jsonResponse(toolResult, body.id);
    });
    await callDocsTool(
      'search_my_ask_ai',
      { query: 'safe query', authorization: 'must not pass' },
      { fetchFn, logger: vi.fn() },
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('does not send arbitrary tool names upstream', async () => {
    const fetchFn = vi.fn<FetchLike>();
    const result = await callDocsTool(
      'submit_feedback' as never,
      { feedback: 'no' },
      { fetchFn, logger: vi.fn() },
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('preserves valid upstream tool errors', async () => {
    const upstream = { content: [{ type: 'text' as const, text: 'No match' }], isError: true };
    const fetchFn: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return jsonResponse(upstream, body.id);
    };
    await expect(callDocsTool(
      'search_my_ask_ai',
      { query: 'x' },
      { fetchFn, logger: vi.fn() },
    )).resolves.toEqual(upstream);
  });

  it('converts HTTP errors to safe tool errors and safe logs', async () => {
    const events: SafeToolEvent[] = [];
    const result = await callDocsTool(
      'search_my_ask_ai',
      { query: 'secret query' },
      {
        fetchFn: async () => new Response('upstream details', { status: 503 }),
        logger: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'search_my_ask_ai',
      outcome: 'upstream_http',
      upstream_status: 503,
    });
    expect(JSON.stringify(events)).not.toContain('secret query');
    expect(JSON.stringify(result)).not.toContain('upstream details');
  });

  it('converts malformed successful responses to safe tool errors', async () => {
    const result = await callDocsTool(
      'query_docs_filesystem_my_ask_ai',
      { command: 'cat /quickstart.mdx' },
      {
        fetchFn: async () => new Response('{"wrong":true}', {
          headers: { 'content-type': 'application/json' },
        }),
        logger: vi.fn(),
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('invalid response');
  });

  it('rejects a declared upstream response over 2 MiB', async () => {
    const result = await callDocsTool(
      'search_my_ask_ai',
      { query: 'bounded response' },
      {
        fetchFn: async () => new Response('{}', {
          headers: {
            'content-length': String(MAX_UPSTREAM_RESPONSE_BYTES + 1),
            'content-type': 'application/json',
          },
        }),
        logger: vi.fn(),
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('invalid response');
  });

  it('stops reading a streamed upstream response over 2 MiB', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_UPSTREAM_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const result = await callDocsTool(
      'search_my_ask_ai',
      { query: 'bounded stream' },
      {
        fetchFn: async () => new Response(body, {
          headers: { 'content-type': 'application/json' },
        }),
        logger: vi.fn(),
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('invalid response');
  });

  it('times out once without a retry', async () => {
    const fetchFn = vi.fn<FetchLike>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    const result = await callDocsTool(
      'search_my_ask_ai',
      { query: 'slow' },
      { fetchFn, timeoutMs: 5, logger: vi.fn() },
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('timed out');
  });
});
