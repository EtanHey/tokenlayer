// Jev (Typesafe /v1/systemone) usage.jsonl ledgers, written by golems packages/shared/src/lib/jev.py.
// Each call appends a reservation row (64k-token maximum) before the request and a negative
// reconciliation row after a valid response; the two sum to the real cost. A failed or crashed call
// leaves its reservation unreconciled. The ledger holds no state, answers or keys.
import { parseTimestampMs, toClickHouseTime } from "../lib/time";

export const RESERVED_INPUT_TOKENS = 64_000;

export type LedgerLine = {
  ts: number;
  site: string;
  model: string;
  kind: "reservation" | "reconciliation";
  reservation_id: string;
  input_tokens: number | null;
  reserved_input_tokens: number | null;
  cost_usd: number;
};

/** One row of tokenlayer.systemone_calls. Fields lane 3 adds to jev.py stay NULL (column defaults). */
export type SystemoneCall = {
  ts: string;
  reservation_id: string;
  machine: string;
  ledger_path: string;
  site: string;
  model: string;
  response_model: string | null;
  reserved_at: string | null;
  reconciled_at: string | null;
  input_tokens: number | null;
  reserved_input_tokens: number | null;
  reserved_cost_usd: number | null;
  reconcile_cost_usd: number | null;
  cost_usd: number;
  accounting_quality: "measured" | "reserved_max" | "unreconciled" | "orphan_reconciliation";
};

const tokens = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= RESERVED_INPUT_TOKENS;

export function parseLedgerLine(text: string): LedgerLine | null {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = parseTimestampMs(o.ts);
  const { kind, reservation_id: id, site, model, cost_usd: cost } = o;
  if (ts === null || typeof o.ts !== "string" || (kind !== "reservation" && kind !== "reconciliation")) return null;
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || typeof site !== "string" || typeof model !== "string") return null;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  if (kind === "reservation" ? !tokens(o.reserved_input_tokens) : !tokens(o.input_tokens)) return null;
  return {
    ts, site, model, kind, reservation_id: id,
    input_tokens: kind === "reconciliation" ? (o.input_tokens as number) : null,
    reserved_input_tokens: kind === "reservation" ? (o.reserved_input_tokens as number) : null,
    cost_usd: cost,
  };
}

/** Parse complete lines only: an unterminated last line is still being appended. */
export function parseLedgerText(text: string): { lines: LedgerLine[]; total: number; invalid: number } {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((l) => l.trim());
  const lines = complete.map(parseLedgerLine).filter((l): l is LedgerLine => l !== null);
  return { lines, total: complete.length, invalid: complete.length - lines.length };
}

/**
 * Fold ledgers into one call per reservation_id. Copied ledgers repeat lines: the first ledger path in
 * sorted order owns a call, and repeats of a kind already seen are counted as duplicates and ignored.
 */
export function foldCalls(machine: string, ledgers: { path: string; lines: LedgerLine[] }[]): { calls: SystemoneCall[]; duplicates: number } {
  const byId = new Map<string, { path: string; reservation?: LedgerLine; reconciliation?: LedgerLine }>();
  let duplicates = 0;
  for (const { path, lines } of [...ledgers].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    for (const line of lines) {
      const call = byId.get(line.reservation_id) ?? { path };
      if (call[line.kind]) duplicates++;
      else call[line.kind] = line;
      byId.set(line.reservation_id, call);
    }
  }
  const calls = [...byId].map(([id, { path, reservation: res, reconciliation: rec }]): SystemoneCall => ({
    ts: toClickHouseTime((res ?? rec)!.ts),
    reservation_id: id,
    machine,
    ledger_path: path,
    site: (res ?? rec)!.site,
    model: (res ?? rec)!.model,
    response_model: rec?.model ?? null,
    reserved_at: res ? toClickHouseTime(res.ts) : null,
    reconciled_at: rec ? toClickHouseTime(rec.ts) : null,
    input_tokens: rec?.input_tokens ?? null,
    reserved_input_tokens: res?.reserved_input_tokens ?? null,
    reserved_cost_usd: res?.cost_usd ?? null,
    reconcile_cost_usd: rec?.cost_usd ?? null,
    cost_usd: (res?.cost_usd ?? 0) + (rec?.cost_usd ?? 0),
    // jev.py books the 64k maximum when the API returns no usage, so 64k is not a measurement.
    accounting_quality: !res ? "orphan_reconciliation" : !rec ? "unreconciled"
      : rec.input_tokens === RESERVED_INPUT_TOKENS ? "reserved_max" : "measured",
  }));
  return { calls: calls.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.reservation_id < b.reservation_id ? -1 : 1)), duplicates };
}
