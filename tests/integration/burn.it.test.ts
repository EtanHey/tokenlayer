import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { burnSQL, burnVerdict, parsePoints } from "../../ratchet/burn";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

// Off the clock's 15-minute grid on purpose: the last hour must start where it starts, not on a wall-clock bucket.
const NOW = Date.parse("2026-11-19T12:07:00Z") / 1000;
const RESET = NOW + 37 * 3600; // Sat 03:07 IST: 45% left − 8% reserve over 37 h = 1%/h
const reserve = { pct: 8, from: "file" };

describe.skipIf(!clickhouseBinary())("claude_burn_2h SQL → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  /** One request per (account, minutes before NOW, weekly utilization). `fable` adds a 7d_oi key the row must ignore. */
  const insert = (rows: [string, number, number, boolean?, number?][]) => ch.client.exec(`INSERT INTO tokenlayer.proxy_usage (ts, execution_id, credential, account_hash, provider, ratelimit) VALUES ${rows.map(([account, min, u, fable, reset], i) =>
    `(toDateTime64(${NOW - min * 60}, 3, 'UTC'), 'e${i}-${Math.random()}', 'cred-${account}', '${account}', 'claude', map('anthropic-ratelimit-unified-7d-utilization', '${u}', 'anthropic-ratelimit-unified-7d-reset', '${reset ?? RESET}'${fable ? ", 'anthropic-ratelimit-unified-7d_oi-utilization', '0.99'" : ""}))`).join(",")}`);
  const verdict = async () => burnVerdict(parsePoints(await ch.client.exec(burnSQL(NOW))), reserve, NOW);

  beforeAll(async () => {
    ch = await startLocalClickHouse({ prepare: applySchema });
  }, 40000);
  afterAll(async () => { await ch?.stop(); });

  test("under-run: requests keep coming but the week does not move → 0%/h against the 1%/h target, fails", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 3000, 0.4], ["a", 150, 0.55], ["a", 100, 0.55, true], ["a", 50, 0.55], ["a", 5, 0.55], ["b", 600, 0.95]]);
    const v = await verdict();
    expect(v).toMatchObject({ value: 0, fail: true });
    expect(v.say).toBe("under half the target: Claude ran 0%/h for the last 2 h and 0%/h for the last hour against a 1%/h target (alarm under 0.5%/h for 2 h or over 2%/h for 1 h); target = (45% of the week left − 8% reserve) / 37 h until the reset Sat 03:07 IST");
  });

  test("on target: last bucket's max wins over an out-of-order lower reading → 1%/h, passes", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 130, 0.53], ["a", 90, 0.535], ["a", 61, 0.54], ["a", 3, 0.55], ["a", 2, 0.545]]);
    expect(await verdict()).toMatchObject({ value: 1, fail: false });
  });

  test("over-run: the last hour starts exactly an hour ago, not on the wall-clock bucket (11:00–11:15) around it", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    // 61 and 59 min ago share the clock bucket 11:00–11:15Z; only the 59-min reading is inside the last hour.
    await insert([["a", 130, 0.48], ["a", 61, 0.50], ["a", 59, 0.52], ["a", 5, 0.55]]);
    const v = await verdict();
    expect(v).toMatchObject({ value: 3.5, fail: true });
    expect(v.say).toStartWith("over twice the target: Claude ran 3.5%/h for the last 2 h and 5%/h for the last hour");
  });

  test("reset inside a bucket retains both cycles: 2 old-week + 3 new-week points, not 99", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    const oldReset = NOW - 113 * 60; // 7 min after window start, inside its first bucket
    await insert([["a", 130, 0.97, false, oldReset], ["a", 118, 0.99, false, oldReset], ["a", 110, 0.03, false, oldReset + 7 * 86400]]);
    const points = parsePoints(await ch.client.exec(burnSQL(NOW)));
    expect(points).toHaveLength(3);
    expect(points.map(p => p.u)).toEqual([0.97, 0.99, 0.03]);
    const v = await verdict();
    expect(v.value).toBe(2.5);
    expect(v.say).toContain("97% of the week");
  });

  test("no request at all in 2 h → 0%/h; no reading in 8 days → no target, fails", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 400, 0.55]]);
    expect(await verdict()).toMatchObject({ value: 0, fail: true });
    await ch.client.exec("TRUNCATE TABLE tokenlayer.proxy_usage");
    await insert([["a", 9 * 1440, 0.55]]);
    expect(await verdict()).toMatchObject({ value: 0, threshold: null, fail: true });
  });
});
