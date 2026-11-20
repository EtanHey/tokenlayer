import type { ClickHouse } from "../lib/clickhouse";
import { labelHash } from "../lib/hash";
import type { LastWeekly, Observation } from "./core";

const K = "anthropic-ratelimit-unified-7d-";

/**
 * The hub's last served weekly reading for a credential, from proxy_usage (14 days). Read-only;
 * never asks the hub or upstream for anything. The table sorts by credential, so this is cheap.
 */
export function weeklyHistory(ch: Pick<ClickHouse, "queryJSON">, timeoutMs = 5000) {
  return async (c: Observation): Promise<LastWeekly | undefined> => {
    const credential = labelHash(c.auth_index);
    if (!/^[0-9a-f]{16}$/.test(credential)) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = Error("history timeout");
        reject(error);
        controller.abort(error);
      }, timeoutMs);
      timer.unref?.();
    });
    const rows = await Promise.race([
      ch.queryJSON<{ u: string; reset: string; status: string; ms: string }>(
        `SELECT ratelimit['${K}utilization'] AS u, ratelimit['${K}reset'] AS reset,
  ratelimit['${K}status'] AS status, toString(toUnixTimestamp64Milli(ts)) AS ms
FROM tokenlayer.proxy_usage
WHERE credential = '${credential}' AND ts > now() - INTERVAL 14 DAY
  AND ratelimit['${K}utilization'] != ''
ORDER BY ts DESC LIMIT 1`,
        controller.signal,
      ),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const r = rows[0];
    if (!r) return undefined;
    const u = Number(r.u), ms = Number(r.ms), reset = Number(r.reset) * 1000;
    if (!Number.isFinite(u) || u < 0 || !r.status || !/^\d+$/.test(r.reset) || !Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime()) ||
        !Number.isFinite(reset) || reset <= 0)
      return undefined;
    return { u, reset, status: r.status, observed_at: new Date(ms).toISOString() };
  };
}
