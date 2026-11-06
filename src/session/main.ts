#!/usr/bin/env bun
import { ClickHouse } from "../lib/clickhouse";
import { expandHome, loadEnvFiles } from "../lib/env";
import { writeErr, writeOut, writeVerifiedRestoreReceipt } from "../lib/egress";
import { RestoreError, restoreSession, type Selection } from "./restore";

const usage = "tokenlayer session restore <session_id> [--to <dir>] [--machine <name>] [--path <source-path>] [--generation <id>]";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { writeOut(usage); process.exit(0); }
  if (args.shift() !== "session" || args.shift() !== "restore" || !args[0] || args[0].startsWith("--")) throw new RestoreError(usage);
  const id = args.shift()!;
  const options: Selection & { to?: string } = {};
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (!["--to", "--machine", "--path", "--generation"].includes(flag) || !value || value.startsWith("--")) throw new RestoreError(usage);
    const key = flag.slice(2) as keyof typeof options;
    if (options[key] !== undefined) throw new RestoreError("duplicate option");
    options[key] = key === "to" ? expandHome(value) : value;
  }
  const env = loadEnvFiles((process.env.TOKENLAYER_ENV_FILES ?? "~/.config/tokenlayer/clickhouse.env").split(":"));
  const receipt = await restoreSession(ClickHouse.fromEnv(env), id, options);
  writeVerifiedRestoreReceipt(receipt);
} catch (error) {
  writeErr(`tokenlayer: ${error instanceof RestoreError ? error.message : "restore failed; payload and server diagnostics suppressed"}`);
  process.exitCode = 1;
}
