import { redactText } from "./redact";

export type ClickHouseConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
};

/** Admit fixed-schema work and return the same client; explicit generic tables bypass this guard. */
export function fixed<T extends { config: Pick<ClickHouseConfig, "database"> }>(ch: T, table = "proxy_usage"): T {
  if (["session_events", "proxy_usage", "archaeology_sample", "ship_heartbeat"].includes(table) && ch.config.database !== "tokenlayer") throw new Error("CLICKHOUSE_DATABASE_UNSUPPORTED");
  return ch;
}

// JSONEachRow accepts String bytes without requiring UTF-8. Keep source bytes out of JS decoding.
export const RAW_BYTES = Symbol("source line bytes");
const shortEscapes: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
export function encodeRow(row: unknown): Buffer {
  const bytes = (row as { [RAW_BYTES]?: Buffer })[RAW_BYTES];
  if (!bytes) return Buffer.from(JSON.stringify(row));
  const fields = Object.entries(row as Record<string, unknown>).map(([key, value]) => {
    if (key !== "raw") return Buffer.from(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    const escaped = bytes.toString("latin1").replace(/[\x00-\x1f"\\]/g,
      (c) => shortEscapes[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return Buffer.from(`"raw":"${escaped}"`, "latin1");
  });
  return Buffer.concat([Buffer.from('{'), ...fields.flatMap((f, i) => i ? [Buffer.from(','), f] : [f]), Buffer.from('}')]);
}

/**
 * Fetch errors raised before the request left this machine: the name did not resolve, or nothing
 * accepted the TCP connection. ClickHouse never saw the request, so retrying is safe for any statement.
 * A reset or timeout can come after the server read the request, so those are not retried here.
 */
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** The store could not be reached after every retry; nothing was sent. */
export class StoreUnreachableError extends Error {
  constructor(readonly code: string, message: string, readonly attempts: number) {
    super(message);
    this.name = "StoreUnreachableError";
  }
}

/** Backoff before each retry of an unsent request: a DNS or connect blip after wake usually clears in seconds. */
export const DEFAULT_UNSENT_RETRY_MS: readonly number[] = [1_000, 3_000, 10_000];

/** Minimal ClickHouse HTTP client: JSONEachRow inserts and plain queries. */
export class ClickHouse {
  constructor(readonly config: ClickHouseConfig, readonly unsentRetryMs: readonly number[] = DEFAULT_UNSENT_RETRY_MS) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): ClickHouse {
    return new ClickHouse({
      url: env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
      user: env.CLICKHOUSE_USER ?? "default",
      password: env.CLICKHOUSE_PASSWORD ?? "",
      database: env.CLICKHOUSE_DB ?? "tokenlayer",
    });
  }

  /**
   * POST and read the whole response. ClickHouse can answer HTTP 200 and still fail
   * (https://clickhouse.com/docs/interfaces/http#http-response-codes-caveats), so every call sets
   * wait_end_of_query=1 (errors then get a real status) and still checks X-ClickHouse-Exception-Code.
   * Error text is redacted: ClickHouse echoes the rows it could not parse.
   */
  private async post(what: string, params: URLSearchParams, body: string | Buffer, bodyIsResult: boolean): Promise<string> {
    params.set("wait_end_of_query", "1");
    const url = `${this.config.url}/?${params}`;
    const init = { method: "POST", headers: { "X-ClickHouse-User": this.config.user, "X-ClickHouse-Key": this.config.password }, body: typeof body === "string" ? body : new Uint8Array(body) };
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, init);
        break;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code !== "string" || !UNSENT_CODES.has(code)) throw err;
        if (attempt >= this.unsentRetryMs.length) throw new StoreUnreachableError(code, (err as Error).message, attempt + 1);
        await Bun.sleep(this.unsentRetryMs[attempt]);
      }
    }
    const text = await res.text();
    const code = res.headers.get("x-clickhouse-exception-code");
    // An insert answers with an empty body, so any exception text in it means the insert failed.
    if (!res.ok || code || (!bodyIsResult && /DB::Exception/.test(text))) {
      throw new Error(`clickhouse ${what} failed: HTTP ${res.status}${code ? ` exception ${code}` : ""} ${redactText(text).slice(0, 300)}`);
    }
    return text;
  }

  /**
   * Insert synchronously. `dedupToken` makes a retried batch a no-op on the server
   * (tables set non_replicated_deduplication_window). Resolves only once ClickHouse confirmed the insert.
   */
  async insert(table: string, rows: readonly unknown[], dedupToken?: string): Promise<void> {
    // Keep the generic client available for parameterized raw-document storage and exports.
    fixed(this, table);
    if (rows.length === 0) return;
    const params = new URLSearchParams({ query: `INSERT INTO ${this.config.database}.${table} FORMAT JSONEachRow`, async_insert: "0" });
    if (dedupToken) params.set("insert_deduplication_token", dedupToken);
    const body = Buffer.concat(rows.flatMap((r) => [encodeRow(r), Buffer.from("\n")]));
    await this.post(`insert into ${table}`, params, body, false);
  }

  /** Run a statement; returns the response body as text. */
  async exec(sql: string): Promise<string> {
    return this.post("query", new URLSearchParams(), sql, true);
  }

  async queryJSON<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const text = await this.exec(`${sql}\nFORMAT JSONEachRow`);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  }
}
