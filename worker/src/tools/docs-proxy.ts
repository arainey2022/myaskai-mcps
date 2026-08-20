import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { FetchLike, SafeLogger, SafeToolEvent } from '../types.ts';

export const DOCS_TOOL_NAMES = [
  'search_my_ask_ai',
  'query_docs_filesystem_my_ask_ai',
] as const;

export type DocsToolName = (typeof DOCS_TOOL_NAMES)[number];

export const DEFAULT_DOCS_MCP_UPSTREAM = 'https://myaskai.mintlify.app/mcp';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;

type JsonRpcId = string | number | null;

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ParsedUpstreamResponse {
  result: CallToolResult;
}

class UpstreamFailure extends Error {
  constructor(
    readonly category: SafeToolEvent['outcome'],
    readonly status?: number,
  ) {
    super(category);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonMessagesFromSse(body: string): unknown[] {
  const messages: unknown[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    try {
      messages.push(JSON.parse(data));
    } catch {
      throw new UpstreamFailure('invalid_response');
    }
  };

  for (const line of body.replaceAll('\r\n', '\n').split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  return messages;
}

export function parseMcpHttpBody(
  body: string,
  contentType = '',
  expectedId?: JsonRpcId,
): JsonRpcEnvelope {
  let messages: unknown[];
  const trimmed = body.trim();

  if (contentType.toLowerCase().includes('text/event-stream') || /^event:|^data:/m.test(trimmed)) {
    messages = jsonMessagesFromSse(body);
  } else {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new UpstreamFailure('invalid_response');
    }
  }

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const envelope = message as JsonRpcEnvelope;
    if (expectedId !== undefined && envelope.id !== expectedId) continue;
    if ('result' in envelope || 'error' in envelope) return envelope;
  }

  throw new UpstreamFailure('invalid_response');
}

function validateToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new UpstreamFailure('invalid_response');
  }

  for (const item of value.content) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      throw new UpstreamFailure('invalid_response');
    }
  }

  return value as CallToolResult;
}

async function readUpstreamToolResult(
  response: Response,
  expectedId: JsonRpcId,
): Promise<ParsedUpstreamResponse> {
  if (!response.ok) {
    throw new UpstreamFailure('upstream_http', response.status);
  }

  const body = await response.text();
  const envelope = parseMcpHttpBody(
    body,
    response.headers.get('content-type') ?? '',
    expectedId,
  );
  if ('error' in envelope) {
    throw new UpstreamFailure('tool_error', response.status);
  }

  return { result: validateToolResult(envelope.result) };
}

function errorResult(category: SafeToolEvent['outcome']): CallToolResult {
  const text = category === 'timeout'
    ? 'The My AskAI documentation service timed out. Try again.'
    : category === 'invalid_response'
      ? 'The My AskAI documentation service returned an invalid response. Try again.'
      : 'The My AskAI documentation service is temporarily unavailable. Try again.';
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

export const consoleSafeLogger: SafeLogger = (event) => {
  console.info(JSON.stringify(event));
};

export interface CallDocsToolOptions {
  upstreamUrl?: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  logger?: SafeLogger;
}

export async function callDocsTool(
  tool: DocsToolName,
  args: Record<string, unknown>,
  options: CallDocsToolOptions = {},
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const fetchFn = options.fetchFn ?? fetch;
  const logger = options.logger ?? consoleSafeLogger;
  const upstreamUrl = options.upstreamUrl ?? DEFAULT_DOCS_MCP_UPSTREAM;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (!DOCS_TOOL_NAMES.includes(tool)) {
    clearTimeout(timer);
    logger({
      event: 'mcp_tool',
      tool: String(tool),
      outcome: 'tool_error',
      duration_ms: Date.now() - startedAt,
    });
    return errorResult('tool_error');
  }

  const safeArgs = tool === 'search_my_ask_ai'
    ? { query: args.query }
    : { command: args.command };

  try {
    const response = await fetchFn(upstreamUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: safeArgs },
      }),
      signal: controller.signal,
    });
    const { result } = await readUpstreamToolResult(response, id);
    logger({
      event: 'mcp_tool',
      tool,
      outcome: result.isError ? 'tool_error' : 'ok',
      duration_ms: Date.now() - startedAt,
      upstream_status: response.status,
    });
    return result;
  } catch (error) {
    const failure = error instanceof UpstreamFailure
      ? error
      : error instanceof DOMException && error.name === 'AbortError'
        ? new UpstreamFailure('timeout')
        : controller.signal.aborted
          ? new UpstreamFailure('timeout')
          : new UpstreamFailure('upstream_http');
    const event: SafeToolEvent = {
      event: 'mcp_tool',
      tool,
      outcome: failure.category,
      duration_ms: Date.now() - startedAt,
    };
    if (failure.status !== undefined) event.upstream_status = failure.status;
    logger(event);
    return errorResult(failure.category);
  } finally {
    clearTimeout(timer);
  }
}
