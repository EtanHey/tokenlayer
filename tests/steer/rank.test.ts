import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assess, rank } from "../../src/steer/rank";
import type { Credential } from "../../src/steer/types";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const H = 3_600_000;
const epoch = (ms: number) => String(Math.floor(ms / 1000));

/** A Claude Max OAuth credential as GET /v8/management/credentials lists it. */
function max(id: string, over: Partial<Credential> & { s?: Record<string, string> } = {}): Credential {
  const { s, ...rest } = over;
  return {
    id,
    auth_index: `idx-${id}`,
    provider: "claude",
    type: "claude",
    account_type: "oauth",
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    priority: null,
    quota: s ? { observed_at: new Date(NOW).toISOString(), signals: s } : { signals: {} },
    ...rest,
  };
}

/** Allowed 5h/7d windows resetting `h5` / `d7` hours from NOW. */
function sig(h5: number, d7: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Anthropic-Ratelimit-Unified-5h-Reset": epoch(NOW + h5 * H),
    "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.2",
    "Anthropic-Ratelimit-Unified-7d-Reset": epoch(NOW + d7 * H),
    "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.4",
    ...extra,
  };
}

const apiKey: Credential = { id: "claude-key", provider: "claude", account_type: "api_key", status: "active", priority: 0 };
const codex: Credential = { id: "codex-1", provider: "codex", account_type: "oauth", status: "active", priority: 7 };

const asObject = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

describe("rule 1: never promote an unavailable, cooling, disabled or weekly-exhausted credential", () => {
  // `a` resets sooner on both windows, so it wins unless the case makes it ineligible.
  const b = max("b", { s: sig(4, 100) });
  const cases: [string, Credential][] = [
    ["unavailable", max("a", { s: sig(1, 10), unavailable: true })],
    ["disabled flag", max("a", { s: sig(1, 10), disabled: true })],
    ["disabled status", max("a", { s: sig(1, 10), status: "disabled" })],
    ["error status", max("a", { s: sig(1, 10), status: "error" })],
    ["next_retry_after in the future", max("a", { s: sig(1, 10), next_retry_after: new Date(NOW + 60_000).toISOString() })],
    [
      "unexpired cooldown",
      max("a", { s: sig(1, 10), cooldowns: [{ scope: "model", reason: "quota", retry_at: new Date(NOW + 60_000).toISOString(), remaining_seconds: 60 }] }),
    ],
    ["7d status rejected", max("a", { s: sig(1, 10, { "Anthropic-Ratelimit-Unified-7d-Status": "rejected" }) })],
    ["7d utilization at 100%", max("a", { s: sig(1, 10, { "Anthropic-Ratelimit-Unified-7d-Utilization": "1" }) })],
    ["5h status rejected", max("a", { s: sig(1, 10, { "Anthropic-Ratelimit-Unified-5h-Status": "rejected" }) })],
    [
      "unified status rejected",
      max("a", { s: sig(1, 10, { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-Reset": epoch(NOW + H) }) }),
    ],
  ];
  for (const [name, a] of cases) {
    test(`${name}: stays at 50, the healthy one takes 100`, () => {
      expect(asObject(rank([a, b], NOW))).toEqual({ a: 50, b: 100 });
      expect(assess(a, NOW).healthy).toBe(false);
    });
  }

  test("an expired cooldown or retry time no longer blocks", () => {
    const a = max("a", {
      s: sig(1, 10),
      next_retry_after: new Date(NOW - 1).toISOString(),
      cooldowns: [{ scope: "auth", reason: "quota", retry_at: new Date(NOW - 1).toISOString(), remaining_seconds: 0 }],
    });
    expect(asObject(rank([a, b], NOW))).toEqual({ a: 100, b: 50 });
  });

  test("a rejection whose window already reset is stale and does not block", () => {
    const a = max("a", {
      s: sig(1, 10, {
        "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
        "Anthropic-Ratelimit-Unified-5h-Reset": epoch(NOW - H),
      }),
    });
    expect(asObject(rank([a, b], NOW))).toEqual({ a: 100, b: 50 });
  });
});

describe("rule 2: among healthy Max credentials the earliest reset wins", () => {
  test("earliest 7d reset takes 100 even when its 5h resets later", () => {
    const m = rank([max("a", { s: sig(4, 100) }), max("b", { s: sig(1, 30) }), max("c", { s: sig(2, 60) })], NOW);
    expect(asObject(m)).toEqual({ a: 50, b: 100, c: 50 });
  });

  test("equal 7d resets fall back to the earliest 5h reset", () => {
    const m = rank([max("a", { s: sig(4, 30) }), max("b", { s: sig(2, 30) })], NOW);
    expect(asObject(m)).toEqual({ a: 50, b: 100 });
  });

  test("a credential without signals ranks after one with signals but stays eligible at 50", () => {
    const m = rank([max("fresh"), max("seen", { s: sig(4, 150) })], NOW);
    expect(asObject(m)).toEqual({ fresh: 50, seen: 100 });
  });

  test("a 7d reset in the past counts as unknown, not as soonest", () => {
    const stale = max("stale", { s: sig(1, 10, { "Anthropic-Ratelimit-Unified-7d-Reset": epoch(NOW - H) }) });
    const m = rank([stale, max("seen", { s: sig(4, 150) })], NOW);
    expect(asObject(m)).toEqual({ stale: 50, seen: 100 });
  });

  test("when no healthy credential has signals nobody is promoted", () => {
    expect(asObject(rank([max("a"), max("b")], NOW))).toEqual({ a: 50, b: 50 });
  });

  test("signal header names are matched case-insensitively", () => {
    const lower = Object.fromEntries(Object.entries(sig(1, 10)).map(([k, v]) => [k.toLowerCase(), v]));
    expect(asObject(rank([max("a", { s: lower }), max("b", { s: sig(4, 100) })], NOW))).toEqual({ a: 100, b: 50 });
  });

  test("ranking is independent of input order", () => {
    const creds = [max("a", { s: sig(4, 30) }), max("b", { s: sig(4, 30) }), max("c", { s: sig(9, 90) })];
    const forward = asObject(rank(creds, NOW));
    expect(asObject(rank([...creds].reverse(), NOW))).toEqual(forward);
    expect(Object.values(forward).filter((p) => p === 100)).toHaveLength(1);
  });
});

describe("rule 3: no healthy Max means every Max sits at 50 and the API key stays 0", () => {
  test("all Max unhealthy", () => {
    const m = rank([max("a", { s: sig(1, 10), unavailable: true }), max("b", { s: sig(2, 20), disabled: true }), apiKey], NOW);
    expect(asObject(m)).toEqual({ a: 50, b: 50, "claude-key": 0 });
  });
});

describe("rule 4: Claude API keys are always 0 and other providers are untouched", () => {
  test("API key with the soonest reset is still 0", () => {
    const key = { ...apiKey, priority: 100, quota: { signals: sig(0.1, 0.5) } };
    expect(asObject(rank([key, max("a", { s: sig(4, 100) })], NOW))).toEqual({ a: 100, "claude-key": 0 });
  });

  test("a Claude credential with no account_type is treated as an API key", () => {
    const unknown: Credential = { id: "mystery", provider: "claude", status: "active", quota: { signals: sig(1, 1) } };
    expect(rank([unknown], NOW).get("mystery")).toBe(0);
  });

  test("non-Claude providers are absent from the result", () => {
    const m = rank([codex, max("a", { s: sig(1, 10) })], NOW);
    expect(m.has("codex-1")).toBe(false);
    expect(asObject(m)).toEqual({ a: 100 });
  });
});

describe("live hub shape (redacted GET /v8/management/credentials, 2026-10-28)", () => {
  const live = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/steer/credentials-live-redacted.json"), "utf8")) as {
    files: Credential[];
    observed_at: string;
  };
  const at = Date.parse(live.observed_at);

  test("max-a resets its week first (despite the later 5h reset) and takes 100", () => {
    expect(asObject(rank(live.files, at))).toEqual({ "claude-max-a.json": 100, "claude-max-b.json": 50 });
  });

  test("assess parses both windows from the captured headers", () => {
    const b = assess(live.files[1], at);
    expect(b).toMatchObject({ kind: "max", healthy: true, reset5hMs: 1793180400_000, reset7dMs: 1793498400_000, util5h: 0.55, util7d: 0.93 });
  });

  test("once max-a's week is rejected, max-b is promoted", () => {
    const [a, b] = live.files;
    const rejected = { ...a, quota: { ...a.quota, signals: { ...a.quota!.signals, "Anthropic-Ratelimit-Unified-7d-Status": "rejected" } } };
    expect(asObject(rank([rejected, b], at))).toEqual({ "claude-max-a.json": 50, "claude-max-b.json": 100 });
  });
});
