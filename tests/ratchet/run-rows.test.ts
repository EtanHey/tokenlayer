import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A fake `bun` on PATH counts suite runs and prints a fixed Bun summary.
function fixture(status: number) {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/run-rows-")), bin = join(dir, "bin"), tree = join(dir, "tree");
  mkdirSync(bin);
  mkdirSync(tree);
  writeFileSync(join(bin, "bun"), `#!/bin/sh
echo "$*" >> '${join(dir, "runs")}'
printf '7 pass\\n0 fail\\n' >&2
exit ${status}
`);
  chmodSync(join(bin, "bun"), 0o755);
  const rows = [
    { id: "unit-tests-pass", runner: "ci", direction: "pass", command: "bun test", timeout_s: 30 },
    { id: "unit-tests-count", runner: "ci", direction: "min", command: "node ratchet/measure.mjs unit", timeout_s: 30 },
  ];
  const script = `import { runRows } from ${JSON.stringify(resolve("ratchet/run-rows.mjs"))};
console.log(JSON.stringify(runRows(${JSON.stringify(rows)}, ${JSON.stringify(tree)})));`;
  const run = Bun.spawnSync(["node", "--input-type=module", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const runs = existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n") : [];
  return { run, runs, values: run.exitCode === 0 ? JSON.parse(run.stdout.toString().trim().split("\n").pop()!) : undefined, local: resolve(".local") };
}

test("CI1 pass and count rows share one Bun suite run per source tree", () => {
  const before = new Set(readdirSync(".local").filter((n) => n.startsWith("unit-")));
  const { run, runs, values, local } = fixture(0);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": true, "unit-tests-count": 7 });
  expect(runs).toEqual(["test"]);
  // The shared suite output is removed once the rows are measured.
  expect(readdirSync(local).filter((n) => n.startsWith("unit-") && !before.has(n))).toEqual([]);
});

test("CI1 a failing suite still fails both rows and is never reused", () => {
  const { run, runs, values } = fixture(1);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": null, "unit-tests-count": null });
  expect(runs).toEqual(["test", "test"]);
});
