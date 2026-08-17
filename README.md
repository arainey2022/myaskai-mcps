# My AskAI MCPs

Public, read-only Model Context Protocol tools for My AskAI.

Endpoint: `https://myaskai.com/mcp`

Open the endpoint in a browser to view the public tool manifest.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `search_my_ask_ai` | Required `query: string` | My AskAI documentation search results. |
| `query_docs_filesystem_my_ask_ai` | Required `command: string` | Results from the read-only documentation filesystem. |
| `estimate-pricing` | Required `monthly_tickets: integer`; optional `chat_percentage: number` | Pro and Scale quotes, plus a plan overview. |

If `chat_percentage` is missing, `estimate-pricing` uses `100`.

The server does not require login. It exposes no resources or prompts.

## Development

Requires Node.js 22.

```sh
npm ci
npm run dev
```

The local endpoint is `http://localhost:8787/mcp`.

Run all checks:

```sh
npm run check
npm run check:production
npm run check:upstream
```

Run a local smoke test while the Worker is running:

```sh
npm run smoke -- --live-docs
```

Development and production deploy workflows are manual.

## License

MIT
