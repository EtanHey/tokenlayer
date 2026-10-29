import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { labelHash } from "../../src/lib/hash";
import { type SteerHub, tick } from "../../src/steer/steer";
import type { Credential } from "../../src/steer/types";

const live = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/steer/credentials-live-redacted.json"), "utf8")) as {
  files: Credential[];
  observed_at: string;
};
const NOW = Date.parse(live.observed_at);
const codex: Credential = { id: "codex-1", auth_index: "idx-codex", provider: "codex", account_type: "oauth", status: "active", priority: 7 };

/** In-memory hub: PATCHes land in `files`, so a second tick sees the first tick's result. */
function fakeHub(files: Credential[], failFor: string[] = []) {
  const state = structuredClone(files);
  const patches: { id: string; priority: number }[] = [];
  const hub: SteerHub = {
    list: async () => structuredClone(state),
    setPriority: async (id, priority) => {
      if (failFor.includes(id)) throw new Error("PATCH /credentials/fields -> 500");
      patches.push({ id, priority });
      const c = state.find((f) => f.id === id)!;
      c.priority = priority === 0 ? null : priority;
    },
  };
  return { hub, patches, state };
}

describe("tick", () => {
  test("PATCHes only the diffs and logs one redacted line per change", async () => {
    const { hub, patches } = fakeHub([...live.files, codex]);
    const lines: string[] = [];
    const r = await tick(hub, { now: NOW, log: (l) => lines.push(l) });

    expect(patches).toEqual([
      { id: "claude-max-a.json", priority: 100 },
      { id: "claude-max-b.json", priority: 50 },
    ]);
    expect(r.changes).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`credential=${labelHash("0000000000000ab0")}`);
    expect(lines[0]).toContain("priority 0->100");
    for (const l of lines) expect(l).not.toMatch(/max-[ab]|example\.com|\.json|\/redacted/);
  });

  test("a second tick over the PATCHed state is a no-op", async () => {
    const { hub, patches } = fakeHub(live.files);
    await tick(hub, { now: NOW, log: () => {} });
    const lines: string[] = [];
    const r = await tick(hub, { now: NOW + 60_000, log: (l) => lines.push(l) });
    expect(patches).toHaveLength(2);
    expect(r.changes).toBe(0);
    expect(lines).toEqual([]);
  });

  test("a null priority is read as 0, so an API key at null is not re-PATCHed", async () => {
    const key: Credential = { id: "claude-key", auth_index: "idx-key", provider: "claude", account_type: "api_key", status: "active", priority: null };
    const { hub, patches } = fakeHub([key]);
    await tick(hub, { now: NOW, log: () => {} });
    expect(patches).toEqual([]);
  });

  test("--dry-run plans without PATCHing", async () => {
    const { hub, patches } = fakeHub(live.files);
    const lines: string[] = [];
    const r = await tick(hub, { now: NOW, dryRun: true, log: (l) => lines.push(l) });
    expect(patches).toEqual([]);
    expect(r.changes).toBe(2);
    expect(lines.every((l) => l.includes("dry-run"))).toBe(true);
  });

  test("a failed PATCH is logged and counted; the other credential still moves", async () => {
    const { hub, patches } = fakeHub(live.files, ["claude-max-a.json"]);
    const lines: string[] = [];
    const r = await tick(hub, { now: NOW, log: (l) => lines.push(l) });
    expect(patches).toEqual([{ id: "claude-max-b.json", priority: 50 }]);
    expect(r.patchErrors).toBe(1);
    expect(r.errors).toBe(0);
    expect(lines.some((l) => l.includes("error") && l.includes("500"))).toBe(true);
  });

  test("zero credentials is a clean no-op", async () => {
    const { hub } = fakeHub([]);
    const snaps: unknown[] = [];
    const r = await tick(hub, { now: NOW, log: () => {}, onSnapshot: (rows) => void snaps.push(rows) });
    expect(r).toMatchObject({ credentials: 0, changes: 0, errors: 0 });
    expect(snaps).toEqual([[]]);
  });
});

describe("onSnapshot rows match P4's credentials_snap columns", () => {
  const COLUMNS = [
    "ts", "hub", "credential", "provider", "priority", "status", "disabled", "unavailable", "next_retry_after",
    "reset_5h", "reset_7d", "utilization_5h", "utilization_7d", "signals", "action",
  ].sort();

  test("one row per credential, identities hashed, times in ClickHouse DateTime64(3) text", async () => {
    const { hub } = fakeHub([...live.files, codex]);
    let rows: Record<string, unknown>[] = [];
    await tick(hub, { now: NOW, hub: "m1", log: () => {}, onSnapshot: (r) => void (rows = r as never) });

    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(COLUMNS);
    const [a, b, c] = rows;
    expect(a).toMatchObject({
      ts: "2026-10-28 08:48:58.786",
      hub: "m1",
      credential: labelHash("0000000000000ab0"),
      provider: "claude",
      priority: 100,
      status: "active",
      disabled: false,
      unavailable: false,
      next_retry_after: null,
      reset_5h: "2026-10-28 12:50:00.000",
      reset_7d: "2026-10-30 19:00:00.000",
      utilization_5h: 0.64,
      utilization_7d: 0.1,
      action: "promote",
    });
    expect(b).toMatchObject({ priority: 50, action: "promote", utilization_7d: 0.93 });
    expect(c).toMatchObject({ provider: "codex", priority: 7, action: "untouched", reset_7d: null });
    expect((a.signals as Record<string, string>)["Anthropic-Ratelimit-Unified-7d-Status"]).toBe("allowed");
    expect(JSON.stringify(rows)).not.toMatch(/max-[ab]|example\.com|\/redacted|idx-codex/);
  });

  test("dry-run rows keep the live priority and mark the planned action", async () => {
    const { hub } = fakeHub(live.files);
    let rows: Record<string, unknown>[] = [];
    await tick(hub, { now: NOW, dryRun: true, log: () => {}, onSnapshot: (r) => void (rows = r as never) });
    expect(rows.map((r) => [r.priority, r.action])).toEqual([
      [0, "plan:promote"],
      [0, "plan:promote"],
    ]);
  });

  test("a throwing onSnapshot does not fail the tick", async () => {
    const { hub, patches } = fakeHub(live.files);
    const lines: string[] = [];
    const r = await tick(hub, {
      now: NOW,
      log: (l) => lines.push(l),
      onSnapshot: () => {
        throw new Error("clickhouse down");
      },
    });
    expect(patches).toHaveLength(2);
    expect(r.errors).toBe(1);
    expect(lines.some((l) => l.includes("snapshot") && l.includes("clickhouse down"))).toBe(true);
  });
});

test('refused PATCH backs off independently while siblings keep moving', async () => {
 const {hub,state,patches}=fakeHub(live.files);
 const original=hub.setPriority;
 let attempts=0;
 hub.setPriority=async(id,priority)=>{
 if(id===live.files[0]!.id && ++attempts<3) throw new Error('refused');
 await original(id,priority);
 };
 for(const minute of [0,1,2,3,4,5,6,7]) {
 state[1]!.priority=0;
 const result=await tick(hub,{now:NOW+minute*60000,log:()=>{}});
 expect(result.errors).toBe(0);
 }
 expect(attempts).toBe(3);
 expect(patches.filter(p=>p.id===live.files[1]!.id)).toHaveLength(8);
});
