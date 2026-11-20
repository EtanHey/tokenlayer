import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { burnSQL, burnVerdict, parsePoints } from "../../ratchet/burn";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

const NOW = Date.parse("2026-11-19T12:00:00Z") / 1000;
const RESET = Date.parse("2026-11-20T19:00:00Z") / 1000;
const target = { pct_per_hour: 3, until: "2026-11-20T19:00:00Z" };

describe.skipIf(!clickhouseBinary())("claude_burn_2h SQL → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  /** One request per (account, minutes before NOW, weekly utilization). `fable` adds a 7d_oi key the row must ignore. */
  const insert = (rows: [string, number, number, boolean?, number?][]) => ch.client.exec(`INSERT INTO tokenlayer.proxy_usage (ts, execution_id, credential, account_hash, provider, ratelimit) VALUES ${rows.map(([account, min, u, fable, reset], i) =>
    `(toDateTime64(${NOW - min * 60}, 3, 'UTC'), 'e${i}-${Math.random()}', 'cred-${account}', '${account}', 'claude', map('anthropic-ratelimit-unified-7d-utilization', '${u}', 'anthropic-ratelimit-unified-7d-reset', '${reset ?? RESET}'${fable ? ", 'anthropic-ratelimit-unified-7d_oi-utilization', '0.99'" : ""}))`).join(",")}`);
  const verdict = async () => burnVerdict(parsePoints(await ch.client.exec(burnSQL(NOW))), target, NOW);

  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
  }, 40000);
  afterAll(async () => { await ch?.stop(); });

  test("flat usage: requests keep coming but the week does not move → 0%/h, under the 1.5%/h alarm", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 3000, 0.4], ["a", 150, 0.55], ["a", 100, 0.55, true], ["a", 50, 0.55], ["a", 5, 0.55], ["b", 600, 0.95]]);
    const v = await verdict();
    expect(v.value).toBe(0);
    expect(v.value).toBeLessThan(v.threshold!);
    expect(v.say).toBe("Claude ran 0%/h for the last 2 h against a 3%/h target (alarm under 1.5%/h); 45% of the week is left until Fri 21:00");
  });

  test("on target: 6 points in 2 h, last bucket's max wins over an out-of-order lower reading → 3%/h", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 130, 0.55], ["a", 90, 0.57], ["a", 40, 0.59], ["a", 3, 0.61], ["a", 2, 0.60]]);
    const v = await verdict();
    expect(v.value).toBe(3);
    expect(v.value).toBeGreaterThanOrEqual(v.threshold!);
  });

  test("reset inside a bucket retains both cycles: 2 old-week + 3 new-week points, not 99", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    const oldReset = NOW - 113 * 60; // 10:07 UTC, inside the 10:00 bucket
    await insert([["a", 130, 0.97, false, oldReset], ["a", 118, 0.99, false, oldReset], ["a", 110, 0.03, false, oldReset + 7 * 86400]]);
    const points = parsePoints(await ch.client.exec(burnSQL(NOW)));
    expect(points).toHaveLength(3);
    expect(points.map(p => p.u)).toEqual([0.97, 0.99, 0.03]);
    const v = await verdict();
    expect(v.value).toBe(2.5);
    expect(v.say).toContain("97% of the week");
  });

  test("no request at all in 2 h → 0%/h", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 400, 0.55]]);
    expect((await verdict()).value).toBe(0);
  });
});
