#!/usr/bin/env bun
import { redactText } from "../lib/redact";
// tokenlayer-ship: tail Claude Code / Codex / T3 session JSONL into ClickHouse session_events.
// Usage:
//   bun src/ship/main.ts                         # daemon: every TOKENLAYER_SHIP_INTERVAL_MS (default 10s)
//   bun src/ship/main.ts --backfill [--since 2026-10-01] [--rate-mb 5]   # one pass over everything, then exit
// Env (or files in TOKENLAYER_ENV_FILES, default ~/.config/tokenlayer/{ship,clickhouse}.env):
//   TOKENLAYER_MACHINE (required: m4 | m1), CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB,
//   TOKENLAYER_CLAUDE_DIR (default ~/.claude/projects), TOKENLAYER_CODEX_DIR (default ~/.codex/sessions),
//   TOKENLAYER_SHIP_STATE (default ~/.config/tokenlayer/ship-state.json), TOKENLAYER_SHIP_RATE_MB (default 5).
// The daemon only picks up files without a checkpoint if they changed in the last day; run --backfill once for history.
import { loadState } from "./state";
import { verifySessionSchema } from "../lib/session-schema";
import { ClickHouse } from "../lib/clickhouse";
import { expandHome, loadEnvFiles } from "../lib/env";
import { shipOnce, type ShipOptions } from "./ship";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = loadEnvFiles(
  (process.env.TOKENLAYER_ENV_FILES ?? "~/.config/tokenlayer/ship.env:~/.config/tokenlayer/clickhouse.env").split(":"),
);
const machine = env.TOKENLAYER_MACHINE;
if (!machine) {
  console.error("tokenlayer-ship: TOKENLAYER_MACHINE is not set (m4 | m1)");
  process.exit(2);
}

const backfill = args.includes("--backfill");
const since = flag("--since");
const sinceMs = since ? Date.parse(since) : backfill ? undefined : Date.now() - 24 * 3600 * 1000;
if (since && Number.isNaN(sinceMs)) {
  console.error(`tokenlayer-ship: bad --since ${redactText(String(since))}`);
  process.exit(2);
}
const rateMb = Number(flag("--rate-mb") ?? env.TOKENLAYER_SHIP_RATE_MB ?? 5);

const opts: ShipOptions = {
  machine,
  roots: [
    { kind: "claude", dir: expandHome(env.TOKENLAYER_CLAUDE_DIR ?? "~/.claude/projects") },
    { kind: "codex", dir: expandHome(env.TOKENLAYER_CODEX_DIR ?? "~/.codex/sessions") },
  ],
  clickhouse: ClickHouse.fromEnv(env),
  statePath: expandHome(env.TOKENLAYER_SHIP_STATE ?? "~/.config/tokenlayer/ship-state.json"),
  sinceMs,
  rateBytesPerSec: Math.round(rateMb * 1024 * 1024),
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
};
const intervalMs = Number(env.TOKENLAYER_SHIP_INTERVAL_MS ?? 10_000);

loadState(opts.statePath);
await verifySessionSchema(opts.clickhouse);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

do {
  const started = Date.now();
  try {
    const r = await shipOnce(opts);
    if (r.lines || r.resets) {
      console.log(`${new Date().toISOString()} files=${r.files} lines=${r.lines} bytes=${r.bytes} resets=${r.resets}`);
    }
  } catch (err) {
    console.error(`${new Date().toISOString()} tokenlayer-ship: ${redactText((err as Error).message)}`);
    if (backfill) process.exit(1);
  }
  if (backfill) break;
  const wait = Math.max(0, intervalMs - (Date.now() - started));
  for (let waited = 0; waited < wait && !stopping; waited += 250) await Bun.sleep(Math.min(250, wait - waited));
} while (!stopping);
