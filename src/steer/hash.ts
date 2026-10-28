import { createHash } from "node:crypto";

/**
 * Stable, non-reversible label for an identity value. Same algorithm as P4's `labelHash`
 * (sha256("tokenlayer:v1:" + value)[:16]) so `credential` joins proxy_usage and credentials_snap;
 * dedupe into src/lib/hash.ts once that lands on main.
 */
export function labelHash(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return createHash("sha256").update(`tokenlayer:v1:${v}`).digest("hex").slice(0, 16);
}
