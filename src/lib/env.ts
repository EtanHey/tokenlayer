import { registerSecrets } from './egress';
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Parse a shell-style env file (KEY=VALUE, optional `export`, quotes). Unparseable lines are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export const expandHome = (p: string) => (p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p);

/**
 * Merge env files (later files win) under the process env (which wins over all files), so launchd
 * plists carry only file paths, never secrets.
 */
export function loadEnvFiles(paths: string[], processEnv: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const p of paths.map(expandHome)) {
    if (existsSync(p)) {
      const fileEnv = parseEnv(readFileSync(p, "utf8"));
      registerSecrets(fileEnv);
      Object.assign(merged, fileEnv);
    }
  }
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) merged[k] = v;
  registerSecrets(merged);
  return merged;
}
