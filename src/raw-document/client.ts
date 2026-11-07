import { ClickHouse, encodeRow, RAW_BYTES, type ClickHouseConfig } from '../lib/clickhouse';

/** Explicit raw-only HTTP profile. The shared live client has no bounded transport dependency. */
export type RawClickHouseConfig = ClickHouseConfig & {
  requestTimeoutMs: number; maxRequestBytes: number; maxResponseBytes: number;
};
export class RawClickHouse {
  #limits: Readonly<{ requestTimeoutMs: number; maxRequestBytes: number; maxResponseBytes: number }>;
  constructor(readonly config: RawClickHouseConfig) {
    let captured: RawClickHouseConfig;
    try { captured = { ...config }; } catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
    try {
      const values = [captured.requestTimeoutMs, captured.maxRequestBytes, captured.maxResponseBytes];
      if (values.some((v, i) => !Number.isSafeInteger(v) || v! <= 0 || v! > [60_000, 16 * 1024 ** 2, 2 * 1024 ** 2][i]) ||
        [captured.url, captured.user, captured.password, captured.database].some(v => typeof v !== 'string')) throw Error();
      const u = new URL(captured.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error();
      this.config = Object.freeze(captured);
      this.#limits = Object.freeze({ requestTimeoutMs: captured.requestTimeoutMs!, maxRequestBytes: captured.maxRequestBytes!, maxResponseBytes: captured.maxResponseBytes! });
    } catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
  }

  private headers(): Record<string, string> {
    return { "X-ClickHouse-User": this.config.user, "X-ClickHouse-Key": this.config.password };
  }

  private async post(params: URLSearchParams, body: string | Buffer, result: boolean, signal?: AbortSignal) {
    params.set('wait_end_of_query', '1');
    return this.bounded(params, body, result, signal);
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
      if (!res.ok || res.headers.get('x-clickhouse-exception-code') || /(?:^|\n)\s*(?:Code:\s*\d+\.\s*)?DB::Exception\b/.test(text) || !result && size !== 0) throw Error();
      return text;
    } catch { abort.abort(); throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
    finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (reader) void reader.cancel().catch(() => {}); }
  }

  async insert(table: string, rows: readonly unknown[], dedupToken?: string, signal?: AbortSignal): Promise<void> {
    try {
    if (rows.length === 0) return;
    const params = new URLSearchParams({ query: `INSERT INTO ${this.config.database}.${table} FORMAT JSONEachRow`, async_insert: "0" });
    if (dedupToken) params.set("insert_deduplication_token", dedupToken);
    const parts: Buffer[] = []; let size = 0;
    for (const row of rows) {
      if (Buffer.isBuffer((row as { [RAW_BYTES]?: Buffer })?.[RAW_BYTES]) && (row as { [RAW_BYTES]: Buffer })[RAW_BYTES].length > this.#limits.maxRequestBytes) throw Error('CLICKHOUSE_BOUNDED_REFUSED');
      const b = encodeRow(row); size += b.length + 1;
      if (size > this.#limits.maxRequestBytes) throw Error('CLICKHOUSE_BOUNDED_REFUSED'); parts.push(b, Buffer.from('\n'));
    }
    await this.post(params, Buffer.concat(parts, size), false, signal);
    } catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
  }

  /** Run a statement; returns the response body as text. */
  async exec(sql: string, signal?: AbortSignal): Promise<string> {
    return this.post(new URLSearchParams(), sql, true, signal);
  }

  async queryJSON<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]> {
    const text = await this.exec(`${sql}\nFORMAT JSONEachRow`, signal);
    try { return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T); }
    catch { throw Error('CLICKHOUSE_BOUNDED_REFUSED'); }
  }
}

/** Existing manual raw storage also accepts the original unbounded legacy client. */
export type RawClient = ClickHouse | RawClickHouse;
/** Clone concrete transport identity as well as captured configuration. */
export function cloneRawClient(client: RawClient): RawClient {
  return client instanceof RawClickHouse ? new RawClickHouse({ ...client.config }) : new ClickHouse({ ...client.config });
}
