import { resetPressed, type ResetState } from "./reset";
import { shipBestEffort } from "./events";
import { ClickHouse } from "../lib/clickhouse";
import { event } from "./io";
import { writeOut, writeErr } from "../lib/egress";
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFiles } from "../lib/env";
import { defaults, plan, type State, type Observation } from "./core";
import { Hub, statePath, save, locked, execute } from "./io";
const args = process.argv.slice(2),
  command = args.shift();
const resetAction = command === "resets" ? args.shift() : undefined;
const flags = new Map<string, string>();
while (args.length) {
  const k = args.shift()!;
  if (
    ![
      "--op-id",
      "--unconfirmed",
      "--skip-count",
      "--left",
      "--confirmed",
      "--account",
      "--strict",
      "--no-strict",
      "--spillover",
      "--no-spillover",
      "--weekly-exhausted-at",
      "--fable-cap-at",
    ].includes(k)
  )
    throw Error("unknown option");
  flags.set(
    k,
    k.startsWith("--no-") ||
      [
        "--strict",
        "--spillover",
        "--unconfirmed",
        "--confirmed",
        "--skip-count",
      ].includes(k)
      ? "true"
      : (args.shift() ?? ""),
  );
}
const env = loadEnvFiles(
  (
    process.env.TOKENLAYER_ENV_FILES ??
    "~/.config/tokenlayer/hub.env:~/.config/tokenlayer/clickhouse.env"
  ).split(":"),
);
const hub = new Hub(
  env.TOKENLAYER_HUB_URL ?? "http://127.0.0.1:8317",
  env.CLIPROXY_MGMT_KEY ?? "",
);
async function tick() {
  return locked(async () => {
    const s: ResetState = existsSync(statePath())
      ? JSON.parse(readFileSync(statePath(), "utf8"))
      : defaults();
    if (command === "resets") {
      const account = flags.get("--account"),
        left = Number(flags.get("--left"));
      if (
        resetAction !== "set" ||
        !account ||
        !flags.has("--left") ||
        !Number.isInteger(left) ||
        left < 0 ||
        !flags.has("--confirmed")
      )
        throw Error(
          "resets set requires account, nonnegative left and confirmed",
        );
      if (!(await hub.observations()).some((c) => c.email === account))
        throw Error("account not found");
      s.resets ??= {};
      s.resets[account] = { left, confirmedByEtan: true };
      save(s);
      return;
    }
    if (command === "reset-pressed") {
      const account = flags.get("--account"),
        op = flags.get("--op-id");
      if (!account || !op)
        throw Error("reset-pressed requires account and op-id");
      const c = (await hub.observations()).find((c) => c.email === account);
      if (!c?.auth_index) throw Error("account not found");
      await resetPressed(
        s,
        account,
        c.auth_index,
        op,
        !flags.has("--unconfirmed"),
        hub,
        () => save(s),
        event,
        flags.has("--skip-count"),
      );
      await shipBestEffort(ClickHouse.fromEnv(env), writeErr);
      writeOut(JSON.stringify(s.resetOps![op]));
      return;
    }
    if (command === "status") {
      writeOut(JSON.stringify(s));
      return;
    }
    if (!["off", "set", "plan", "run"].includes(command ?? ""))
      throw Error("fable status|off|set --account <email>|plan|run");
    const before = JSON.stringify(s);
    if (
      command !== "plan" &&
      (flags.has("--weekly-exhausted-at") || flags.has("--fable-cap-at"))
    )
      throw Error("thresholds are plan-only");
    if (command === "plan" && flags.has("--account")) s.mode = "manual";
    if (command === "set" && !flags.get("--account"))
      throw Error("--account required");
    if (command === "off") s.mode = "off";
    if (command === "set") s.mode = "manual";
    if (flags.has("--account")) s.fableAccount = flags.get("--account")!;
    for (const [key, flag] of [
      ["strictFableAccount", "strict"],
      ["spillover", "spillover"],
    ] as const) {
      if (flags.has("--" + flag)) s[key] = true;
      if (flags.has("--no-" + flag)) s[key] = false;
    }
    for (const [key, flag] of [
      ["weeklyExhaustedAt", "--weekly-exhausted-at"],
      ["fableCapAt", "--fable-cap-at"],
    ] as const) {
      if (flags.has(flag)) {
        const n = Number(flags.get(flag));
        if (!Number.isFinite(n) || n <= 0 || n > 2)
          throw Error("threshold must be >0 and <=2 (dry-run only)");
        s.thresholds[key] = n;
      }
    }
    let obs: Observation[];
    try {
      obs = await hub.observations();
    } catch {
      obs = [];
    }
    if (command === "set" && !obs.some((c) => c.email === s.fableAccount))
      throw Error("account not found");
    if (!Object.keys(s.baseline).length) {
      if (obs.length !== 2)
        throw Error("two credentials required to capture baseline");
      for (const c of obs) s.baseline[c.id] = hub.metadata(c.id);
      if (command !== "plan") save(s);
    }
    const p = plan(s, obs);
    if (command === "plan") {
      writeOut(JSON.stringify(p));
      return;
    }
    if (JSON.stringify(s) !== before) save(s);
    await execute(s, p.desired, hub, crypto.randomUUID());
    await shipBestEffort(ClickHouse.fromEnv(env), writeErr);
    writeOut(JSON.stringify({ mode: s.mode, reason: p.reason }));
  });
}
const safeReasons = [
  "hub transport failure",
  "controller busy",
  "legacy exclusions require audit",
  "account not found",
  "thresholds are plan-only",
  "write unconfirmed; no further restriction",
  "catalog exclusion unconfirmed",
  "two credentials required to capture baseline",
];
function report(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  writeErr(
    "fable: " +
      (safeReasons.includes(message) || /^hub HTTP [0-9]{3}$/.test(message)
        ? message
        : "invalid state or operation; inspect controller state"),
  );
}
do {
  try {
    await tick();
  } catch (error) {
    report(error);
    if (command !== "run") process.exitCode = 1;
  }
  if (command === "run") await Bun.sleep(30000);
} while (command === "run");
