type Meter = { utilization: number | null; stale: boolean; reset: unknown };
type Account = { email?: string; status?: string; weekly: Meter; fable: Meter;
  resets?: { left: number | null } };
export function arrangement(accounts: Account[], now = Date.now()) {
  const usable = accounts.filter(c => c.status === "active" && !c.weekly.stale && !c.fable.stale &&
    c.weekly.utilization !== null && c.fable.utilization !== null &&
    c.weekly.utilization < .95 && c.fable.utilization < .99);
  const score = (c: Account) =>
    (1 - c.fable.utilization!) * (1 - c.weekly.utilization!) + (c.resets?.left ?? 0) * .1 +
    Math.max(0, Date.parse(String(c.weekly.reset)) - now) / 3600000 / 10000;
  const ranked = [...usable].sort((a,b) => score(b) - score(a));
  const keepOff = usable.length < 2;
  const next = accounts.find(c => !usable.includes(c));
  const account = keepOff ? next?.email ?? ranked[0]?.email ?? null : ranked[0]?.email ?? null;
  const reset = next?.weekly.reset;
  const when = reset ? new Date(/^\d+$/.test(String(reset)) ? Number(reset) * 1000 : String(reset)) : null;
  const time = when && Number.isFinite(when.getTime()) ? when.toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit"
  }) : "its weekly reset";
  const stale = next && (next.status !== "active" || next.weekly.stale || next.fable.stale ||
    next.weekly.utilization === null || next.fable.utilization === null);
  if (stale) return { keepOff: true, account, reason: `Keep OFF: ${account} data stale; recheck Usage.` };
  return { keepOff, account, reason: keepOff
    ? `Keep OFF until ${account ?? "the other account"} resets ${time}, ` +
      `then Fable → ${account ?? "recheck Usage"}. ` +
      "Both accounts need usable weekly and Fable room before splitting."
    : `Fable → ${account}. Best combined Fable and weekly room, considering resets left and weekly reset time.` };
}
export function outsideDelta(before: number | null, after: number | null, requests: number) {
  return requests === 0 && before !== null && after !== null && after > before ? (after - before) * 100 : null;
}
export function sessionsSQL(hours: number) {
  if (hours !== 3 && hours !== 24) throw Error("Invalid window");
  return `WITH u AS (
 SELECT session_id, count() AS requests, sum(total_tokens) AS tokens,
 sum(output_tokens) AS output_tokens,
 sumIf(total_tokens, model LIKE 'claude-fable%') AS fable_tokens,
 groupUniqArray(credential) AS credentials, min(ts) AS first_at, max(ts) AS last_at
 FROM tokenlayer.proxy_usage FINAL
 WHERE ts > now() - INTERVAL ${hours} HOUR AND provider = 'claude'
 GROUP BY session_id ORDER BY tokens DESC LIMIT 10
 ), s AS (
 SELECT session_id, any(machine) AS machine, any(harness) AS harness,
 any(project) AS project, any(cwd) AS cwd
 FROM tokenlayer.session_events
 WHERE ts > now() - INTERVAL 1 DAY AND session_id IN (SELECT session_id FROM u)
 GROUP BY session_id
 ) SELECT u.*, s.machine, s.harness, s.project, s.cwd,
 if(tokens = 0, 0, round(100 * fable_tokens / tokens, 1)) AS fable_pct
 FROM u LEFT JOIN s USING (session_id) ORDER BY tokens DESC
 SETTINGS max_execution_time=10, max_result_rows=10`;
}
