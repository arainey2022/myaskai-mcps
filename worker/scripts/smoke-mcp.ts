import { parseMcpHttpBody } from '../src/tools/docs-proxy.ts';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'))
  ?? process.env.MCP_URL
  ?? 'http://localhost:8787/mcp';
const liveDocs = args.includes('--live-docs');

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const envelope = parseMcpHttpBody(
    await response.text(),
    response.headers.get('content-type') ?? '',
    id,
  );
  if (!response.ok || envelope.error) {
    throw new Error(`${method} failed with HTTP ${response.status}`);
  }
  return envelope.result as Record<string, unknown>;
}

const initialized = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'myaskai-mcps-smoke', version: '1.0.0' },
});
if (initialized.protocolVersion !== '2025-06-18') {
  throw new Error('Initialization returned an unexpected protocol version');
}

const listed = await rpc('tools/list', {});
const toolNames = (listed.tools as Array<{ name: string }>).map((tool) => tool.name);
const expected = [
  'search_my_ask_ai',
  'query_docs_filesystem_my_ask_ai',
  'estimate-pricing',
];
if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected tools: ${toolNames.join(', ')}`);
}

const pricing = await rpc('tools/call', {
  name: 'estimate-pricing',
  arguments: { monthly_tickets: 2_000 },
});
const pricingData = pricing.structuredContent as Record<string, unknown>;
if (pricingData.ok !== true || !pricingData.pricing_overview) {
  throw new Error('Pricing did not return the quote and overview');
}
const pricingInputs = pricingData.inputs as Record<string, unknown>;
if (pricingInputs.chat_percentage !== 100) {
  throw new Error('Pricing did not default a missing chat percentage to 100');
}

if (liveDocs) {
  for (const [name, toolArgs] of [
    ['search_my_ask_ai', { query: 'How do I create an API key?' }],
    ['query_docs_filesystem_my_ask_ai', { command: 'tree / -L 1' }],
  ] as const) {
    const result = await rpc('tools/call', { name, arguments: toolArgs });
    if (result.isError === true) throw new Error(`${name} returned a tool error`);
  }
}

console.log(JSON.stringify({
  check: 'mcp_smoke',
  outcome: 'ok',
  target,
  tools: toolNames,
  live_docs_checked: liveDocs,
}));
