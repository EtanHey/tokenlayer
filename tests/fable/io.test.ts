import { test, expect } from "bun:test";
import { defaults, metadata } from "../../src/fable/core";
import { execute, locked } from "../../src/fable/io";

test("unchanged target does not persist or create an operation", async () => {
  const s = { ...defaults(), baseline: { a: metadata({}) } };
  let saves = 0;
  await execute(
    s,
    { a: [] },
    {
      metadata: () => metadata({}),
      catalog: async () => [],
      patch: async () => {
        throw Error("unexpected write");
      },
    },
    "idle",
    () => {
      saves++;
    },
    () => {},
  );
  expect(saves).toBe(0);
  expect(s.ops).toEqual({});
});
test("two concurrent writers never interleave", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/fable-lock-");
  const seen: number[] = [];
  try {
    await Promise.all(
      [1, 2].map((n) =>
        locked(async () => {
          seen.push(n);
          await Bun.sleep(20);
          seen.push(n);
        }, dir + "/state"),
      ),
    );
    expect(seen).toEqual([1, 1, 2, 2]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
