import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeOut } from "../lib/egress";
import { check, runner } from "./probe";
const args = process.argv.slice(2); let window = 300, count = 3, refresh = false;
try {
  if (args.shift() !== "check") throw Error();
  while (args.length) {
    const arg = args.shift();
    if (arg === "--refresh") refresh = true;
    else if (arg === "--idle-window") window = Number(args.shift());
    else if (arg === "--samples") count = Number(args.shift());
    else throw Error();
  }
  if (!Number.isFinite(window) || window <= 0 || !Number.isInteger(count) || count < 3) throw Error();
} catch { writeOut(JSON.stringify({ decision: "busy_unknown", reason: "usage: hubupdate check [--idle-window seconds] [--samples count>=3] [--refresh]" })); process.exit(2); }
const result = await check(runner, Bun.sleep, window, count, refresh);
const path = process.env.TOKENLAYER_HUBUPDATE_STATE ?? join(homedir(), ".config/tokenlayer/hubupdate.json");
const temp = path + "." + crypto.randomUUID();
try {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, path);
} catch { result.decision = "busy_unknown"; result.reason = "state_write_failed"; process.exitCode = 1; }
finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the fixed error receipt. */ } }
writeOut(JSON.stringify(result));
