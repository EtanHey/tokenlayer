import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Everything hub-specific, so the same code runs against a throwaway stand-in. */
export type Target = {
  formula: string; label: string; port: number; processName: string;
  configPath: string; plistPath: string; hubUrl: string;
  envFile: string; mgmtKeyVar: string; accessKeyVar: string;
  probe: string[]; probeTimeoutMs: number;
  stateDir: string; enableFile: string;
  confirmMs: number; pollMs: number; waitMs: number; fallbackWindowS: number; fallbackSamples: number;
  recheckConfirmMs: number; recheckWaitMs: number; recheckFallbackWindowS: number; recheckFallbackSamples: number;
  restartWaitMs: number; upgradeTimeoutMs: number; minIntervalMs: number; orphanHaltMs: number;
};

export function hubTarget(home = homedir()): Target {
  return {
    formula: "cliproxyapi", label: "sh.brew.cliproxyapi", port: 8317, processName: "cliproxyapi",
    configPath: "/opt/homebrew/etc/cliproxyapi.conf", plistPath: join(home, "Library/LaunchAgents/sh.brew.cliproxyapi.plist"),
    hubUrl: "http://127.0.0.1:8317", envFile: join(home, ".config/tokenlayer/hub.env"), mgmtKeyVar: "CLIPROXY_MGMT_KEY", accessKeyVar: "CLIPROXY_ACCESS_KEY",
    // `--setting-sources ""` stops ~/.claude/settings.json env from redirecting the probe to another base URL.
    probe: ["claude", "--bare", "--setting-sources", "", "-p", "--model", "claude-haiku-5-5", "--output-format", "json", "--max-turns", "1", "Reply with the single word: ok"],
    probeTimeoutMs: 240_000,
    stateDir: join(home, ".config/tokenlayer/hubupdate-run"), enableFile: join(home, ".config/tokenlayer/hubupdate.enabled"),
    confirmMs: 20_000, pollMs: 2_000, waitMs: 240_000, fallbackWindowS: 30, fallbackSamples: 10,
    recheckConfirmMs: 4_000, recheckWaitMs: 60_000, recheckFallbackWindowS: 6, recheckFallbackSamples: 4,
    restartWaitMs: 60_000, upgradeTimeoutMs: 600_000, minIntervalMs: 86_400_000,
    // A command of a killed run still alive this long after it started (brew upgrade's own timeout is 10 min) needs a person.
    orphanHaltMs: 1_800_000,
  };
}

const name = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;
const checks: Record<keyof Target, (v: unknown) => boolean> = {
  formula: v => typeof v === "string" && name.test(v), label: v => typeof v === "string" && name.test(v),
  processName: v => typeof v === "string" && name.test(v), port: v => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536,
  configPath: v => typeof v === "string" && v.startsWith("/"), plistPath: v => typeof v === "string" && v.startsWith("/"),
  envFile: v => typeof v === "string" && v.startsWith("/"), stateDir: v => typeof v === "string" && v.startsWith("/"), enableFile: v => typeof v === "string" && v.startsWith("/"),
  hubUrl: v => typeof v === "string" && /^https?:\/\/[^/]+$/.test(v), mgmtKeyVar: v => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v), accessKeyVar: v => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v),
  probe: v => Array.isArray(v) && v.length > 0 && v.every(a => typeof a === "string"),
  probeTimeoutMs: positive, confirmMs: positive, pollMs: positive, waitMs: positive, fallbackWindowS: positive, fallbackSamples: v => Number.isInteger(v) && (v as number) >= 3,
  recheckConfirmMs: positive, recheckWaitMs: positive, recheckFallbackWindowS: positive, recheckFallbackSamples: v => Number.isInteger(v) && (v as number) >= 3,
  restartWaitMs: positive, upgradeTimeoutMs: positive, minIntervalMs: positive, orphanHaltMs: positive,
};
function positive(v: unknown) { return typeof v === "number" && Number.isFinite(v) && v > 0; }

/** Hub defaults, overridden key by key from a JSON file. Unknown keys and bad values throw. */
export function loadTarget(path: string | undefined, home = homedir()): Target {
  const target = hubTarget(home);
  if (!path) return target;
  const overrides = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw Error("target_invalid");
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in checks) || !checks[key as keyof Target](value)) throw Error("target_invalid");
    (target as Record<string, unknown>)[key] = value;
  }
  return target;
}
