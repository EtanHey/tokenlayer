import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles, parseEnv } from "../../src/lib/env";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "tokenlayer-env-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("parses KEY=VALUE, export prefix, quotes and comments", () => {
  expect(parseEnv(`# c\nexport A=1\nB="two words"\nC='x=y'\n\nbad line\n`)).toEqual({ A: "1", B: "two words", C: "x=y" });
});

test("loads files in order; missing files are skipped; process env wins", () => {
  writeFileSync(join(dir, "a.env"), "X=from-a\nY=from-a\n");
  writeFileSync(join(dir, "b.env"), "Y=from-b\n");
  const env = loadEnvFiles([join(dir, "a.env"), join(dir, "missing.env"), join(dir, "b.env")], { X: "from-process" });
  expect(env.X).toBe("from-process");
  expect(env.Y).toBe("from-b");
});
