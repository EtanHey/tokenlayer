import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadEnvFiles } from "../lib/env";
import { writeOut } from "../lib/egress";
import { http } from "./gate";
import { check, runner } from "./probe";
import { run } from "./run";
import { loadTarget } from "./target";
const args = process.argv.slice(2), sub = args.shift();
if (sub === "run") {
  let targetPath: string | undefined;
  try {
    while (args.length) { const arg = args.shift(); if (arg === "--target" && args.length) targetPath = args.shift(); else throw Error(); }
  } catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "usage: hubupdate run [--target target.json]" })); process.exit(2); }
  let target; try { target = loadTarget(targetPath); } catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "target_invalid" })); process.exit(2); }
  const env = loadEnvFiles([target.envFile]);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; } };
  const result = await run({ run: runner, http, sleep: Bun.sleep, now: Date.now, uid: process.getuid!(), pid: process.pid, alive, env, log: writeOut }, target);
  writeOut(JSON.stringify(result));
  process.exitCode = ["rollback_failed", "halted"].includes(result.decision) ? 1 : 0;
} else await checkMain();
async function checkMain() {
let window = 300, count = 3, refresh = false;
try {
  if (sub !== "check") throw Error();
  while (args.length) {
    const arg = args.shift();
    if (arg === "--refresh") refresh = true;
    else if (arg === "--idle-window") window = Number(args.shift());
    else if (arg === "--samples") count = Number(args.shift());
    else throw Error();
  }
  if (!Number.isFinite(window) || window <= 0 || !Number.isInteger(count) || count < 3) throw Error();
} catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "usage: hubupdate check [--idle-window seconds] [--samples count>=3] [--refresh] | hubupdate run [--target target.json]" })); process.exit(2); }
const result = await check(runner, Bun.sleep, window, count, refresh);
const path = process.env.TOKENLAYER_HUBUPDATE_STATE ?? join(homedir(), ".config/tokenlayer/hubupdate.json");
const temp = path + "." + crypto.randomUUID();
try {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, path);
} catch { result.decision = "busy_unknown"; result.reason = "state_write_failed"; process.exitCode = 1; }
finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the fixed error receipt. */ } }
writeOut(JSON.stringify(result));
}
