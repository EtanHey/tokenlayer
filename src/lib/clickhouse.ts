import { redactText } from "./redact";

export type ClickHouseConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
};

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

/** Minimal ClickHouse HTTP client: JSONEachRow inserts and plain queries. */
export class ClickHouse {
  #limits?: Readonly<{ requestTimeoutMs: number; maxRequestBytes: number; maxResponseBytes: number }>;
  constructor(readonly config: ClickHouseConfig) {
    let captured: ClickHouseConfig;
    try { captured = { ...config }; } catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
    if ([captured.requestTimeoutMs, captured.maxRequestBytes, captured.maxResponseBytes].some(v => v !== undefined)) {
      try {
        const values = [captured.requestTimeoutMs, captured.maxRequestBytes, captured.maxResponseBytes];
        if (values.some((v, i) => !Number.isSafeInteger(v) || v! <= 0 || v! > [60_000, 16 * 1024 ** 2, 2 * 1024 ** 2][i]) ||
          [captured.url, captured.user, captured.password, captured.database].some(v => typeof v !== 'string')) throw Error();
        const u = new URL(captured.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error();
        this.config = Object.freeze(captured);
        this.#limits = Object.freeze({ requestTimeoutMs: captured.requestTimeoutMs!, maxRequestBytes: captured.maxRequestBytes!, maxResponseBytes: captured.maxResponseBytes! });
      } catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
    }
  }

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
  private async post(what: string, params: URLSearchParams, body: string | Buffer, bodyIsResult: boolean, signal?: AbortSignal): Promise<string> {
    params.set("wait_end_of_query", "1");
    if (this.#limits) return this.bounded(params, body, bodyIsResult, signal);
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

  private async bounded(params: URLSearchParams, body: string | Buffer, result: boolean, signal?: AbortSignal) {
    const limits = this.#limits!, url = `${this.config.url}/?${params}`, abort = new AbortController();
    const cancel = () => abort.abort(); let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const requestUrl = new URL(url).href;
      if (signal?.aborted || Buffer.byteLength(requestUrl) + Buffer.byteLength(body) > limits.maxRequestBytes) throw Error();
      signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, limits.requestTimeoutMs);
      const res = await fetch(requestUrl, { method: 'POST', headers: { ...this.headers(), 'Accept-Encoding': 'identity' }, body: typeof body === 'string' ? body : new Uint8Array(body), signal: abort.signal, redirect: 'error' });
      const header = res.headers.get('content-length');
      if (header !== null && (!/^(0|[1-9]\d*)$/.test(header) || !Number.isSafeInteger(Number(header)) || Number(header) > limits.maxResponseBytes)) throw Error();
      const parts: Buffer[] = []; let size = 0; reader = res.body?.getReader();
      if (reader) for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > limits.maxResponseBytes) throw Error(); parts.push(Buffer.from(r.value)); }
      if (abort.signal.aborted || header !== null && Number(header) !== size) throw Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size));
      if (!res.ok || res.headers.get('x-clickhouse-exception-code') || /(?:^|\n)\s*(?:Code:\s*\d+\.\s*)?DB::Exception\b/.test(text) || !result && text !== '') throw Error();
      return text;
    } catch { abort.abort(); throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
    finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (reader) void reader.cancel().catch(() => {}); }
  }

  /**
   * Insert synchronously. `dedupToken` makes a retried batch a no-op on the server
   * (tables set non_replicated_deduplication_window). Resolves only once ClickHouse confirmed the insert.
   */
  async insert(table: string, rows: readonly unknown[], dedupToken?: string, signal?: AbortSignal): Promise<void> {
    try {
    if (rows.length === 0) return;
    const params = new URLSearchParams({ query: `INSERT INTO ${this.config.database}.${table} FORMAT JSONEachRow`, async_insert: "0" });
    if (dedupToken) params.set("insert_deduplication_token", dedupToken);
    if (!this.#limits) {
      const body = Buffer.concat(rows.flatMap(row => [encodeRow(row), Buffer.from('\n')]));
      await this.post(`insert into ${table}`, params, body, false, signal); return;
    }
    const parts: Buffer[] = []; let size = 0;
    for (const row of rows) {
      if (this.#limits && Buffer.isBuffer((row as { [RAW_BYTES]?: Buffer })?.[RAW_BYTES]) && (row as { [RAW_BYTES]: Buffer })[RAW_BYTES].length > this.#limits.maxRequestBytes) throw Error('CLICKHOUSE_BOUNDED_REFUSED');
      const b = encodeRow(row); size += b.length + 1;
      if (this.#limits && size > this.#limits.maxRequestBytes) throw Error('CLICKHOUSE_BOUNDED_REFUSED'); parts.push(b, Buffer.from('\n'));
    }
    await this.post(`insert into ${table}`, params, Buffer.concat(parts, size), false, signal);
    } catch (e) { if (this.#limits) throw Error('CLICKHOUSE_BOUNDED_REFUSED'); throw e; }
  }

  /** Run a statement; returns the response body as text. */
  async exec(sql: string, signal?: AbortSignal): Promise<string> {
    return this.post("query", new URLSearchParams(), sql, true, signal);
  }

  async queryJSON<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]> {
    const text = await this.exec(`${sql}\nFORMAT JSONEachRow`, signal);
    try { return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T); }
    catch (e) { if (this.#limits) throw Error('CLICKHOUSE_BOUNDED_REFUSED'); throw e; }
  }
}
