import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A fake `bun` on PATH counts suite runs and prints a fixed Bun summary.
function fixture(status: number, timeout = false) {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/run-rows-")), bin = join(dir, "bin"), tree = join(dir, "tree");
  mkdirSync(bin);
  mkdirSync(tree);
  writeFileSync(join(bin, "bun"), `#!/bin/sh
echo "$*" >> '${join(dir, "runs")}'
${timeout ? "sleep 2" : ""}
printf '7 pass\\n0 fail\\n' >&2
exit ${status}
`);
  chmodSync(join(bin, "bun"), 0o755);
  const rows = [
    { id: "unit-tests-pass", runner: "ci", direction: "pass", command: "bun test", timeout_s: timeout ? 1 : 30 },
    { id: "unit-tests-count", runner: "ci", direction: "min", command: "node ratchet/measure.mjs unit", timeout_s: 30 },
  ];
  const script = `import { runRows } from ${JSON.stringify(resolve("ratchet/run-rows.mjs"))};
console.log(JSON.stringify(runRows(${JSON.stringify(rows)}, ${JSON.stringify(tree)})));`;
  const run = Bun.spawnSync(["node", "--input-type=module", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const runs = existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n") : [];
  return { run, runs, values: run.exitCode === 0 ? JSON.parse(run.stdout.toString().trim().split("\n").pop()!) : undefined, local: resolve(".local") };
}

test("CI1 pass and count rows share one Bun suite run per source tree", () => {
  mkdirSync(".local", { recursive: true });
  const before = new Set(readdirSync(".local").filter((n) => n.startsWith("unit-")));
  const { run, runs, values, local } = fixture(0);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": true, "unit-tests-count": 7 });
  expect(runs.map((r) => r.split(" ")[0])).toEqual(["test"]);
  // The shared suite output is removed once the rows are measured.
  expect(readdirSync(local).filter((n) => n.startsWith("unit-") && !before.has(n))).toEqual([]);
});

test("CI4 a failing suite fails both rows without rerunning it", () => {
  const { run, runs, values } = fixture(1);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": null, "unit-tests-count": null });
  expect(runs.map((r) => r.split(" ")[0])).toEqual(["test"]);
});

test("CI4 a timed-out suite leaves counts missing without a second suite", () => {
  const { run, runs, values } = fixture(0, true);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": null, "unit-tests-count": null });
  expect(runs).toHaveLength(1);
  expect(run.stderr.toString()).toContain("suite failed; no retry");
});

// A fake `bun` that writes a JUnit report when asked, so the integration row can be counted from the pass row's run.
function junitFixture({ status = 0, report }: { status?: number; report: string }) {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/run-rows-it-")), bin = join(dir, "bin"), tree = join(dir, "tree");
  mkdirSync(bin);
  for (const sub of ["tests/integration", "tests/archaeology"]) mkdirSync(join(tree, sub), { recursive: true });
  for (const f of ["tests/integration/a.it.test.ts", "tests/archaeology/b.it.test.ts", "tests/integration/c.test.ts"]) writeFileSync(join(tree, f), "");
  writeFileSync(join(dir, "report.xml"), report);
  writeFileSync(join(bin, "bun"), `#!/bin/sh
echo "$*" >> '${join(dir, "runs")}'
for a in "$@"; do case "$a" in --reporter-outfile=*) cp '${join(dir, "report.xml")}' "\${a#--reporter-outfile=}";; esac; done
printf '9 pass\\n0 fail\\n' >&2
exit ${status}
`);
  chmodSync(join(bin, "bun"), 0o755);
  const rows = [
    { id: "unit-tests-pass", runner: "ci", direction: "pass", command: "bun test", timeout_s: 30 },
    { id: "integration-tests-ran", runner: "ci", direction: "min", command: "node ratchet/measure.mjs integration", timeout_s: 30 },
  ];
  const script = `import { runRows } from ${JSON.stringify(resolve("ratchet/run-rows.mjs"))};
console.log(JSON.stringify(runRows(${JSON.stringify(rows)}, ${JSON.stringify(tree)})));`;
  const run = Bun.spawnSync(["node", "--input-type=module", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const runs = existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n") : [];
  return { run, runs, values: run.exitCode === 0 ? JSON.parse(run.stdout.toString().trim().split("\n").pop()!) : undefined };
}

const suite = (file: string, cases: string) => `<testsuite name="${file}" file="${file}">${cases}</testsuite>`;
const pass = (file: string) => `<testcase name="a -&gt; b" classname="" file="${file}" line="1" />`;
const skip = (file: string, message = "") => `<testcase name="s" classname="" file="${file}"><skipped${message} /></testcase>`;
const report = (...suites: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">${suites.join("")}</testsuites>`;

test("CI2 the integration row counts from the pass row's JUnit report, so each tree runs the suite once", () => {
  const xml = report(
    suite("tests/integration/a.it.test.ts", pass("tests/integration/a.it.test.ts") + pass("tests/integration/a.it.test.ts") + skip("tests/integration/a.it.test.ts", ' message="TODO"')),
    suite("tests/archaeology/b.it.test.ts", `<testsuite name="d &gt; x" file="tests/archaeology/b.it.test.ts">${pass("tests/archaeology/b.it.test.ts")}</testsuite>`),
    // Skips outside the .it.test.ts selection never count, exactly like the subset run.
    suite("tests/integration/c.test.ts", pass("tests/integration/c.test.ts") + skip("tests/integration/c.test.ts")),
  );
  const { run, runs, values } = junitFixture({ report: xml });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": true, "integration-tests-ran": 3 });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toStartWith("test --reporter=junit --reporter-outfile=");
});

test("CI2 a skipped integration test in the shared report still fails the row", () => {
  const xml = report(
    suite("tests/integration/a.it.test.ts", pass("tests/integration/a.it.test.ts")),
    suite("tests/archaeology/b.it.test.ts", skip("tests/archaeology/b.it.test.ts")),
  );
  const { run, runs, values } = junitFixture({ report: xml });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(values).toEqual({ "unit-tests-pass": true, "integration-tests-ran": null });
  expect(runs).toHaveLength(1);
});

test("CI2 a report missing an integration file falls back to running the integration subset", () => {
  const { runs, values } = junitFixture({ report: report(suite("tests/integration/a.it.test.ts", pass("tests/integration/a.it.test.ts"))) });
  expect(runs).toHaveLength(2);
  expect(runs[1]).toBe("test tests/integration/a.it.test.ts tests/archaeology/b.it.test.ts");
  expect(values).toEqual({ "unit-tests-pass": true, "integration-tests-ran": 9 });
});

test("CI4 a failing suite fails the integration row without rerunning the subset", () => {
  const xml = report(suite("tests/integration/a.it.test.ts", pass("tests/integration/a.it.test.ts")), suite("tests/archaeology/b.it.test.ts", pass("tests/archaeology/b.it.test.ts")));
  const { runs, values } = junitFixture({ status: 1, report: xml });
  expect(values).toEqual({ "unit-tests-pass": null, "integration-tests-ran": null });
  expect(runs).toHaveLength(1);
});

test("CI2 a row past 75% of its timeout prints a GitHub warning, and its value is unchanged", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/run-rows-slow-")), bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nsleep 2.4\nprintf '1 pass\\n' >&2\n");
  chmodSync(join(bin, "bun"), 0o755);
  const rows = [
    { id: "unit-tests-pass", runner: "ci", direction: "pass", command: "bun test", timeout_s: 3 },
    { id: "typecheck-pass", runner: "ci", direction: "pass", command: "true", timeout_s: 3 },
  ];
  const script = `import { runRows } from ${JSON.stringify(resolve("ratchet/run-rows.mjs"))};
const values = runRows(${JSON.stringify(rows)}, ${JSON.stringify(dir)}); console.log(JSON.stringify(values));`;
  const run = Bun.spawnSync(["node", "--input-type=module", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const out = run.stdout.toString().trim().split("\n");
  expect(JSON.parse(out.pop()!)).toEqual({ "unit-tests-pass": true, "typecheck-pass": true });
  expect(out.filter((l) => l.startsWith("::warning"))).toHaveLength(1);
  expect(out.find((l) => l.startsWith("::warning"))).toMatch(/^::warning title=Ratchet timeout headroom::unit-tests-pass took \d+\.\ds of its 3s timeout_s/);
});
