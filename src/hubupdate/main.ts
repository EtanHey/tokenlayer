import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadEnvFiles } from "../lib/env";
import { writeOut } from "../lib/egress";
import { http } from "./gate";
import { check, runner } from "./probe";
import { clear, run } from "./run";
import { versionPattern } from "./core";
import { loadTarget } from "./target";
const args = process.argv.slice(2), sub = args.shift();
const USAGE = "usage: hubupdate run [--target target.json] | hubupdate clear (--failed <version> | --halt) [--target target.json]";
// Decisions a person should look at exit 1, so launchd's "last exit code" shows them.
const LOUD = ["rollback_failed", "halted", "rollback_pending", "command_still_running", "locked"];
if (sub === "run" || sub === "clear") {
  let targetPath: string | undefined, failed: string | undefined, halt = false;
  try {
    while (args.length) {
      const arg = args.shift();
      if (arg === "--target" && args.length) targetPath = args.shift();
      else if (sub === "clear" && arg === "--failed" && args.length) failed = args.shift();
      else if (sub === "clear" && arg === "--halt") halt = true;
      else throw Error();
    }
    if (sub === "clear" && (Number(!!failed) + Number(halt) !== 1 || (failed !== undefined && !versionPattern.test(failed)))) throw Error();
  } catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: USAGE })); process.exit(2); }
  let target; try { target = loadTarget(targetPath); } catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "target_invalid" })); process.exit(2); }
  const env = loadEnvFiles([target.envFile]);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; } };
  const deps = { run: runner, http, sleep: Bun.sleep, now: Date.now, uid: process.getuid!(), pid: process.pid, alive, env, log: writeOut };
  const result = sub === "run" ? await run(deps, target) : await clear(deps, target, { failed, halt });
  writeOut(JSON.stringify(result));
  process.exitCode = LOUD.includes(result.decision) ? 1 : 0;
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
} catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "usage: hubupdate check [--idle-window seconds] [--samples count>=3] [--refresh] | hubupdate run [--target target.json] | hubupdate clear (--failed <version> | --halt)" })); process.exit(2); }
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
