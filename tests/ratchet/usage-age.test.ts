import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USAGE_WAKE_GRACE_S, usageAge } from "../../ratchet/usage-age";

// What the M4 answers: last wake, boot, its clock, then usage.json (the writer runs every 60 s on the M4 only).
const NOW = Date.parse("2026-11-19T06:00:00Z");
const sec = (iso: string) => Date.parse(iso) / 1000;
const answer = (o: { wake?: string; boot?: string; generated_at?: string | null; stale?: boolean }) => [
  `wake { sec = ${sec(o.wake ?? "2026-11-19T05:00:00Z")}, usec = 512 } Thu Nov 19 05:00:00 2026`,
  `boot { sec = ${sec(o.boot ?? "2026-11-10T00:00:00Z")}, usec = 0 } Tue Nov 10 00:00:00 2026`,
  `now ${NOW / 1000}`,
  JSON.stringify({ generated_at: o.generated_at === undefined ? "2026-11-19T05:59:30.000Z" : o.generated_at, source: "cliproxy-hub", stale: o.stale ?? false, accounts: [] }),
].join("\n");

test("reads the M4 snapshot's age over ssh", () => {
  expect(usageAge({ exitCode: 0, stdout: answer({}), stderr: "" }, NOW)).toBe(30);
});

test("an asleep or offline M4 is skipped (row state held), never MISSING", () => {
  for (const stderr of ["ssh: connect to host macbook-pro port 22: Operation timed out", "ssh: connect to host macbook-pro port 22: No route to host",
    "ssh: Could not resolve hostname macbook-pro: nodename nor servname provided", "ssh: connect to host macbook-pro port 22: Host is down"])
    expect(usageAge({ exitCode: 255, stdout: "", stderr }, NOW)).toBe("skip");
});

test("a reachable M4 with a stale, unwritten or missing snapshot is MISSING (a real FAIL)", () => {
  expect(usageAge({ exitCode: 0, stdout: answer({ stale: true }), stderr: "" }, NOW)).toBeNull();
  expect(usageAge({ exitCode: 0, stdout: answer({ generated_at: null, stale: true }), stderr: "" }, NOW)).toBeNull();
  expect(usageAge({ exitCode: 1, stdout: answer({}).split("\n").slice(0, 3).join("\n"), stderr: "cat: usage.json: No such file" }, NOW)).toBeNull();
  // ssh refusing our key is a broken probe, not a sleeping Mac.
  expect(usageAge({ exitCode: 255, stdout: "", stderr: "etanheyman@macbook-pro: Permission denied (publickey)." }, NOW)).toBeNull();
  expect(usageAge({ exitCode: null, stdout: "", stderr: "" }, NOW)).toBeNull();
});

test("an old snapshot after a long-ago wake is reported as its age, so the row trips", () => {
  expect(usageAge({ exitCode: 0, stdout: answer({ generated_at: "2026-11-19T05:50:00.000Z" }), stderr: "" }, NOW)).toBe(600);
});

test("just after a wake the pre-sleep snapshot is skipped until the writer has run", () => {
  const woke = new Date(NOW - (USAGE_WAKE_GRACE_S - 10) * 1000).toISOString();
  expect(usageAge({ exitCode: 0, stdout: answer({ wake: woke, generated_at: "2026-11-19T01:00:00.000Z" }), stderr: "" }, NOW)).toBe("skip");
  expect(usageAge({ exitCode: 0, stdout: answer({ wake: woke, stale: true }), stderr: "" }, NOW)).toBe("skip");
  // A snapshot written after the wake is real data, even inside the grace.
  expect(usageAge({ exitCode: 0, stdout: answer({ wake: woke, generated_at: "2026-11-19T05:59:50.000Z" }), stderr: "" }, NOW)).toBe(10);
  // A fresh boot counts as a wake.
  expect(usageAge({ exitCode: 0, stdout: answer({ wake: "2026-11-01T00:00:00Z", boot: woke, generated_at: "2026-11-19T01:00:00.000Z" }), stderr: "" }, NOW)).toBe("skip");
});

test("the row's own command on the M1 skips when the M4 cannot be reached", () => {
  mkdirSync(".local", { recursive: true });
  const home = realpathSync(mkdtempSync(".local/usage-age-"));
  const run = Bun.spawnSync(["bash", "-c", "bun ratchet/live.ts usage_json_age_s"], {
    env: { ...process.env, HOME: home, TOKENLAYER_USAGE_HOST: "r2-unreachable.invalid" }, timeout: 25_000,
  });
  expect({ exit: run.exitCode, out: run.stdout.toString().trim().split("\n").pop() }).toEqual({ exit: 0, out: "skip" });
  const row = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows.find((r: { id: string }) => r.id === "usage_json_age_s");
  expect(row).toMatchObject({ runner: "m1", direction: "max", ceiling: 120 });
});
