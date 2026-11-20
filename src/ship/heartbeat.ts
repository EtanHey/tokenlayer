// The ship daemon's heartbeat: one tiny row in tokenlayer.ship_heartbeat per pass (schema/012), so a shipper that
// stops and never restarts fails the live rows ship_heartbeat_age_s_m1 / _m4 instead of showing nothing.
// Rows carry the machine, the pass counts and a fixed error class. Never a path, a message or session content.
import { toClickHouseTime } from "../lib/time";

/** A healthy daemon passes every 10 s; one row a minute is enough for a 15-minute row and keeps parts few. */
export const HEARTBEAT_EVERY_MS = 60_000;

export type ErrorClass = "" | "store_unreachable" | "file_errors" | "other";
export type PassOutcome = { files: number; lines: number; bytes: number; durationMs: number; error?: unknown };
export type HeartbeatRow = {
  machine: string; ts: string; result: "ok" | "error"; error_class: ErrorClass;
  files: number; lines: number; bytes: number; duration_ms: number;
};
type Store = { insert(table: string, rows: readonly unknown[]): Promise<void> };

const unreachable = (e: unknown) => e instanceof Error && e.name === "StoreUnreachableError";

/** The pass's failure as one of four fixed words. shipOnce wraps per-file errors in an AggregateError. */
export function errorClass(err: unknown): ErrorClass {
  if (err === undefined) return "";
  if (unreachable(err)) return "store_unreachable";
  if (err instanceof AggregateError) return err.errors.some(unreachable) ? "store_unreachable" : "file_errors";
  return "other";
}

export function heartbeatRow(machine: string, pass: PassOutcome, nowMs: number): HeartbeatRow {
  const error_class = errorClass(pass.error);
  return {
    machine, ts: toClickHouseTime(nowMs), result: error_class ? "error" : "ok", error_class,
    files: pass.files, lines: pass.lines, bytes: pass.bytes, duration_ms: Math.max(0, Math.round(pass.durationMs)),
  };
}

/**
 * Writes a pass's row when a minute has passed since the last written row, or when the error class changed.
 * A failed write never throws (the store may be down: that is what a stale heartbeat reports) and is retried on
 * the next pass. Give it a ClickHouse client without unsent retries, so a down store never stalls the loop.
 */
export class Heartbeat {
  private lastAt = -Infinity;
  private lastClass: ErrorClass | undefined;
  private failing: string | undefined;

  constructor(private readonly store: Store, private readonly machine: string,
    private readonly everyMs = HEARTBEAT_EVERY_MS, private readonly log?: (msg: string) => void) {}

  async beat(pass: PassOutcome, nowMs = Date.now()): Promise<boolean> {
    const row = heartbeatRow(this.machine, pass, nowMs);
    if (row.error_class === this.lastClass && nowMs - this.lastAt < this.everyMs) return false;
    try {
      await this.store.insert("ship_heartbeat", [row]);
    } catch (err) {
      const why = errorClass(err) || "other";
      if (this.failing !== why) this.log?.(`heartbeat not written: ${why}`);
      this.failing = why;
      return false;
    }
    this.lastAt = nowMs;
    this.lastClass = row.error_class;
    this.failing = undefined;
    return true;
  }
}
