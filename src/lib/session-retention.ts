/** Session text retention. schema:apply expands the matching SQL migration placeholder. */
export const SESSION_RETENTION_DAYS = 30;
const RETENTION_MS = SESSION_RETENTION_DAYS * 86400000;

/** Match the TTL's UTC January-1970 and Antigravity exemptions on generation replay. */
export function retainSessionRow(row: { harness: string; ts: string }, nowMs: number): boolean {
  const ms = Date.parse(row.ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) || row.harness === "antigravity" || row.ts.startsWith("1970-01-") || ms >= nowMs - RETENTION_MS;
}
