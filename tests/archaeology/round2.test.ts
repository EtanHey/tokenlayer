import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertOutputsSeparate } from "../../src/archaeology/output-paths";

const scratch = () => { mkdirSync(".local", { recursive: true }); return realpathSync(mkdtempSync(".local/round2-")); };

test("SHOULD-C main refuses a symlinked --out targeting its inventory directory", () => {
  const dir = scratch(), input = join(dir, "manifest.tsv"), out = join(dir, "alias"), existing = join(dir, "existing.tsv");
  const original = "machine\tsource_kind\tcontainer\tmember_path\tsession_id\tharness\tbytes\tlines\tfirst_ts\tlast_ts\tcwd\tsha256\tmtime\n";
  writeFileSync(input, original); symlinkSync(dir, out);
  writeFileSync(existing, "machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n");
  const result = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--manifest", input, "--existing", existing, "--out", out], { env: { ...process.env, USER: "fixture" } });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("output overlaps an input");
  expect(readFileSync(input, "utf8")).toBe(original);
});

test("NIT-3 output guard refuses hardlinks by device and inode", () => {
  const dir = scratch(), input = join(dir, "input.json"), alias = join(dir, "output.json");
  writeFileSync(input, "fixture"); linkSync(input, alias);
  expect(() => assertOutputsSeparate([alias], [input])).toThrow("output overlaps an input");
  const independent = join(dir, "independent.json"); writeFileSync(independent, "fixture");
  expect(() => assertOutputsSeparate([independent, join(dir, "new", "output")], [input])).not.toThrow();
  expect(readFileSync(input, "utf8")).toBe("fixture");
});

for (const kind of ["symlink", "dangling symlink", "hardlink", "directory symlink"] as const) test(`MUST-2 refuses unrelated ${kind} output without follow-through writes`, () => {
  const dir = scratch(), input = join(dir, "inventory.tsv"), existing = join(dir, "existing.tsv"), out = join(dir, "out"), victim = join(dir, "victim.txt");
  writeFileSync(input, "machine\tsource_kind\tcontainer\tmember_path\tsession_id\tharness\tbytes\tlines\tfirst_ts\tlast_ts\tcwd\tsha256\tmtime\n");
  writeFileSync(existing, "machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n");
  writeFileSync(victim, "unrelated fixture\n");
  if (kind === "directory symlink") symlinkSync(dir, out);
  else {
    mkdirSync(out);
    const target = join(out, "repo_map.ddl.sql");
    if (kind === "hardlink") linkSync(victim, target);
    else symlinkSync(kind === "symlink" ? victim : join(dir, "absent"), target);
  }
  const result = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", input, "--existing", existing, "--out", out], { env: { ...process.env, USER: "fixture" } });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(victim, "utf8")).toBe("unrelated fixture\n");
});

test("MUST-2 replaces existing regular output atomically", () => {
  const dir = scratch(), input = join(dir, "inventory.tsv"), existing = join(dir, "existing.tsv"), out = join(dir, "out");
  mkdirSync(out);
  const target = join(out, "repo_map.ddl.sql"); writeFileSync(target, "old");
  const inode = statSync(target, { bigint: true }).ino;
  writeFileSync(input, "machine\tsource_kind\tcontainer\tmember_path\tsession_id\tharness\tbytes\tlines\tfirst_ts\tlast_ts\tcwd\tsha256\tmtime\n");
  writeFileSync(existing, "machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n");
  const result = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", input, "--existing", existing, "--out", out], { env: { ...process.env, USER: "fixture" } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(statSync(target, { bigint: true }).ino).not.toBe(inode);
  expect(readFileSync(target, "utf8")).toStartWith("-- PROPOSAL");
});
