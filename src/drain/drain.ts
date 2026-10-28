import type { ClickHouse } from "../lib/clickhouse";
import { redactDeep, redactText } from "../lib/redact";
import { mapUsageRecord } from "./record";
import type { Spool } from "./spool";

/** Verified in CLIProxyAPI internal/api/server_management_v8.go:43 (GET, `count` query param, default 1). */
export const USAGE_QUEUE_PATH = "/v8/management/observability/usage/queue";

export type DrainOptions = {
  hubUrl: string;
  mgmtKey: string;
  hub: string;
  clickhouse: ClickHouse;
  spool: Spool;
  pageSize?: number;
  maxPages?: number;
  onInsertError?: (err: unknown) => void;
};

export type DrainResult = { drained: number; inserted: number; spooled: number; rejected: number };

// Identity fields never reach disk, even in the rejects file; everything else goes through the deep redactor.
const SECRET_FIELDS = ["source", "api_key", "access_token_sha256", "response_headers", "client_ip", "resolved_client_ip", "x_forwarded_for"];

async function fetchPage(opts: DrainOptions, count: number): Promise<unknown[]> {
  const url = `${opts.hubUrl.replace(/\/$/, "")}${USAGE_QUEUE_PATH}?count=${count}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.mgmtKey}` } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`usage queue GET failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
    if (!Array.isArray(body)) throw new Error("non-array");
  } catch {
    // Retain malformed pages with known identity fields scrubbed before the shared text redactor.
    opts.spool.reject({ reason: "malformed hub page", bytes: Buffer.byteLength(text), body: redactText(text.replace(/("(?:access_token|refresh_token|api_key|source)"\s*:\s*")[^"]*/g, "$1[redacted]")) });
    throw new Error("usage queue returned malformed page; durable reject receipt saved");
  }
  return body;
}

/** Flush the spool, pop the usage queue until it is empty, spool what was popped, flush again. */
export async function drainOnce(opts: DrainOptions): Promise<DrainResult> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 100;
  const result: DrainResult = { drained: 0, inserted: 0, spooled: 0, rejected: 0 };

  const flush = async () => {
    try {
      await opts.spool.flush(async (rows, token) => {
        await opts.clickhouse.insert("proxy_usage", rows, token);
        result.inserted += rows.length;
      });
    } catch (err) {
      opts.onInsertError?.(err);
    }
  };

  await flush();

  for (let page = 0; page < maxPages; page++) {
    const items = await fetchPage(opts, pageSize);
    result.drained += items.length;
    const rows = [];
    for (const item of items) {
      try {
        rows.push(mapUsageRecord(item, { hub: opts.hub }));
      } catch (err) {
        result.rejected++;
        opts.spool.reject({ reason: redactText((err as Error).message), item: redactDeep(item, { extraKeys: SECRET_FIELDS }) });
      }
    }
    if (rows.length) opts.spool.append(rows);
    if (items.length < pageSize) break;
  }

  await flush();
  result.spooled = opts.spool.batches().reduce((n, b) => n + b.rows.length, 0);
  return result;
}
