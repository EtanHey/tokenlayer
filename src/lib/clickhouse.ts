import { redactText } from "./redact";

export type ClickHouseConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
};

// JSONEachRow accepts String bytes without requiring UTF-8. Keep source bytes out of JS decoding.
export const RAW_BYTES = Symbol("source line bytes");
function encodeRow(row: unknown): Buffer {
  const bytes = (row as { [RAW_BYTES]?: Buffer })[RAW_BYTES];
  if (!bytes) return Buffer.from(JSON.stringify(row));
  const fields = Object.entries(row as Record<string, unknown>).map(([key, value]) => {
    if (key !== "raw") return Buffer.from(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    const escaped = bytes.toString("latin1").replace(/[\x00-\x1f"\\]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return Buffer.from(`"raw":"${escaped}"`, "latin1");
  });
  return Buffer.concat([Buffer.from('{'), ...fields.flatMap((f, i) => i ? [Buffer.from(','), f] : [f]), Buffer.from('}')]);
}

/** Minimal ClickHouse HTTP client: JSONEachRow inserts and plain queries. */
export class ClickHouse {
  constructor(readonly config: ClickHouseConfig) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): ClickHouse {
    return new ClickHouse({
      url: env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
      user: env.CLICKHOUSE_USER ?? "default",
      password: env.CLICKHOUSE_PASSWORD ?? "",
      database: env.CLICKHOUSE_DB ?? "tokenlayer",
    });
  }

  private headers(): Record<string, string> {
    return { "X-ClickHouse-User": this.config.user, "X-ClickHouse-Key": this.config.password };
  }

  /**
   * POST and read the whole response. ClickHouse can answer HTTP 200 and still fail
   * (https://clickhouse.com/docs/interfaces/http#http-response-codes-caveats), so every call sets
   * wait_end_of_query=1 (errors then get a real status) and still checks X-ClickHouse-Exception-Code.
   * Error text is redacted: ClickHouse echoes the rows it could not parse.
   */
  private async post(what: string, params: URLSearchParams, body: string | Buffer, bodyIsResult: boolean): Promise<string> {
    params.set("wait_end_of_query", "1");
    const res = await fetch(`${this.config.url}/?${params}`, { method: "POST", headers: this.headers(), body: typeof body === "string" ? body : new Uint8Array(body) });
    const text = await res.text();
    const code = res.headers.get("x-clickhouse-exception-code");
    // An insert answers with an empty body, so any exception text in it means the insert failed.
    const bodyException = !bodyIsResult && /DB::Exception/.test(text);
    if (!res.ok || code || bodyException) {
      throw new Error(`clickhouse ${what} failed: HTTP ${res.status}${code ? ` exception ${code}` : ""} ${redactText(text).slice(0, 300)}`);
    }
    return text;
  }

  /**
   * Insert rows. `dedupToken` makes a retried batch a no-op on the server
   * (tables set non_replicated_deduplication_window). Resolves only once ClickHouse confirmed the insert.
   */
  async insert(table: string, rows: readonly unknown[], dedupToken?: string): Promise<void> {
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
