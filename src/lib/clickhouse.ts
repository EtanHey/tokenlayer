import { redactText } from "./redact";

export type ClickHouseConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
};

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
  private async post(what: string, params: URLSearchParams, body: string, bodyIsResult: boolean): Promise<string> {
    params.set("wait_end_of_query", "1");
    const res = await fetch(`${this.config.url}/?${params}`, { method: "POST", headers: this.headers(), body });
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
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
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
