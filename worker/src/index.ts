import { createMcpHandler } from 'agents/mcp/server';

import {
  browserManifest,
  createServer,
  type ServerDependencies,
} from './server.ts';
import type { Env, ExecutionContextLike } from './types.ts';

const MCP_PATHS = new Set(['/mcp', '/mcp/']);
const CANONICAL_MCP_HOST = 'mcp.myaskai.com';
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

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

function browserManifestResponse(headOnly = false): Response {
  return new Response(
    headOnly ? null : `${JSON.stringify(browserManifest(), null, 2)}\n`,
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}

function canonicalMcpRedirect(url: URL): Response {
  const location = new URL('/mcp', url.origin);
  return new Response(null, {
    status: 308,
    headers: {
      'cache-control': 'no-store',
      location: location.toString(),
    },
  });
}

function isBrowserNavigation(request: Request): boolean {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  return !accept.includes('text/event-stream');
}

function wantsBrowserManifest(request: Request): boolean {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  return accept.includes('text/html') && !accept.includes('text/event-stream');
}

function hasOversizedDeclaredBody(request: Request): boolean {
  const declaredLength = Number.parseInt(
    request.headers.get('content-length') ?? '',
    10,
  );
  return Number.isFinite(declaredLength)
    && declaredLength > MAX_REQUEST_BODY_BYTES;
}

async function readBoundedPostRequest(request: Request): Promise<Request | Response> {
  if (request.body === null) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return textResponse('Request body too large', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
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
  let requestForHandler = request;
  if (!MCP_PATHS.has(url.pathname)) {
    if (
      url.hostname.toLowerCase() === CANONICAL_MCP_HOST
      && isBrowserNavigation(request)
    ) {
      return canonicalMcpRedirect(url);
    }
    return textResponse('Not found', 404);
  }

  if (wantsBrowserManifest(request)) {
    return browserManifestResponse(request.method === 'HEAD');
  }

  if (request.method === 'POST') {
    const clientKey = request.headers.get('cf-connecting-ip') || 'unknown';
    const limit = await env.MCP_RATE_LIMIT.limit({ key: clientKey });
    if (!limit.success) {
      return textResponse('Too many requests', 429, { 'retry-after': '60' });
    }
    if (hasOversizedDeclaredBody(request)) {
      return textResponse('Request body too large', 413);
    }
    const boundedRequest = await readBoundedPostRequest(request);
    if (boundedRequest instanceof Response) return boundedRequest;
    requestForHandler = boundedRequest;
  }

  const handler = createMcpHandler(
    () => createServer(env, {
      ...dependencies,
      sourceHost: dependencies.sourceHost ?? url.hostname.toLowerCase(),
    }),
    {
      route: '/mcp',
      corsOptions: { origin: 'https://myaskai.com' },
    },
  );
  const response = await handler(
    normalizeMcpPath(requestForHandler),
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
