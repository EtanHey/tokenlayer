#!/usr/bin/env bun
import { installErrorHandlers, writeErr, writeOut } from "../lib/egress";
installErrorHandlers();
// tokenlayer-jev: one pass over the Jev usage.jsonl ledgers on this Mac into ClickHouse systemone_calls.
// launchd runs it every 60 s (launchd/com.tokenlayer.jev.plist.template).
// Usage: bun src/jev/main.ts [--dry-run]
// Env (or files in TOKENLAYER_ENV_FILES, default ~/.config/tokenlayer/{ship,clickhouse,jev}.env):
//   TOKENLAYER_MACHINE (required: m4 | m1), CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB,
//   TOKENLAYER_JEV_ROOTS (colon-separated; default below), TOKENLAYER_JEV_MAX_DEPTH (default 4),
//   TOKENLAYER_JEV_STATE (default ~/.config/tokenlayer/jev-state.json).
import { ClickHouse, fixed } from "../lib/clickhouse";
import { expandHome, loadEnvFiles } from "../lib/env";
import { drainOnce } from "./drain";

// jev.py's default state folder, plus where Jev POCs keep theirs. Private research folders go in jev.env.
const DEFAULT_ROOTS = "~/.local/state/jev:~/.t3/scratch:~/Gits/golems/docs.local";

const env = loadEnvFiles(
  (process.env.TOKENLAYER_ENV_FILES ?? "~/.config/tokenlayer/ship.env:~/.config/tokenlayer/clickhouse.env:~/.config/tokenlayer/jev.env").split(":"),
);
const machine = env.TOKENLAYER_MACHINE;
if (!machine) {
  writeErr("tokenlayer-jev: TOKENLAYER_MACHINE is not set (m4 | m1)");
  process.exit(2);
}
try {
  const r = await drainOnce({
    machine,
    roots: (env.TOKENLAYER_JEV_ROOTS ?? DEFAULT_ROOTS).split(":").filter(Boolean).map(expandHome),
    maxDepth: Number(env.TOKENLAYER_JEV_MAX_DEPTH ?? 4),
    statePath: expandHome(env.TOKENLAYER_JEV_STATE ?? "~/.config/tokenlayer/jev-state.json"),
    clickhouse: fixed(ClickHouse.fromEnv(env)),
    dryRun: process.argv.includes("--dry-run"),
  });
  if (r.inserted || r.invalid || process.argv.includes("--dry-run")) writeOut(`${new Date().toISOString()} ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" ")}`);
} catch (err) {
  writeErr(`${new Date().toISOString()} tokenlayer-jev: ${(err as Error).message}`);
  process.exit(1);
}
