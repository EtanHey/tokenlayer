import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveRows, plan } from "../../ratchet/live-schedule";

const rows = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows;
const PREFIX = "### tokenlayer-ratchet → @tokenlayer-lead @orc — ";
const posts = (text: string) => text.split("\n").filter((line) => line.startsWith("### "));

test("schedules every live.ts row, including the Jev unreconciled alert, and nothing else", () => {
  const ids = liveRows(rows).map((r) => r.id);
  expect(ids).toContain("jev_unreconciled_24h");
  expect(ids).toContain("m1_disk_free_gb");
  expect(ids.length).toBe(rows.filter((r: { command: string }) => r.command.startsWith("bun ratchet/live.ts ")).length);
  expect(ids).not.toContain("sessions-between-p95-ms-m1");
});

test("posts once per state change: fail, still failing, cleared", () => {
  const jev = liveRows(rows).find((r) => r.id === "jev_unreconciled_24h")!;
  const now = new Date("2026-11-19T06:00:00Z");
  const red = plan([{ row: jev, value: 2 }], {}, now);
  expect(red.lines).toEqual([`${PREFIX}2026-11-19T06:00:00Z FAIL jev_unreconciled_24h: value 2, threshold ≤ 0 calls`]);
  expect(plan([{ row: jev, value: 3 }], red.state, now).lines).toEqual([]);
  const green = plan([{ row: jev, value: 0 }], red.state, now);
  expect(green.lines).toEqual([`${PREFIX}2026-11-19T06:00:00Z cleared jev_unreconciled_24h: value 0, threshold ≤ 0 calls`]);
  expect(plan([{ row: jev, value: 0 }], {}, now).lines).toEqual([]);
  expect(plan([{ row: jev, value: null }], {}, now).lines[0]).toContain("FAIL jev_unreconciled_24h: value MISSING, threshold ≤ 0 calls");
});

test("forced-failing run posts one line, a repeat posts nothing, recovery posts one cleared line", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/live-schedule-"));
  const outbox = join(dir, "outbox.md"), state = join(dir, "state.json");
  writeFileSync(outbox, "# temp outbox copy\n");
  const values = (jev: number) => Object.fromEntries(liveRows(rows).map((r) => [r.id, r.id === "jev_unreconciled_24h" ? jev : r.direction === "min" ? r.ceiling : 0]));
  const run = (jev: number) => {
    const p = Bun.spawnSync(["bun", "ratchet/live-schedule.ts"], {
      env: { ...process.env, TOKENLAYER_RATCHET_OUTBOX: outbox, TOKENLAYER_RATCHET_STATE: state, TOKENLAYER_RATCHET_OVERRIDE: JSON.stringify(values(jev)) },
    });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    return posts(readFileSync(outbox, "utf8"));
  };
  expect(run(1)).toHaveLength(1);
  expect(run(1)[0]).toMatch(/^### tokenlayer-ratchet → @tokenlayer-lead @orc — \S+ FAIL jev_unreconciled_24h: value 1, threshold ≤ 0 calls \(override\)$/);
  expect(run(1)).toHaveLength(1);
  const after = run(0);
  expect(after).toHaveLength(2);
  expect(after[1]).toContain("cleared jev_unreconciled_24h: value 0");
});

test("refuses to run without an explicit outbox", () => {
  const p = Bun.spawnSync(["bun", "ratchet/live-schedule.ts"], { env: { ...process.env, TOKENLAYER_RATCHET_OUTBOX: "" } });
  expect(p.exitCode).not.toBe(0);
  expect(p.stderr.toString()).toContain("TOKENLAYER_RATCHET_OUTBOX");
});
