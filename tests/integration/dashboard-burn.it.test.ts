import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { labelHash } from "../../src/lib/hash";
import { createHandler } from "../../src/dashboard/server";
import { fakeHub, state } from "../fable/fixtures";

// The burn panel must read where the hub's quota readings actually land. The drain stores every
// response's rate-limit headers in proxy_usage.ratelimit; there is no snapshot table.
describe.skipIf(!clickhouseBinary())("dashboard burn → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let dir: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse({ prepare: applySchema });
    dir = mkdtempSync(join(tmpdir(), "dash-burn-it-"));
  }, 40_000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("weekly and Fable rates come from proxy_usage rate-limit headers", async () => {
    const quarter = 15 * 60_000;
    const base = Math.floor((Date.now() - 3 * 3_600_000) / quarter) * quarter;
    const at = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
    const weekly = "anthropic-ratelimit-unified-7d-utilization";
    const fable = "anthropic-ratelimit-unified-7d_oi-utilization";
    const row = (ms: number, ratelimit: Record<string, string>, provider = "claude") => ({
      ts: at(ms), execution_id: "e" + ms + Object.keys(ratelimit).length, request_id: "r" + ms,
      hub: "m1", credential: labelHash("a"), provider, model: "claude-opus-5-5", ratelimit,
    });
    await ch.client.insert("proxy_usage", [
      row(base - 8 * 3_600_000, { [weekly]: "0.1" }), // outside the 6 h window
      row(base, { [weekly]: "0.4", [fable]: "0.2" }),
      row(base + 60_000, { [weekly]: "0.41" }), // same bucket: the max counts
      row(base + 3_600_000, { [weekly]: "0.45" }),
      row(base + 2 * 3_600_000, { [weekly]: "0.5", [fable]: "0.3" }),
      row(base + 2 * 3_600_000 + 1000, {}), // a response without the headers
      row(base + 2 * 3_600_000 + 2000, { [weekly]: "0.9" }, "codex"),
    ]);
    writeFileSync(join(dir, "state"), JSON.stringify(state()));
    const handler = createHandler({ logins: ["owner"], origin: "https://dash.test", secret: "s",
      hub: fakeHub() as any, ch: ch.client, path: join(dir, "state"), events: join(dir, "events") });
    const response = await handler(new Request("https://dash.test/api/burn",
      { headers: { "Tailscale-User-Login": "owner" } }));
    expect(response.status).toBe(200);
    const burn = await response.json();
    expect(burn.rows.every((r: any) => r.account === "a")).toBe(true);
    const rate = (key: string) => burn.projections.find((p: any) => p.key === key)?.perHour;
    expect(rate("a:weekly")).toBeCloseTo((0.5 - 0.41) / 2, 5); // first bucket max is 0.41
    expect(rate("a:fable")).toBeCloseTo(0.05, 5);
    expect(burn.rows.filter((r: any) => r.window === "weekly").map((r: any) => r.utilization))
      .toEqual([0.41, 0.45, 0.5]);
  });
});
