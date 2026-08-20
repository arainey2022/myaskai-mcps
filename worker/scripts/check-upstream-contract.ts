import {
  DEFAULT_DOCS_MCP_UPSTREAM,
  DOCS_TOOL_NAMES,
  parseMcpHttpBody,
} from '../src/tools/docs-proxy.ts';

const requestId = crypto.randomUUID();
const upstream = process.env.DOCS_MCP_UPSTREAM ?? DEFAULT_DOCS_MCP_UPSTREAM;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);

try {
  const response = await fetch(upstream, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/list',
      params: {},
    }),
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}`);
  }

  const envelope = parseMcpHttpBody(
    await response.text(),
    response.headers.get('content-type') ?? '',
    requestId,
  );
  const result = envelope.result as { tools?: Array<Record<string, unknown>> };
  const tools = result?.tools;
  if (!Array.isArray(tools)) throw new Error('Upstream did not return tools');

  for (const requiredName of DOCS_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === requiredName);
    if (!tool) throw new Error(`Upstream is missing ${requiredName}`);
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const requiredInput = requiredName === 'search_my_ask_ai' ? 'query' : 'command';
    if (!schema?.properties?.[requiredInput] || !schema.required?.includes(requiredInput)) {
      throw new Error(`${requiredName} no longer requires ${requiredInput}`);
    }
  }

  console.log(JSON.stringify({
    check: 'upstream_contract',
    outcome: 'ok',
    upstream,
    required_tools: DOCS_TOOL_NAMES,
  }));
} finally {
  clearTimeout(timer);
}
