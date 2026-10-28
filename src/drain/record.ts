import { labelHash } from "../lib/hash";
import { redactDeep, redactText } from "../lib/redact";
import { parseTimestampMs, toClickHouseTime } from "../lib/time";

/**
 * Shape of one item from GET /v8/management/observability/usage/queue.
 * Source: CLIProxyAPI internal/redisqueue/plugin.go (queuedUsageDetail, requestDetail, tokenStats, failDetail)
 * and sdk/cliproxy/usage/accounting.go (TokenBreakdown).
 */
export type UsageQueueRecord = {
  timestamp?: string;
  latency_ms?: number;
  ttft_ms?: number;
  /** Account identity: email, project id, or the raw upstream API key. Hash only. */
  source?: string;
  auth_index?: string;
  access_token_sha256?: string;
  client_ip?: string;
  resolved_client_ip?: string;
  user_agent?: string;
  tokens?: Partial<{
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
  }>;
  failed?: boolean;
  stream?: boolean;
  fail?: { status_code?: number; body?: string; code?: string };
  response_headers?: Record<string, string[] | string>;
  accounting_version?: number;
  token_breakdown?: {
    quality?: string;
    input?: { uncached_tokens?: number };
  };
  provider?: string;
  executor_type?: string;
  model?: string;
  alias?: string;
  endpoint?: string;
  auth_type?: string;
  /** The client's access key to the hub. Hash only. */
  api_key?: string;
  request_id?: string;
  execution_id?: string;
  trace_id?: string;
  session_id?: string;
  parent_session_id?: string;
  node_kind?: string;
  is_fork?: boolean;
  is_compaction?: boolean;
  reasoning_effort?: string;
  service_tier?: string;
  effective_service_tier?: string;
  response_model?: string;
};

export type ProxyUsageRow = {
  ts: string;
  execution_id: string;
  request_id: string;
  trace_id: string;
  hub: string;
  credential: string;
  account_hash: string;
  client_key_hash: string;
  provider: string;
  executor_type: string;
  auth_type: string;
  model: string;
  alias: string;
  response_model: string;
  endpoint: string;
  session_id: string;
  parent_session_id: string;
  node_kind: string;
  is_fork: boolean;
  is_compaction: boolean;
  input_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  accounting_version: number;
  accounting_quality: string;
  latency_ms: number;
  ttft_ms: number;
  status_code: number;
  failed: boolean;
  fail_code: string;
  fail_body: string;
  stream: boolean;
  reasoning_effort: string;
  service_tier: string;
  effective_service_tier: string;
  client_ip: string;
  user_agent: string;
  ratelimit: Record<string, string>;
};

const FAIL_BODY_MAX = 2048;
const RATELIMIT_HEADER = /^(anthropic-ratelimit-|x-ratelimit-|x-codex-|retry-after$)/;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : fallback) || fallback;
const uint = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

function ratelimitHeaders(headers: UsageQueueRecord["response_headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!RATELIMIT_HEADER.test(key)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/**
 * Map one queue item to a proxy_usage row. Throws on items that cannot be stored faithfully.
 * Free text (failure body/code, user agent, …) passes the shared redactor: upstream auth errors echo keys and emails.
 */
export function mapUsageRecord(input: unknown, opts: { hub: string }): ProxyUsageRow {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("usage record is not a JSON object");
  }
  const r = input as UsageQueueRecord;
  const ms = parseTimestampMs(r.timestamp);
  if (ms === null) throw new Error("usage record has no parseable timestamp");
  const t = r.tokens ?? {};
  const failed = r.failed === true;

  const row: ProxyUsageRow = {
    ts: toClickHouseTime(ms),
    execution_id: str(r.execution_id),
    request_id: str(r.request_id),
    trace_id: str(r.trace_id),
    hub: opts.hub,
    credential: labelHash(r.auth_index),
    account_hash: labelHash(r.source),
    client_key_hash: labelHash(r.api_key),
    provider: str(r.provider, "unknown"),
    executor_type: str(r.executor_type, "unknown"),
    auth_type: str(r.auth_type, "unknown"),
    model: str(r.model, "unknown"),
    alias: str(r.alias),
    response_model: str(r.response_model),
    endpoint: str(r.endpoint),
    session_id: str(r.session_id),
    parent_session_id: str(r.parent_session_id),
    node_kind: str(r.node_kind),
    is_fork: r.is_fork === true,
    is_compaction: r.is_compaction === true,
    input_tokens: uint(t.input_tokens),
    uncached_input_tokens: uint(r.token_breakdown?.input?.uncached_tokens),
    cache_read_tokens: uint(t.cache_read_tokens),
    cache_creation_tokens: uint(t.cache_creation_tokens),
    cached_tokens: uint(t.cached_tokens),
    output_tokens: uint(t.output_tokens),
    reasoning_tokens: uint(t.reasoning_tokens),
    total_tokens: uint(t.total_tokens),
    accounting_version: uint(r.accounting_version),
    accounting_quality: str(r.token_breakdown?.quality),
    latency_ms: uint(r.latency_ms),
    ttft_ms: uint(r.ttft_ms),
    status_code: uint(r.fail?.status_code),
    failed,
    fail_code: str(r.fail?.code),
    fail_body: failed ? redactText(str(r.fail?.body)).slice(0, FAIL_BODY_MAX) : "",
    stream: r.stream === true,
    reasoning_effort: str(r.reasoning_effort),
    service_tier: str(r.service_tier),
    effective_service_tier: str(r.effective_service_tier),
    client_ip: str(r.resolved_client_ip) || str(r.client_ip),
    user_agent: str(r.user_agent),
    ratelimit: ratelimitHeaders(r.response_headers),
  };
  return redactDeep(row) as ProxyUsageRow;
}
