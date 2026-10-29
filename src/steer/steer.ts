import { writeErr } from '../lib/egress';
import { HubError } from "./client";
import { labelHash } from "../lib/hash";
import { assess, rank, type Tiers } from "./rank";
import type { Credential, SnapshotRow } from "./types";

export interface SteerHub {
  list(): Promise<Credential[]>;
  setPriority(id: string, priority: number): Promise<void>;
}

export interface TickOptions {
  now?: number;
  dryRun?: boolean;
  /** `hub` column of credentials_snap. */
  hub?: string;
  tiers?: Tiers;
  log?: (line: string) => void;
  /** Called once per tick with one row per credential (P4 persists these to ClickHouse credentials_snap). */
  onSnapshot?: (rows: SnapshotRow[]) => void | Promise<void>;
}

export interface TickResult {
  credentials: number;
  changes: number;
  errors: number;
  retryAfterMs?: number;
}

/** ClickHouse DateTime64(3) text in UTC: `YYYY-MM-DD hh:mm:ss.sss`. */
const chTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const chTimeOrNull = (ts: string | null | undefined) => {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? chTime(ms) : null;
};

/** One steer pass: fetch → rank → PATCH only the diffs → snapshot. Never throws for a single bad credential. */
export async function tick(hub: SteerHub, opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? ((line: string) => writeErr(line));
  const stamp = new Date(now).toISOString();
  const credentials = await hub.list();
  const targets = rank(credentials, now, { tiers: opts.tiers });
  const result: TickResult = { credentials: credentials.length, changes: 0, errors: 0 };
  const rows: SnapshotRow[] = [];

  for (const c of credentials) {
    const a = assess(c, now);
    const label = labelHash(c.auth_index || c.id);
    const current = c.priority ?? 0;
    const target = targets.get(c.id);
    let priority = current;
    let action = "untouched";

    if (target !== undefined) {
      action = "hold";
      if (target !== current) {
        const verb = target > current ? "promote" : "demote";
        const why = a.healthy ? "" : ` (${a.reason})`;
        const resets = `7d_reset=${a.reset7dMs ? new Date(a.reset7dMs).toISOString() : "?"} 5h_reset=${a.reset5hMs ? new Date(a.reset5hMs).toISOString() : "?"}`;
        result.changes++;
        if (opts.dryRun) {
          action = `plan:${verb}`;
          log(`${stamp} steer dry-run credential=${label} priority ${current}->${target} ${resets}${why}`);
        } else {
          try {
            await hub.setPriority(c.id, target);
            priority = target;
            action = verb;
            log(`${stamp} steer credential=${label} priority ${current}->${target} ${resets}${why}`);
          } catch (err) {
            result.errors++;
            if (err instanceof HubError) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, err.retryAfterMs);
            action = "error";
            log(`${stamp} steer error credential=${label} priority ${current}->${target}: ${(err as Error).message}`);
          }
        }
      }
    }

    rows.push({
      ts: chTime(now),
      hub: opts.hub ?? "",
      credential: label,
      provider: (c.provider ?? c.type ?? "").trim(),
      priority,
      status: c.status ?? "",
      disabled: Boolean(c.disabled),
      unavailable: Boolean(c.unavailable),
      next_retry_after: chTimeOrNull(c.next_retry_after),
      reset_5h: a.reset5hMs === null ? null : chTime(a.reset5hMs),
      reset_7d: a.reset7dMs === null ? null : chTime(a.reset7dMs),
      utilization_5h: a.util5h,
      utilization_7d: a.util7d,
      signals: { ...(c.quota?.signals ?? {}) },
      action,
    });
  }

  if (opts.onSnapshot) {
    try {
      await opts.onSnapshot(rows);
    } catch (err) {
      result.errors++;
      log(`${stamp} steer snapshot error: ${(err as Error).message}`);
    }
  }
  return result;
}
