# My AskAI MCP

Public, read-only Model Context Protocol tools for My AskAI.

Canonical endpoint: `https://mcp.myaskai.com/mcp`

The previous `https://myaskai.com/mcp` endpoint remains a temporary protocol
alias until 17 September 2026. Browser requests to that URL pass to the My
AskAI website origin. They return the website's branded 404 until the separate
landing page is published.

Open the endpoint in a browser to view the public tool manifest.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `search_my_ask_ai` | Required `query: string` | My AskAI documentation search results. |
| `query_docs_filesystem_my_ask_ai` | Required `command: string` | Results from the read-only documentation filesystem. |
| `estimate_pricing` | Required `monthly_tickets: integer`; optional `chat_percentage: number` | Pro and Scale quotes, plus a plan overview. |

If `chat_percentage` is missing, `estimate_pricing` uses `100`.

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

Run the production smoke test with the canonical endpoint:

```sh
npm run smoke -- https://mcp.myaskai.com/mcp --live-docs
```

## Usage analytics

The Worker records one privacy-safe Analytics Engine data point for each tool
execution. Production uses `myaskai_mcp_usage`; development uses
`myaskai_mcp_usage_dev`.

| Field | Value |
| --- | --- |
| `index1` | Source host |
| `blob1` | Tool name |
| `blob2` | Outcome |
| `double1` | Duration in milliseconds |
| `double2` | Upstream HTTP status, or `0` when not applicable |

No tool arguments, search text, filesystem commands, response content, IP
addresses, user agents, or client names are recorded.

Cloudflare invocation logs are disabled. The Worker keeps only the structured
tool log and Analytics Engine event described above.

Analytics Engine retains these aggregate events for three months.

Calls by tool for the last 30 days:

```sql
SELECT
  blob1 AS tool,
  SUM(_sample_interval) AS calls
FROM myaskai_mcp_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY tool
ORDER BY calls DESC
```

Canonical versus legacy host usage for the last 30 days:

```sql
SELECT
  index1 AS source_host,
  SUM(_sample_interval) AS calls
FROM myaskai_mcp_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source_host
ORDER BY calls DESC
```

Error rate for the last 30 days:

```sql
SELECT
  blob1 AS tool,
  100.0 * sumIf(_sample_interval, blob2 != 'ok')
    / SUM(_sample_interval) AS error_percent
FROM myaskai_mcp_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY tool
ORDER BY tool
```

Average and percentile latency for the last 30 days:

```sql
SELECT
  blob1 AS tool,
  SUM(_sample_interval) AS calls,
  SUM(double1 * _sample_interval) / SUM(_sample_interval) AS average_duration_ms,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_duration_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_duration_ms
FROM myaskai_mcp_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY tool
ORDER BY tool
```

Development and production deploy workflows are manual.

## License

MIT
