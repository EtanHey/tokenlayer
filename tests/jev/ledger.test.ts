import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldCalls, parseLedgerLine, parseLedgerText } from "../../src/jev/ledger";

const A1 = "a1".repeat(16);
const fixture = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/jev", name), "utf8");
const reservation = (id: string, extra = {}) => JSON.stringify({ ts: "2026-09-22T18:53:33.830854Z", site: "probe", model: "jev-latest", kind: "reservation", reservation_id: id, reserved_input_tokens: 64000, cost_usd: 0.002688, ...extra });
const reconciliation = (id: string, extra = {}) => JSON.stringify({ ts: "2026-09-22T18:53:34.722034Z", site: "probe", model: "jev-1.13.0", kind: "reconciliation", reservation_id: id, input_tokens: 298, cost_usd: -0.002675484, ...extra });

describe("Jev usage.jsonl ledger", () => {
  test("parses the eight jev.py ledger fields and rejects other shapes", () => {
    expect(parseLedgerLine(reservation(A1))).toEqual({ ts: Date.parse("2026-09-22T18:53:33.830Z"), site: "probe", model: "jev-latest", kind: "reservation", reservation_id: A1, reserved_input_tokens: 64000, input_tokens: null, cost_usd: 0.002688 });
    expect(parseLedgerLine(reconciliation(A1))?.input_tokens).toBe(298);
    for (const bad of ["", "{", "[]", JSON.stringify({ kind: "reservation" }), reservation(""), reservation(A1, { kind: "other" }),
      reservation(A1, { ts: "never" }), reservation(A1, { cost_usd: "1" }), reconciliation(A1, { input_tokens: -1 })]) {
      expect(parseLedgerLine(bad)).toBeNull();
    }
  });

  test("an unterminated last line is still being written and is left for the next read", () => {
    const parsed = parseLedgerText(`${reservation(A1)}\n${reconciliation(A1)}`);
    expect(parsed.lines.map((l) => l.kind)).toEqual(["reservation"]);
    expect(parsed).toMatchObject({ total: 1, invalid: 0 });
  });

  test("one call per reservation: net cost, measured tokens, response model", () => {
    const parsed = parseLedgerText(`${reservation(A1)}\n${reconciliation(A1)}\n`);
    const [call] = foldCalls("m4", [{ path: "/l/usage.jsonl", lines: parsed.lines }]).calls;
    expect(call).toEqual({
      ts: "2026-09-22 18:53:33.830", reservation_id: A1, machine: "m4", ledger_path: "/l/usage.jsonl", site: "probe",
      model: "jev-latest", response_model: "jev-1.13.0", reserved_at: "2026-09-22 18:53:33.830", reconciled_at: "2026-09-22 18:53:34.722",
      input_tokens: 298, reserved_input_tokens: 64000, reserved_cost_usd: 0.002688, reconcile_cost_usd: -0.002675484,
      cost_usd: 0.002688 - 0.002675484, accounting_quality: "measured",
    });
  });

  test("a reservation without reconciliation keeps the held cost and is marked unreconciled", () => {
    const { calls } = foldCalls("m4", [{ path: "/p", lines: parseLedgerText(fixture("e8-state-preflight.usage.jsonl")).lines }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accounting_quality: "unreconciled", reconciled_at: null, input_tokens: null, response_model: null });
    expect(calls[0].cost_usd).toBeCloseTo(0.002688, 15);
  });

  test("a reconciliation that books the 64k maximum is reserved_max, not measured", () => {
    const { calls } = foldCalls("m4", [{ path: "/p", lines: parseLedgerText(`${reservation(A1)}\n${reconciliation(A1, { input_tokens: 64000, cost_usd: 0 })}\n`).lines }]);
    expect(calls[0].accounting_quality).toBe("reserved_max");
  });

  test("copies of a ledger fold to one call; the first path in sorted order owns it", () => {
    const lines = parseLedgerText(`${reservation(A1)}\n${reconciliation(A1)}\n`).lines;
    const folded = foldCalls("m4", [{ path: "/z/usage.jsonl", lines }, { path: "/a/usage.jsonl", lines }]);
    expect(folded.calls.map((c) => [c.reservation_id, c.ledger_path])).toEqual([[A1, "/a/usage.jsonl"]]);
    expect(folded.duplicates).toBe(2);
  });

  test("replay of a real ledger: every line lands in exactly one call", () => {
    const parsed = parseLedgerText(fixture("e8-state-live.usage.jsonl"));
    expect(parsed).toMatchObject({ total: 324, invalid: 0 });
    const { calls } = foldCalls("m4", [{ path: "/e8", lines: parsed.lines }]);
    expect(calls).toHaveLength(162);
    expect(calls.every((c) => c.reconciled_at !== null && c.reserved_at !== null)).toBe(true);
    const net = calls.reduce((sum, c) => sum + c.cost_usd, 0);
    const ledger = parsed.lines.reduce((sum, l) => sum + l.cost_usd, 0);
    expect(net).toBeCloseTo(ledger, 12);
    expect(calls.reduce((sum, c) => sum + (c.input_tokens ?? 0), 0)).toBe(parsed.lines.reduce((sum, l) => sum + (l.input_tokens ?? 0), 0));
  });
});
