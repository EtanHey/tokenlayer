import { status } from "./status";
import { resetPressed, type ResetState } from "./reset";
import { shipBestEffort } from "./events";
import { ClickHouse } from "../lib/clickhouse";
import { event } from "./io";
import { writeOut, writeErr } from "../lib/egress";
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFiles } from "../lib/env";
import { defaults, plan, intent } from "./core";
import { restoreOff, offReadback } from "./off";
import { migrate, adopt } from "./baseline";
import { Hub, statePath, save, locked, execute, observe } from "./io";
const args = process.argv.slice(2),
  command = args.shift();
const resetAction = ["resets", "baseline"].includes(command ?? "")
  ? args.shift()
  : undefined;
const flags = new Map<string, string>();
while (args.length) {
  const k = args.shift()!;
  if (
    ![
      "--json",
      "--credential",
      "--allow-non-fable-on-fable-account",
      "--protect-fable-reserve",
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
      "--auto-spillover",
      "--weekly-exhausted-at",
      "--fable-cap-at",
    ].includes(k)
  )
    throw Error("unknown option");
  flags.set(
    k,
    k.startsWith("--no-") ||
      [
        "--json",
        "--allow-non-fable-on-fable-account",
        "--protect-fable-reserve",
        "--strict",
        "--spillover",
        "--auto-spillover",
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
    let s: ResetState = existsSync(statePath())
      ? JSON.parse(readFileSync(statePath(), "utf8"))
      : defaults();
    if (
      flags.has("--allow-non-fable-on-fable-account") &&
      flags.has("--protect-fable-reserve")
    )
      throw Error("conflicting reserve options");
    if (command === "run" && s.requested?.mode === "off") s.mode = "off";
    if (command === "off" || (command === "run" && s.mode === "off")) {
      try {
        let confirmed = false;
        if (command === "run" && s.applied === "OFF" && !s.pending) {
          try {
            await offReadback(s, hub);
            confirmed = true;
          } catch {
            /* Restore on drift. */
          }
        }
        if (!confirmed)
          await restoreOff(s, hub, s.pending?.op ?? crypto.randomUUID());
      } catch (error) {
        if (
          command === "off" &&
          error instanceof Error &&
          error.message === "hub transport failure"
        ) {
          writeErr(
            "OFF requested and saved; it will apply as soon as the hub is reachable",
          );
          process.exitCode = 3;
          return;
        }
        throw error;
      }
      await shipBestEffort(ClickHouse.fromEnv(env), writeErr);
      writeOut(
        JSON.stringify({
          requested: s.requested,
          applied: s.applied,
          reason: s.reason,
        }),
      );
      return;
    }
    if (command === "baseline") {
      if (resetAction !== "adopt" || !flags.get("--credential"))
        throw Error("baseline adopt requires credential");
      await adopt(s, hub, flags.get("--credential")!);
      save(s);
      return;
    }
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
      s = await status(s, hub);
      const desired = (p: typeof s.policy) =>
        p && {
          ...p,
          desired: Object.entries(p.desired).map(([id, fields], index) => ({
            account: index,
            email: s.baseline[id]?.email,
            ...fields,
          })),
        };
      writeOut(
        JSON.stringify({
          requested: s.requested,
          applied: s.applied,
          reason: s.reason,
          policy: desired(s.policy),
          pending: s.pending && {
            op: s.pending.op,
            plan: { ...s.pending.plan, ...desired(s.pending.plan) },
          },
        }),
      );
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
    if (command === "set" && !flags.get("--account") && !s.fableAccount)
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
    if (flags.has("--auto-spillover")) s.spillover = "auto";
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
    if (flags.has("--allow-non-fable-on-fable-account"))
      s.allowNonFableOnFableAccount = true;
    if (flags.has("--protect-fable-reserve"))
      s.allowNonFableOnFableAccount = false;
    s.requested = intent(s);
    s = await migrate(s, hub);
    const obs = await observe(s, hub);
    if (
      command === "set" &&
      !obs.some((c) => c.email === s.fableAccount || c.id === s.fableAccount)
    )
      throw Error("account not found");
    const p = plan(s, obs);
    if (command === "plan") {
      writeOut(JSON.stringify(p));
      return;
    }
    if (JSON.stringify(s) !== before) {
      s.applied = "APPLYING";
      save(s);
    }
    await execute(
      s,
      p,
      hub,
      command === "off"
        ? crypto.randomUUID()
        : (s.pending?.op ?? crypto.randomUUID()),
    );
    await shipBestEffort(ClickHouse.fromEnv(env), writeErr);
    writeOut(
      JSON.stringify({
        requested: s.requested,
        applied: s.applied,
        reason: s.reason,
      }),
    );
  });
}
const safeReasons = [
  "hub transport failure",
  "OFF readback unconfirmed",
  "conflicting reserve options",
  "third credential adoption refused",
  "controller busy",
  "account not found",
  "thresholds are plan-only",
  "credential inventory changed",
  "credential inventory changed; adopt baseline",
  "catalog unreadable or empty",
  "catalog unreadable or changed; adopt baseline",
  "baseline catalog changed; adopt baseline",
  "baseline adoption unconfirmed",
  "write unconfirmed; catalog or priority mismatch",
  "policy changed; expansion required",
  "policy changed; retry required",
  "last usable route; restriction refused",
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
