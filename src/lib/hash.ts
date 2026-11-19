import { createHash } from "node:crypto";

/**
 * Stable, non-reversible label for an identity value (auth_index, account email, API key).
 * steer and drain both use this, so `credential` matches across proxy_usage and steer logs.
 */
export function labelHash(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return createHash("sha256").update(`tokenlayer:v1:${v}`).digest("hex").slice(0, 16);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
