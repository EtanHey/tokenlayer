/** Parse an RFC 3339 timestamp (any precision/offset) or epoch value into ms, or null. */
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  // Date.parse rejects >3 fractional digits on some engines; trim to milliseconds.
  const trimmed = value.trim().replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** Format epoch ms as ClickHouse DateTime64(3) text in UTC: `YYYY-MM-DD hh:mm:ss.sss`. */
export function toClickHouseTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}
