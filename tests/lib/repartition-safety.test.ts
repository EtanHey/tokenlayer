import { describe, expect, test } from "bun:test";
import { ClickHouse } from "../../src/lib/clickhouse";
import { copyWatched, repartitionSessionEvents } from "../../src/lib/session-repartition";

// Models a writer resolving the old table during preflight, before EXCHANGE. Its part
// appears only on commit. No ClickHouse process or production request is involved.
class SwapFixture extends ClickHouse {
  daily = false;
  archive = false;
  writer = false;
  rows = 0;
  liveRows = 0;
  dropped = false;
  writerQueries: string[] = [];
  constructor() { super({ url: "http://unused.invalid", database: "tokenlayer", user: "fixture", password: "" }); }
  override async exec(sql: string): Promise<string> {
    if (sql.startsWith("EXCHANGE")) { this.daily = true; this.archive = true; }
    if (sql.startsWith("SELECT toString(now")) return "2026-11-20 00:00:00";
    if (sql.startsWith("INSERT INTO")) this.liveRows += this.rows;
    if (sql.includes("DROP PART '")) this.rows = 0;
    if (sql.startsWith("SELECT count()")) return String(this.rows);
    if (sql.startsWith("DROP TABLE")) { this.dropped = true; this.archive = false; this.rows = 0; }
    return "";
  }
  override async queryJSON<T>(sql: string): Promise<T[]> {
    let result: unknown[];
    if (sql.includes("FROM system.tables")) {
      await Bun.sleep(2); // the resumed run must not accidentally get an elapsed >= 0 predicate
      result = [
      { name: "session_events", partition_key: this.daily ? "toYYYYMMDD(ts)" : "toYYYYMM(ts)" },
      ...(this.archive ? [{ name: "session_events_monthly", partition_key: "toYYYYMM(ts)" }] : []),
    ]; }
    else if (sql.includes("query_kind = 'Insert'")) {
      this.writerQueries.push(sql);
      // This INSERT is younger than the run, so the old elapsed predicate hides it.
      const elapsed = /elapsed >= (\d+)/.exec(sql);
      result = this.writer && (!elapsed || Number(elapsed[1]) === 0) ? [{ query_id: "ship-during-preflight" }] : [];
    } else if (sql.includes("FROM system.processes")) result = [];
    else if (sql.includes("FROM system.parts")) result = this.rows ? [{ partition: "202611", part: "202611_1_1_0", bytes: "1", rows: String(this.rows) }] : [];
    else if (sql.includes("_part AS part")) result = this.rows ? [{ part: "202611_1_1_0", day: "20261119", rows: String(this.rows), line_bytes: "1" }] : [];
    else if (sql.includes("FROM system.columns")) result = [{ name: "ts" }];
    else if (sql.includes("countIf(l.at < a.at)")) result = [{ kept: String(this.rows), missing: String(Math.max(0, this.rows - this.liveRows)) }];
    else throw new Error(`unexpected fixture query: ${sql}`);
    return result as T[];
  }
}
const runOptions = { freeBytes: async () => 1000, floorBytes: 1, killMarginBytes: 0, settleMs: 0 };

describe("R12-1: pre-swap writers and resume", () => {
  for (const resume of [false, true]) test(resume ? "resume holds for every relevant INSERT" : "writer admitted during preflight retains its committed rows", async () => {
    const ch = new SwapFixture();
    if (resume) { ch.daily = true; ch.archive = true; ch.writer = true; }
    const first = await repartitionSessionEvents(ch, { ...runOptions, shipperCheck: async () => {
      ch.writer = true;
      await Bun.sleep(2);
      return [];
    } });
    expect(first.state).toBe("partial");
    expect(ch.dropped).toBe(false);
    expect(first.stopped).toContain("ship-during-preflight");
    // The held writer now commits to the old table. Resume must discover/copy its part.
    ch.writer = false;
    ch.rows = 1;
    const second = await repartitionSessionEvents(ch, runOptions);
    expect(second.state).toBe("done");
    expect(ch.liveRows).toBe(1);
    expect(ch.dropped).toBe(true);
    expect(ch.writerQueries.every(sql => !sql.includes("elapsed"))).toBe(true);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<string>(r => { resolve = () => r(""); });
  return { promise, resolve };
}
// An outer test deadline returns a value, so old code fails assertions in milliseconds
// rather than leaving a timed-out test or pending HTTP request behind.
async function boundedResult(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise.then(value => ({ value }), error => ({ error: String(error) })),
      new Promise<{ timeout: true }>(r => { timer = setTimeout(() => r({ timeout: true }), 150); })]);
  } finally { clearTimeout(timer!); }
}
const watchOptions = { killBelow: 10, watchMs: 1, killConfirmMs: 25, controlTimeoutMs: 5 };

describe("R12-2: bounded watchdog controls", () => {
  for (const abort of [false, true]) test(abort ? "abort interrupts a pending disk probe" : "never-resolving disk probes count as failures and kill", async () => {
    const copy = deferred(), disk = deferred();
    const controller = new AbortController();
    let kill = 0, reads = 0, probeSignal: AbortSignal | undefined;
    const ch = {
      exec: async (sql: string) => { if (sql.startsWith("INSERT")) return copy.promise; kill++; copy.resolve(); return ""; },
      queryJSON: async () => [],
    } as unknown as ClickHouse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = copyWatched(ch, "INSERT fixture", "r12-unit", { ...watchOptions,
      ...(abort ? { signal: controller.signal, controlTimeoutMs: 1000 } : {}),
      free: async (signal?: AbortSignal) => {
        reads++; probeSignal = signal;
        if (abort) timer = setTimeout(() => controller.abort(), 1);
        await disk.promise;
        return 100;
      },
    });
    try {
      expect(await boundedResult(result)).toEqual({ value: expect.stringContaining(abort ? "aborted" : "could not be read 3 times") });
      expect(kill).toBeGreaterThan(0);
      expect(reads).toBe(abort ? 1 : 3);
      expect(probeSignal?.aborted).toBe(true);
    } finally { clearTimeout(timer); copy.resolve(); disk.resolve(); await result.catch(() => {}); }
  });

  for (const hang of ["kill", "process"] as const) for (const controlTimeoutMs of [5, 1000]) test(`never-resolving ${hang}, request bound ${controlTimeoutMs} ms, stops at the confirmation deadline`, async () => {
    const copy = deferred(), control = deferred();
    let probeSignal: AbortSignal | undefined;
    const ch = {
      exec: async (sql: string, options?: { signal?: AbortSignal }) => {
        if (sql.startsWith("INSERT")) return copy.promise;
        probeSignal = options?.signal;
        if (hang === "kill") return control.promise;
        copy.resolve(); return "";
      },
      queryJSON: async (_sql: string, options?: { signal?: AbortSignal }) => {
        probeSignal = options?.signal;
        await control.promise;
        return [];
      },
    } as unknown as ClickHouse;
    const result = copyWatched(ch, "INSERT fixture", "r12-unit", { ...watchOptions, controlTimeoutMs, free: async () => 0 });
    try {
      expect(await boundedResult(result)).toEqual({ error: expect.stringMatching(/not confirmed.*may still be writing/) });
      expect(probeSignal?.aborted).toBe(true);
    } finally { copy.resolve(); control.resolve(); await result.catch(() => {}); }
  });
});

describe("R12-2: control cancellation reaches HTTP", () => {
  for (const json of [false, true]) test(json ? "queryJSON forwards its signal" : "exec forwards its signal", async () => {
    const { spyOn } = await import("bun:test");
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response(json ? '{"n":1}\n' : "1"));
    const controller = new AbortController();
    try {
      const ch = new ClickHouse({ url: "http://unused.invalid", database: "tokenlayer", user: "fixture", password: "" });
      if (json) expect(await ch.queryJSON("SELECT 1 AS n", { signal: controller.signal })).toEqual([{ n: 1 }]);
      else expect(await ch.exec("SELECT 1", { signal: controller.signal })).toBe("1");
      expect(request.mock.calls[0][1]?.signal).toBe(controller.signal);
    } finally { request.mockRestore(); }
  });
});
