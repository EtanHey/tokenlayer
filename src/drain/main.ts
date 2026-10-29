#!/usr/bin/env bun
import { writeOut, writeErr, installErrorHandlers } from '../lib/egress';
installErrorHandlers();
// tokenlayer-drain: poll the CLIProxyAPI usage queue every 15s and insert into ClickHouse proxy_usage.
// Usage: bun src/drain/main.ts [--once]
// Env (or files listed in TOKENLAYER_ENV_FILES, default ~/.config/tokenlayer/{hub,clickhouse}.env):
//   CLIPROXY_MGMT_KEY, TOKENLAYER_HUB_URL (default http://127.0.0.1:8317), TOKENLAYER_HUB (default m1),
//   CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB,
//   TOKENLAYER_DRAIN_INTERVAL_MS (default 15000), TOKENLAYER_STATE_DIR (default ~/.local/state/tokenlayer/drain)
import { join } from "node:path";
import { ClickHouse } from "../lib/clickhouse";
import { expandHome, loadEnvFiles } from "../lib/env";
import { drainOnce } from "./drain";
import { Spool } from "./spool";

const env = loadEnvFiles(
  (process.env.TOKENLAYER_ENV_FILES ?? "~/.config/tokenlayer/hub.env:~/.config/tokenlayer/clickhouse.env").split(":"),
);
const mgmtKey = env.CLIPROXY_MGMT_KEY;
if (!mgmtKey) {
  writeErr("tokenlayer-drain: CLIPROXY_MGMT_KEY is not set");
  process.exit(2);
}

const opts = {
  hubUrl: env.TOKENLAYER_HUB_URL ?? "http://127.0.0.1:8317",
  mgmtKey,
  hub: env.TOKENLAYER_HUB ?? "m1",
  clickhouse: ClickHouse.fromEnv(env),
  spool: new Spool(expandHome(env.TOKENLAYER_STATE_DIR ?? join("~/.local/state/tokenlayer", "drain"))),
  onInsertError: (err: unknown) => writeErr(`tokenlayer-drain: insert failed, spooled: ${(err as Error).message}`),
};
const intervalMs = Number(env.TOKENLAYER_DRAIN_INTERVAL_MS ?? 15_000);
const once = process.argv.includes("--once");

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

do {
  const started = Date.now();
  try {
    const r = await drainOnce(opts);
    if (r.drained || r.inserted || r.spooled || r.rejected) {
      writeOut(`${new Date().toISOString()} drained=${r.drained} inserted=${r.inserted} spooled=${r.spooled} rejected=${r.rejected}`);
    }
  } catch (err) {
    writeErr(`${new Date().toISOString()} tokenlayer-drain: ${(err as Error).message}`);
  }
  if (once) break;
  const wait = Math.max(0, intervalMs - (Date.now() - started));
  for (let waited = 0; waited < wait && !stopping; waited += 250) await Bun.sleep(Math.min(250, wait - waited));
} while (!stopping);
