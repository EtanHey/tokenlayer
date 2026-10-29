import { registerSecrets } from '../lib/egress';
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const expandHome = (p: string) => (p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p);

/** Read a shell-style env file (KEY=VALUE, optional `export`, quotes) under the process env, which wins. */
export function loadEnv(path: string, processEnv: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const file = expandHome(path);
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
      if (!m || raw.trim().startsWith("#")) continue;
      let value = m[2].trim();
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
      out[m[1]] = value;
    }
  }
  registerSecrets(out);
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) out[k] = v;
  registerSecrets(out);
  return out;
}
