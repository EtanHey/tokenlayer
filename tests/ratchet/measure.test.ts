import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("NIT-2 integration measurement rejects an archaeology-only skip", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/measure-skip-")), bun = join(dir, "bun");
  writeFileSync(bun, '#!/usr/bin/env node\nprocess.stderr.write(process.argv.some(p => p.startsWith("tests/archaeology")) ? "37 pass\\n1 skip\\n" : "37 pass\\n");\n');
  chmodSync(bun, 0o755);
  const result = Bun.spawnSync(["node", "ratchet/measure.mjs", "integration"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("integrations skipped");
});

test("NIT-B integration measurement selects only .it.test.ts files", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/measure-selection-")), bun = join(dir, "bun");
  writeFileSync(bun, '#!/usr/bin/env node\nconst files=process.argv.slice(3);process.stderr.write(files.length && files.every(p => p.endsWith(".it.test.ts")) ? "17 pass\\n" : "999 pass\\n");\n');
  chmodSync(bun, 0o755);
  const result = Bun.spawnSync(["node", "ratchet/measure.mjs", "integration"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe("17");
});
