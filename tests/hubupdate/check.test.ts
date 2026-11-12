import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const core = () => import("../../src/hubupdate/core");
const probe = () => import("../../src/hubupdate/probe");
const header = ",bytes_in,bytes_out,\ncliproxyapi.42,100,200,\n";
const listener = "tcp4 127.0.0.1:8317<->*:*,,,\n";
const connection = "tcp4 127.0.0.1:8317<->127.0.0.1:65055,2109840,5051,\n";
const sample = (row = connection) => header + row + listener;
const info = (installed = "8.0.64", available = "8.0.64") => JSON.stringify({ formulae: [{ name: "cliproxyapi", linked_keg: installed, versions: { stable: available }, revision: 0 }] });
function fixture(change: (args: string[], n: number) => string | undefined = () => undefined) {
  let n = 0; const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args); if (args[0] === "nettop") n++;
    const override = change(args, n); if (override !== undefined) return override;
    if (args[0] === "brew") return info();
    if (args[0] === "launchctl") return "PID\tStatus\tLabel\n90\t0\tcom.tokenlayer.drain\n";
    if (args[0] === "ps") return "/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi\n";
    if (args[0] === "nettop") return sample();
    return args.includes("-sTCP:LISTEN") ? "p42\nf13\n" : "p42\nf30\nn127.0.0.1:8317->127.0.0.1:65055\np91\nf3\nn127.0.0.1:65055->127.0.0.1:8317\n";
  };
  return { run, calls };
}
test("parses actual tcp4/tcp6 shapes, listener and upstream rows", async () => {
  const { parseNettop } = await core();
  expect(parseNettop(sample("tcp6 ::1.8317<->::1.65055,218,2112480,\n"))).toHaveLength(1);
  expect(parseNettop(sample(connection + "tcp6 ::1.65062<->2001:db8::1.443,218,2112480,\n"))).toHaveLength(1);
  expect(parseNettop(sample(""))).toEqual([]);
  for (const text of ["", sample("nonsense\n"), sample(connection.replace("2109840", "")), sample(connection.replace("5051", "NaN"))]) expect(() => parseNettop(text)).toThrow();
});
test("idle with unchanged counters, busy with counter change or new/disappearing clients", async () => {
  const { idle, parseNettop } = await core();
  const a = parseNettop(sample()).map(c => ({ ...c, ignored: false }));
  expect(idle([a, a, a])).toMatchObject({ verdict: "idle", seen: 1, ignored: 0, changed: 0 });
  expect(idle([a, a, [{ ...a[0], rx: a[0].rx + 1 }]])).toMatchObject({ verdict: "busy", changed: 1 });
  expect(idle([[], a, a])).toMatchObject({ verdict: "busy", changed: 1 });
  expect(idle([a, [], a])).toMatchObject({ verdict: "busy", changed: 1 });
});
test("ignores only known launchd sidecars; verifies lsof attribution on each sample", async () => {
  const { observe } = await probe();
  const f = fixture(args => args[0] === "launchctl" ? "PID\tStatus\tLabel\n91\t0\tcom.tokenlayer.drain\n" : undefined);
  expect(await observe(f.run, async () => {}, 1, 3)).toMatchObject({ verdict: "idle", seen: 1, ignored: 1, changed: 0 });
  expect(f.calls.filter(a => a[0] === "nettop")).toHaveLength(3);
  const unknownLabel = fixture(args => args[0] === "launchctl" ? "PID\tStatus\tLabel\n91\t0\tcom.tokenlayer.unrelated\n" : undefined);
  expect(await observe(unknownLabel.run, async () => {}, 1, 3)).toMatchObject({ ignored: 0 });
});
for (const failure of ["brew", "nettop", "lsof", "launchctl", "ps", "parse", "pid", "restart", "process", "labels", "empty_lsof"]) test(`unknown on ${failure} failure`, async () => {
  const { check } = await probe();
  const f = fixture((a, n) => {
    if (a[0] === failure) throw Error("PRIVATE_FAILURE_MUST_NOT_LEAK");
    if (failure === "parse" && a[0] === "nettop") return sample("garbage\n");
    if (failure === "pid" && a.includes("-sTCP:LISTEN")) return "";
    if (failure === "restart" && n > 0 && a.includes("-sTCP:LISTEN")) return "p43\n";
    if (failure === "empty_lsof" && a.includes("-sTCP:ESTABLISHED")) return "";
    if (failure === "process" && a[0] === "ps") return "other_process\n";
    if (failure === "labels" && a[0] === "launchctl") return "garbage\n";
  });
  const out = await check(f.run, async () => {}, 1, 3, false);
  expect(out.decision).toBe("busy_unknown"); expect(JSON.stringify(out)).not.toContain("PRIVATE");
});
test("version decisions and idle sampling even when already current", async () => {
  const { check } = await probe(), { versions } = await core();
  expect(() => versions("{}")).toThrow(); expect(() => versions(info("bad"))).toThrow();
  for (const [installed, available, decision] of [["8.0.64", "8.0.64", "up_to_date"], ["8.0.9", "8.0.64", "would_upgrade"], ["8.0.65", "8.0.64", "up_to_date"]]) {
    const f = fixture(a => a[0] === "brew" ? info(installed, available) : undefined);
    expect((await check(f.run, async () => {}, 1, 3, false)).decision).toBe(decision);
    expect(f.calls.filter(a => a[0] === "nettop")).toHaveLength(3);
    expect(f.calls.some(a => a.join(" ") === "brew update")).toBe(false);
  }
  const f = fixture((a, n) => a[0] === "brew" ? info("8.0.63") : a[0] === "nettop" ? sample(connection.replace("5051", String(5051 + n))) : undefined);
  expect((await check(f.run, async () => {}, 1, 3, true)).decision).toBe("busy");
  expect(f.calls[0]).toEqual(["brew", "update"]);
});
test("spawned CLI uses fake commands, writes private state and emits one identity-free JSON line", async () => {
  const dir = mkdtempSync(tmpdir() + "/hubcheck-");
  const outputs: Record<string, string> = { brew: info(), launchctl: "PID\tStatus\tLabel\n", ps: "/opt/homebrew/bin/cliproxyapi", nettop: sample() };
  try {
    for (const [name, value] of Object.entries(outputs)) writeFileSync(`${dir}/${name}`, `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o700 });
    writeFileSync(dir + "/lsof", "#!/bin/sh\ncase \"$*\" in *LISTEN*) printf 'p42\\n';; *) printf 'p91\\nf3\\nn127.0.0.1:65055->127.0.0.1:8317\\n';; esac\n", { mode: 0o700 });
    writeFileSync(dir + "/state.json", "old", { mode: 0o644 });
    const child = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", "check", "--idle-window", "0.01", "--samples", "3"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOKENLAYER_HUBUPDATE_STATE: dir + "/state.json" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(err).toBe(""); expect(out.trim().split("\n")).toHaveLength(1);
    const result = JSON.parse(out); expect(result).toMatchObject({ installed: "8.0.64", available: "8.0.64", decision: "up_to_date", idle: { verdict: "idle", seen: 1 } });
    expect(out).not.toMatch(/127\.0\.0\.1|65055|cliproxyapi\.42/); expect(result.blindSpots).toHaveLength(3);
    expect(JSON.parse(readFileSync(dir + "/state.json", "utf8"))).toEqual(result);
    expect(statSync(dir + "/state.json").mode & 0o777).toBe(0o600);
    for (const flags of [["--samples", "2"], ["--idle-window", "0"], ["run"]]) {
      const bad = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", "check", ...flags], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOKENLAYER_HUBUPDATE_STATE: dir + "/state.json" }, stdout: "pipe", stderr: "pipe" });
      expect(await bad.exited).toBe(2); expect(JSON.parse(await new Response(bad.stdout).text()).decision).toBe("busy_unknown"); expect(await new Response(bad.stderr).text()).toBe("");
    }
    expect(JSON.parse(readFileSync(dir + "/state.json", "utf8"))).toEqual(result);
    const denied = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", "check", "--idle-window", "0.01"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOKENLAYER_HUBUPDATE_STATE: dir + "/nettop/state.json" }, stdout: "pipe", stderr: "pipe" });
    expect(await denied.exited).toBe(1); expect(JSON.parse(await new Response(denied.stdout).text()).reason).toBe("state_write_failed"); expect(await new Response(denied.stderr).text()).toBe("");
  } finally { rmSync(dir, { recursive: true }); }
});
test("parser rejects wrong-PID snapshots and ambiguous owners; unchanged normal traffic stays quiet", async () => {
  const { parseNettop, owners, idle } = await core();
  expect(() => parseNettop(sample(), 43)).toThrow();
  expect(() => owners("p91\nn127.0.0.1:65055->127.0.0.1:8317\np92\nn127.0.0.1:65055->127.0.0.1:8317", 42)).toThrow();
  const a = { ...parseNettop(sample())[0], ignored: false, owner: 91 };
  expect(idle([[a], [a], [{ ...a, owner: 92 }]])).toMatchObject({ verdict: "idle", seen: 1, changed: 0 });
});
test("sidecar traffic can change; client IPv6 peers match lsof bracket notation", async () => {
  const { observe } = await probe();
  const f = fixture((a, n) => a[0] === "launchctl" ? "PID\tStatus\tLabel\n91\t0\tcom.tokenlayer.drain\n" : a[0] === "nettop" ? sample(connection.replace("5051", String(n))) : undefined);
  expect(await observe(f.run, async () => {}, 1, 3)).toMatchObject({ verdict: "idle", seen: 1, ignored: 1, changed: 0 });
  const v6 = fixture(a => a[0] === "nettop" ? sample("tcp6 ::1.8317<->::1.65055,218,2112480,\n") : a.includes("-sTCP:ESTABLISHED") ? "p91\nn[::1]:65055->[::1]:8317\n" : undefined);
  expect(await observe(v6.run, async () => {}, 1, 3)).toMatchObject({ verdict: "idle", seen: 1, ignored: 0 });
});
test("unreadable formula metadata remains unknown while sampling continues", async () => {
  const { check } = await probe(); const f = fixture(a => a[0] === "brew" ? "{}" : undefined);
  expect(await check(f.run, async () => {}, 1, 3, false)).toMatchObject({ decision: "busy_unknown", reason: "version_unreadable", installed: null, available: null, idle: { verdict: "idle" } });
  expect(f.calls.filter(a => a[0] === "nettop")).toHaveLength(3);
});
test("unattributed changed clients are busy while all samples and known sidecar counts survive", async () => {
  const { observe } = await probe();
  const f = fixture((a, n) => a[0] === "nettop" ? sample(connection.replace("5051", String(n)) + connection.replace("65055", "65056")) : a.includes("-sTCP:ESTABLISHED") ? "p90\nn127.0.0.1:65056->127.0.0.1:8317\n" : undefined);
  expect(await observe(f.run, async () => {}, 1, 3)).toMatchObject({ verdict: "busy", reason: "client_activity", seen: 2, ignored: 1, changed: 1, unattributed: 1 });
  expect(f.calls.filter(a => a[0] === "nettop")).toHaveLength(3);
});
test("unattributed unchanged clients are idle and never ignored", async () => {
  const { observe } = await probe();
  const f = fixture(a => a.includes("-sTCP:ESTABLISHED") ? "p42\nn127.0.0.1:8317->127.0.0.1:65055\n" : undefined);
  expect(await observe(f.run, async () => {}, 1, 3)).toMatchObject({ verdict: "idle", seen: 1, ignored: 0, changed: 0, unattributed: 1 });
  expect(f.calls.filter(a => a[0] === "nettop")).toHaveLength(3);
});
test("lsof command failure still overrides changing client counters with unknown", async () => {
  const { observe } = await probe();
  const f = fixture((a, n) => {
    if (a.includes("-sTCP:ESTABLISHED")) throw Error("PRIVATE lsof failure");
    if (a[0] === "nettop") return sample(connection.replace("5051", String(n)));
  });
  expect(await observe(f.run, async () => {}, 1, 3)).toMatchObject({ verdict: "busy_unknown", reason: "command_failure" });
});
