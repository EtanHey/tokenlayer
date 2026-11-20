import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRepartitionArgs, sizeDays } from "../../src/lib/session-repartition";

const GiB = 1024 ** 3;

describe("schema:repartition flags (S8: malformed numbers refuse instead of turning the disk checks off)", () => {
  test("accepts plain numbers", () => {
    expect(parseRepartitionArgs([])).toEqual({ dryRun: false });
    expect(parseRepartitionArgs(["--dry-run", "--floor-gib", "30", "--disk-multiplier", "3.5", "--max-parts", "0"]))
      .toEqual({ dryRun: true, floorBytes: 30 * GiB, amplification: 3.5, maxParts: 0 });
  });

  for (const args of [
    ["--floor-gib", "30G"], ["--floor-gib", "x"], ["--floor-gib", ""], ["--floor-gib"], ["--floor-gib", "-5"], ["--floor-gib", "0"],
    ["--floor-gib", "Infinity"], ["--floor-gib", "1e3"], ["--floor-gib", " 30"], ["--floor-gib", "0x1E"],
    ["--disk-multiplier", "x"], ["--disk-multiplier", "0.5"], ["--disk-multiplier", "NaN"],
    ["--max-parts", "x"], ["--max-parts", "1.5"], ["--max-parts", "-1"],
    ["--floor-gib", "30", "--floor-gib", "20"], ["--floor-gib=30"], ["--dryrun"], ["30"],
  ]) {
    test(`refuses ${JSON.stringify(args)}`, () => { expect(() => parseRepartitionArgs(args)).toThrow(); });
  }

  test("the CLI refuses a malformed floor before it connects", () => {
    // An unreachable server: the old CLI reached it with a NaN floor and failed on the connection instead.
    const run = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/lib/session-repartition.ts"), "--floor-gib", "30G"], {
      env: { ...process.env, CLICKHOUSE_URL: "http://127.0.0.1:9", CLICKHOUSE_USER: "nobody", CLICKHOUSE_PASSWORD: "" },
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toMatch(/--floor-gib.*30G.*nothing ran/);
  });
});

describe("day sizes (S5: a day counts by its bytes, not only its rows)", () => {
  test("a day with few rows but most of the text gets most of the part", () => {
    const days = sizeDays(1000, [
      { day: "20261107", rows: 450, lineBytes: 450 },
      { day: "20261108", rows: 100, lineBytes: 2_000_000 },
      { day: "20261109", rows: 450, lineBytes: 450 },
    ]);
    expect(days.map(d => d.bytes)).toEqual([450, 1000, 450]);
  });
  test("without line bytes (0), rows decide", () => {
    expect(sizeDays(1000, [{ day: "20261107", rows: 1, lineBytes: 0 }, { day: "20261108", rows: 3, lineBytes: 0 }]).map(d => d.bytes)).toEqual([250, 750]);
  });
});
