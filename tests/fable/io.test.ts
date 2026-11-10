import { test, expect } from "bun:test";
import { locked, Hub } from "../../src/fable/io";
import { readFileSync, readdirSync } from "node:fs";
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

test("Fable source never references credential-file directory", () => {
  for (const path of readdirSync("src/fable")) {
    if (path.endsWith(".ts"))
      expect(readFileSync("src/fable/" + path, "utf8")).not.toContain(
        ".cli-proxy-api",
      );
  }
});
test("Hub rejects HTTP 200 with empty models", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ models: [] }),
  });
  try {
    await expect(
      new Hub(server.url.origin, "test").catalog("known"),
    ).rejects.toThrow("empty");
  } finally {
    server.stop(true);
  }
});
