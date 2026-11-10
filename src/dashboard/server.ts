import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { defaults, plan, type Observation } from "../fable/core";
import { Hub, locked, execute, save, event, statePath } from "../fable/io";
import { resetPressed, type ResetState } from "../fable/reset";
import { loadEnvFiles } from "../lib/env";
import { labelHash } from "../lib/hash";
import { ClickHouse } from "../lib/clickhouse";
const STALE_MS = 300000;
const FABLE_MODEL = "claude-fable-5-2";
export const coverage = [
  "M4 direct mode (~/.config/tokenlayer/direct.json, blank base URL)",
  "Claude apps and claude.ai",
  "api/<model> paid-key traffic",
];
export function quota(q: Observation["quota"], window: string) {
  const signals = Object.fromEntries(
    Object.entries(q?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const prefix = "anthropic-ratelimit-unified-" + window + "-";
  const raw = signals[prefix + "utilization"];
  return {
    utilization: raw === undefined ? null : Number(raw),
    status: String(signals[prefix + "status"] ?? "UNKNOWN").toLowerCase(),
    reset: signals[prefix + "reset"] ?? null,
    observed_at: q?.observed_at ?? null,
    stale: !q?.observed_at || Date.now() - Date.parse(q.observed_at) > STALE_MS,
  };
}
export const metricsSQL = (hours: number) =>
  `SELECT credential, model, toStartOfHour(ts) AS hour, count() AS requests,
 sum(total_tokens) AS tokens, countIf(status_code=429) AS errors429
 FROM tokenlayer.proxy_usage FINAL
 WHERE ts >= now() - INTERVAL ${hours} HOUR
 GROUP BY credential, model, hour ORDER BY hour`;
export function createHandler(o: {
  logins: string[];
  origin: string;
  secret: string;
  hub: Hub;
  ch: Pick<ClickHouse, "queryJSON">;
  path?: string;
  events?: string;
  page?: (token: string) => string;
}) {
  const path = o.path ?? statePath();
  const load = (): ResetState =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : defaults();
  const token = (login: string) => createHmac("sha256", o.secret).update(login).digest("hex");
  const history = () => {
    const p =
      o.events ??
      process.env.TOKENLAYER_FABLE_EVENTS ??
      join(homedir(), ".local/state/tokenlayer/fable/events.jsonl");
    return existsSync(p)
      ? readFileSync(p, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-50)
          .map((x) => JSON.parse(x))
      : [];
  };
  return async (r: Request): Promise<Response> => {
    const login = r.headers.get("Tailscale-User-Login") ?? "";
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    if (!login || !o.logins.includes(login)) return json({ error: "Forbidden" }, 403);
    const u = new URL(r.url);
    if (r.method === "POST") {
      const actual = Buffer.from(r.headers.get("X-CSRF-Token") ?? "");
      const wanted = Buffer.from(token(login));
      if (
        r.headers.get("Origin") !== o.origin ||
        actual.length !== wanted.length ||
        !timingSafeEqual(actual, wanted)
      )
        return json({ error: "Forbidden" }, 403);
    }
    try {
      if (r.method === "GET") {
        if (["/app.css", "/app.js"].includes(u.pathname))
          return new Response(Bun.file(new URL("." + u.pathname, import.meta.url)), {
            headers: {
              "Content-Type": u.pathname.endsWith(".css") ? "text/css" : "text/javascript",
            },
          });
        if (u.pathname === "/")
          return new Response(
            o.page?.(token(login)) ??
              `<meta name="csrf-token" content="${token(login)}"><h1>Fable dashboard API</h1>`,
            {
              headers: {
                "Content-Type": "text/html",
                "Cache-Control": "no-store",
                "Content-Security-Policy":
                  "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
              },
            },
          );
        if (u.pathname === "/api/state")
          return json({ state: load(), events: history(), coverage });
        if (u.pathname === "/api/accounts") return json(await accounts());
        if (u.pathname === "/api/metrics") {
          if (!["48h", "7d"].includes(u.searchParams.get("window") ?? "48h"))
            return json({ error: "Invalid window" }, 400);
          return json({
            rows: await joinAccounts(
              await o.ch.queryJSON<{ credential: string }>(
                metricsSQL(u.searchParams.get("window") === "7d" ? 168 : 48),
              ),
            ),
            freshness: await o.ch.queryJSON(
              "SELECT max(ts) AS last_at FROM tokenlayer.proxy_usage",
            ),
          });
        }
        if (u.pathname === "/api/burn") return json(await burn());
        if (u.pathname === "/api/recommendation")
          return json((await accounts()).map((c) => recommend(c, load().thresholds)));
      }
      if (
        r.method === "POST" &&
        ["/api/switch", "/api/resets", "/api/reset-pressed"].includes(u.pathname)
      ) {
        if (!r.headers.get("Content-Type")?.startsWith("application/json"))
          return json({ error: "JSON required" }, 415);
        const raw = await r.text();
        if (Buffer.byteLength(raw) > 8192) return json({ error: "Body too large" }, 413);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ error: "Malformed JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json({ error: "Object required" }, 400);
        return await locked(async () => {
          const s = load(),
            obs = await o.hub.observations(),
            c = obs.find((c) => c.email === body.account);
          const op = body.opId ?? crypto.randomUUID();
          if (typeof op !== "string" || !op || op.length > 160)
            return json({ error: "Invalid operation" }, 400);
          const emit = (e: unknown) => {
            const target =
              o.events ??
              process.env.TOKENLAYER_FABLE_EVENTS ??
              join(homedir(), ".local/state/tokenlayer/fable/events.jsonl");
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            appendFileSync(target, JSON.stringify({ ...(e as object), who: login }) + "\n", {
              mode: 0o600,
            });
          };
          if (u.pathname === "/api/switch") {
            if (
              !["off", "manual"].includes(body.mode) ||
              typeof body.strict !== "boolean" ||
              typeof body.spillover !== "boolean" ||
              typeof body.account !== "string" ||
              !c
            )
              return json({ error: "Invalid switch" }, 400);
            if (s.ops[op] === "done") return json({ state: s, opId: op });
            s.mode = body.mode;
            s.fableAccount = body.account ?? s.fableAccount;
            s.strictFableAccount = body.strict;
            s.spillover = body.spillover;
            if (!Object.keys(s.baseline).length) {
              if (obs.length !== 2) return json({ error: "Expected two OAuth accounts" }, 409);
              for (const c of obs) s.baseline[c.id] = o.hub.metadata(c.id);
            }
            save(s, path);
            await execute(s, plan(s, obs).desired, o.hub, op, (s) => save(s, path), emit);
          } else {
            if (!c) return json({ error: "Unknown account" }, 400);
            if (u.pathname === "/api/resets") {
              if (
                !(
                  body.left === null ||
                  (Number.isInteger(body.left) && body.left >= 0 && body.left <= 3)
                ) ||
                typeof body.confirmed !== "boolean"
              )
                return json({ error: "Invalid count" }, 400);
              s.resets ??= {};
              s.resets[body.account] = { left: body.left, confirmedByEtan: body.confirmed };
              save(s, path);
              emit({
                at: new Date().toISOString(),
                account: body.account,
                stage: "resets-set",
                left: body.left,
                status: "idempotent-set",
              });
            } else {
              if (!c.auth_index || !body.opId) return json({ error: "Operation id required" }, 400);
              await resetPressed(
                s,
                body.account,
                c.auth_index,
                op,
                true,
                o.hub,
                () => save(s, path),
                emit,
              );
            }
          }
          return json({ state: s, opId: op, readback: await accounts() });
        }, path);
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json(
        { error: "Dashboard operation unavailable; retry with the same operation id" },
        503,
      );
    }
  };
  function safeMetadata(id: string) {
    try {
      return o.hub.metadata(id);
    } catch {
      return { error: "OAuth metadata unreadable" };
    }
  }
  async function joinAccounts<T extends { credential: string }>(rows: T[]) {
    const obs = await o.hub.observations();
    const emails = new Map(obs.map((c) => [labelHash(c.auth_index), c.email]));
    return rows.map((r) => ({ ...r, account: emails.get(r.credential) ?? "Unmapped credential" }));
  }
  async function accounts() {
    return (await o.hub.observations()).map((c) => ({
      id: c.id,
      email: c.email,
      status: c.status,
      cooldowns: c.cooldowns,
      weekly: quota(c.quota, "7d"),
      fable: quota(c.model_quotas?.[FABLE_MODEL], "7d_oi"),
      exclusions: safeMetadata(c.id),
      exclusionsSource: "persisted OAuth file readback",
    }));
  }
  async function burn() {
    const rawRows = await o.ch.queryJSON<{
      credential: string;
      window: string;
      ts: string;
      utilization: number | null;
    }>(
      `SELECT credential, 'weekly' AS window, ts, utilization_7d AS utilization 
 FROM tokenlayer.credentials_snap
 WHERE ts >= now() - INTERVAL 6 HOUR
 UNION ALL SELECT credential, 'fable' AS window, ts,
 toFloat64OrNull(signals['anthropic-ratelimit-unified-7d_oi-utilization']) AS utilization 
 FROM tokenlayer.credentials_snap
 WHERE ts >= now() - INTERVAL 6 HOUR
 ORDER BY credential, window, ts`,
    );
    const rows = await joinAccounts(rawRows);
    const current = await accounts();
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.account + ":" + r.window;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return {
      estimate: true,
      method: "first-to-last delta",
      rows,
      projections: [...groups].map(([key, rs]) => {
        const valid = rs.filter((r) => r.utilization !== null),
          a = valid[0],
          b = valid.at(-1);
        const hours = a && b ? (parseTime(b.ts) - parseTime(a.ts)) / 3600000 : 0;
        const rate = hours > 0 ? (b!.utilization! - a!.utilization!) / hours : 0;
        const cap =
          rate > 0 ? Date.now() + (Math.max(0, 1 - b!.utilization!) / rate) * 3600000 : null;
        const reset = parseTime(current.find((c) => c.email === a?.account)?.weekly.reset);
        return {
          key,
          perHour: rate > 0 ? rate : null,
          projectedCapAt:
            cap && Number.isFinite(reset) && cap < reset ? new Date(cap).toISOString() : null,
        };
      }),
    };
  }
}
export function start(page?: (token: string) => string) {
  const env = loadEnvFiles(["~/.config/tokenlayer/hub.env", "~/.config/tokenlayer/clickhouse.env"]);
  if (!env.TOKENLAYER_DASHBOARD_LOGINS?.trim() || !env.TOKENLAYER_DASHBOARD_ORIGIN) {
    console.warn(
      "Dashboard requires allowlist and origin; local processes can forge identity headers",
    );
    throw Error("Dashboard identity configuration required");
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    maxRequestBodySize: 8192,
    port: Number(env.TOKENLAYER_DASHBOARD_PORT ?? 8446),
    fetch: createHandler({
      logins: (env.TOKENLAYER_DASHBOARD_LOGINS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      origin:
        env.TOKENLAYER_DASHBOARD_ORIGIN ?? "https://locals-macbook-pro.tail5ef6be.ts.net:8446",
      secret: crypto.randomUUID(),
      hub: new Hub(env.TOKENLAYER_HUB_URL ?? "http://127.0.0.1:8317", env.CLIPROXY_MGMT_KEY ?? ""),
      ch: ClickHouse.fromEnv(env),
      page,
    }),
  });
}
if (import.meta.main) start();

export function parseTime(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  const text = String(value);
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(text) ? text : text.replace(" ", "T") + "Z");
}
export function recommend(c: any, thresholds: any = {}, now = Date.now()) {
  const f = c.fable.utilization === null ? null : c.fable.utilization * 0.5;
  const refill =
    String(c.fable.status).toLowerCase() === "rejected" ||
    c.fable.utilization >= (thresholds.fableCapAt ?? 0.95);
  const rescue =
    String(c.weekly.status).toLowerCase() === "rejected" ||
    c.weekly.utilization >= (thresholds.weeklyExhaustedAt ?? 0.95);
  const hours = (parseTime(c.weekly.reset) - now) / 3600000;
  const timing = Number.isFinite(hours)
    ? `${Math.max(0, Math.round(hours))} h to natural reset. ` +
      (hours < 36
        ? "Under 36 h: wait unless urgent or resets expiring."
        : "36 h heuristic: confirm urgency and alternate capacity.")
    : "Natural reset time could not be parsed; 36 h heuristic unavailable.";
  const rule = refill ? "(a) Fable-cap refill" : rescue ? "(b) Weekly-cap rescue" : null;
  const refund =
    f === null
      ? "refund unknown, check Settings > Usage"
      : `maximum refund ${Math.round(f * 100)}% of week`;
  const stale = refill ? c.fable.stale : rescue ? c.weekly.stale : c.weekly.stale || c.fable.stale;
  return {
    account: c.email,
    verdict: stale ? "UNKNOWN" : rule ? "consider" : "wait",
    reason:
      (rule
        ? rule +
          ": " +
          refund +
          (rescue && f !== null && f <= 0.1 ? "; small refund: only for urgent work." : ".")
        : "No cap trigger observed; urgent work may justify an override.") +
      " " +
      timing +
      (stale ? " Observations stale; verify Usage." : ""),
    worthPctOfWeek: f === null ? null : Math.round(f * 100),
    hoursToReset: Number.isFinite(hours) ? hours : null,
  };
}
