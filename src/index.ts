import { createMcpHandler } from 'agents/mcp/server';

import { createServer, type ServerDependencies } from './server.ts';
import type { Env, ExecutionContextLike } from './types.ts';

const MCP_PATHS = new Set(['/mcp', '/mcp/']);

function textResponse(text: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(text, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      ...headers,
    },
  });
}

function normalizeMcpPath(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === '/mcp/') url.pathname = '/mcp';
  return new Request(url, request);
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  dependencies: ServerDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (!MCP_PATHS.has(url.pathname)) {
    return textResponse('Not found', 404);
  }

  if (request.method === 'POST') {
    const clientKey = request.headers.get('cf-connecting-ip') || 'unknown';
    const limit = await env.MCP_RATE_LIMIT.limit({ key: clientKey });
    if (!limit.success) {
      return textResponse('Too many requests', 429, { 'retry-after': '60' });
    }
  }

  const handler = createMcpHandler(
    () => createServer(env, dependencies),
    {
      route: '/mcp',
      corsOptions: { origin: 'https://myaskai.com' },
    },
  );
  const response = await handler(
    normalizeMcpPath(request),
    env,
    ctx as ExecutionContext,
  );
  return noStore(response);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
