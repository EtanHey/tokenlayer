#!/usr/bin/env bun
// tokenlayer-steer: every 60s, put the Claude Max credential whose quota resets soonest alone at priority 100.
// Usage: bun src/steer/main.ts [--once] [--dry-run] [--snapshots]
//   --dry-run    GET only; log the PATCHes it would make.
//   --snapshots  print one credentials_snap JSON row per credential per tick to stdout (logs go to stderr).
// Env (or the file at TOKENLAYER_ENV, default ~/.config/tokenlayer/hub.env; the process env wins):
//   CLIPROXY_MGMT_KEY, TOKENLAYER_HUB_URL (default http://127.0.0.1:8317), TOKENLAYER_HUB (default m1),
//   TOKENLAYER_STEER_INTERVAL_MS (default 60000)
import { HubClient } from "./client";
import { loadEnv } from "./env";
import { tick } from "./steer";

const env = loadEnv(process.env.TOKENLAYER_ENV ?? "~/.config/tokenlayer/hub.env");
const mgmtKey = env.CLIPROXY_MGMT_KEY;
if (!mgmtKey) {
  console.error("tokenlayer-steer: CLIPROXY_MGMT_KEY is not set");
  process.exit(2);
}

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const hubUrl = env.TOKENLAYER_HUB_URL ?? "http://127.0.0.1:8317";
const configuredMs = Number(env.TOKENLAYER_STEER_INTERVAL_MS);
// A typo must not turn the loop into a tight poll of the hub.
const intervalMs = Number.isFinite(configuredMs) && configuredMs >= 1_000 ? configuredMs : 60_000;
const client = new HubClient(hubUrl, mgmtKey);
const opts = {
  dryRun,
  hub: env.TOKENLAYER_HUB ?? "m1",
  onSnapshot: args.has("--snapshots") ? (rows: object[]) => rows.forEach((r) => console.log(JSON.stringify(r))) : undefined,
};

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

let lastError = "";
let exitCode = 0;
do {
  const started = Date.now();
  try {
    const r = await tick(client, opts);
    if (lastError) console.error(`${new Date().toISOString()} tokenlayer-steer: recovered`);
    lastError = "";
    if (once) console.error(`${new Date().toISOString()} tokenlayer-steer: credentials=${r.credentials} changes=${r.changes} errors=${r.errors}${dryRun ? " (dry-run)" : ""}`);
    exitCode = r.errors ? 1 : 0;
  } catch (err) {
    const message = (err as Error).message;
    // Log a failing hub once, not every minute.
    if (message !== lastError) console.error(`${new Date().toISOString()} tokenlayer-steer: ${message}`);
    lastError = message;
    exitCode = 1;
  }
  if (once) break;
  const wait = Math.max(0, intervalMs - (Date.now() - started));
  for (let waited = 0; waited < wait && !stopping; waited += 250) await Bun.sleep(Math.min(250, wait - waited));
} while (!stopping);
process.exit(exitCode);
