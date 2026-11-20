import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHIP_SETTING_LINE, etimeSeconds, shipperProblem } from "../../src/lib/shipper-ready";

const probe = (lines: Record<string, string>, exitCode = 0, stderr = "") =>
  ({ exitCode, stderr, stdout: Object.entries(lines).map(([k, v]) => `${k} ${v}`).join("\n") + "\n" });
const ready = { dir: "/opt/ship/tokenlayer", pid: "53696", etime: "04:31:19", mtime: "1795099504", has: "1", now: "1795115784" };

describe("R12 shipper preflight (S9: no swap while a shipper runs a client without the 100-partition fix)", () => {
  test("this branch's client carries the line the probe looks for", () => {
    expect(readFileSync(new URL("../../src/lib/clickhouse.ts", import.meta.url), "utf8")).toContain(SHIP_SETTING_LINE);
  });
  test("etime parses ps's [[dd-]hh:]mm:ss", () => {
    expect(etimeSeconds("00:05")).toBe(5);
    expect(etimeSeconds("04:31:19")).toBe(4 * 3600 + 31 * 60 + 19);
    expect(etimeSeconds("2-01:00:00")).toBe(49 * 3600);
    expect(etimeSeconds("")).toBeNaN();
  });
  test("ready: the checkout sets the limit and the shipper started after the file last changed", () => {
    expect(shipperProblem("M4", probe(ready))).toBeUndefined();
  });
  test("ready: loaded but not running (it loads the updated checkout when it starts)", () => {
    expect(shipperProblem("M4", probe({ ...ready, pid: "", etime: "" }))).toBeUndefined();
  });
  test("not ready: the checkout lacks the setting (live on both Macs on 2026-11-19, before #199 merged)", () => {
    expect(shipperProblem("M4", probe({ ...ready, has: "0" }))).toMatch(/does not set max_partitions_per_insert_block/);
  });
  test("not ready: the shipper started before the client changed", () => {
    expect(shipperProblem("M4", probe({ ...ready, etime: "1-00:00:00" }))).toMatch(/started before .* restart it/);
  });
  test("not ready: unreachable, not loaded, or unreadable times", () => {
    expect(shipperProblem("M4", probe({}, 255, "ssh: connect to host macbook-pro port 22: Operation timed out"))).toMatch(/could not read.*Operation timed out/);
    expect(shipperProblem("M4", probe({ dir: "", pid: "", now: "1" }))).toMatch(/not loaded/);
    expect(shipperProblem("M4", probe({ ...ready, etime: "garbage" }))).toMatch(/could not tell/);
  });
});
