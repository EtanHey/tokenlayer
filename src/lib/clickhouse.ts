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
   * Insert rows. `dedupToken` makes a retried batch a no-op on the server
   * (tables set non_replicated_deduplication_window).
   */
  async insert(table: string, rows: readonly unknown[], dedupToken?: string): Promise<void> {
    if (rows.length === 0) return;
    const params = new URLSearchParams({ query: `INSERT INTO ${this.config.database}.${table} FORMAT JSONEachRow` });
    if (dedupToken) params.set("insert_deduplication_token", dedupToken);
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const res = await fetch(`${this.config.url}/?${params}`, { method: "POST", headers: this.headers(), body });
    if (!res.ok) throw new Error(`clickhouse insert into ${table} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    await res.body?.cancel();
  }

  /** Run a statement; returns the response body as text. */
  async exec(sql: string): Promise<string> {
    const res = await fetch(`${this.config.url}/`, { method: "POST", headers: this.headers(), body: sql });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text;
  }

  async queryJSON<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const text = await this.exec(`${sql}\nFORMAT JSONEachRow`);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  }
}
