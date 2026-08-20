export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(event: {
    indexes: string[];
    blobs: string[];
    doubles: number[];
  }): void;
}

export interface Env {
  DOCS_MCP_UPSTREAM: string;
  UPSTREAM_TIMEOUT_MS: string;
  MCP_RATE_LIMIT: RateLimitBinding;
  MCP_USAGE: AnalyticsEngineDatasetLike;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SafeToolEvent {
  event: 'mcp_tool';
  tool: string;
  outcome: 'ok' | 'tool_error' | 'timeout' | 'upstream_http' | 'invalid_response';
  duration_ms: number;
  upstream_status?: number;
}

export interface SafeUsageEvent extends SafeToolEvent {
  source_host: string;
}

export type SafeLogger = (event: SafeToolEvent) => void;
