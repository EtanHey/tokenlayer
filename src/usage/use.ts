// What each tool was actually used for, counted from tokenlayer.session_events: Antigravity and Kiro publish
// no quota, so counts stand in. Cursor sessions are not shipped, so Cursor gets none.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

export type UseWindow = { sessions: number; requests: number; input_tokens: number | null; output_tokens: number | null; credits: number | null };
export type Use = { observed_at: string | null; source: string; last_error?: string; '24h'?: UseWindow; '7d'?: UseWindow };
const VENDORS = ['antigravity', 'kiro', 'codex'], source = 'clickhouse:session_events';

// Canonical cumulative usage, so JSON key order cannot re-credit a refresh.
const totalSql = `toString(mapSort(JSONExtract(raw,'payload','info','total_token_usage','Map(String,UInt64)')))`;
// Recent replay/revision dedup plus capped history for active Codex paths (both window cuts).
export const useSql = (now: number) => `SELECT v,uniqExactIf(p,t>=d) s1,uniqExact(p) s7,countIf(r AND t>=d) r1,countIf(r) r7,
sumIf(x.2,t>=d) i1,sum(x.2) i7,sumIf(x.3,t>=d) o1,sum(x.3) o7,sumIf(x.4,t>=d) c1,sum(x.4) c7
FROM (SELECT multiIf(path LIKE '%/.kiro/%','kiro',path LIKE '%antigravity%','antigravity',path LIKE '%/.codex%','codex','') v,(machine,path) p,
argMax((ts,input_tokens,output_tokens,credits,type IN ('PLANNER_RESPONSE','kiro:assistant') OR role='token_count'),ingested_at) x,
x.1 t,x.5 r,fromUnixTimestamp64Milli(${Math.trunc(now)})-INTERVAL 1 DAY d FROM tokenlayer.session_events
WHERE harness IN ('t3','codex','antigravity','kiro') AND ts>=d-INTERVAL 6 DAY AND ts<=d+INTERVAL 1 DAY AND v!=''
GROUP BY v,p,if(message_id='',content_hash,message_id)) GROUP BY v SETTINGS max_memory_usage=2e9,max_execution_time=20`;

// Kiro rows carry credits, never tokens; the others carry tokens, never credits.
export function useBlocks(rows: Record<string, any>[], observed_at: string | null): Record<string, Use> {
  const win = (r: Record<string, any>, w: string, kiro: boolean): UseWindow => ({ sessions: +(r['s' + w] ?? 0), requests: +(r['r' + w] ?? 0),
    input_tokens: kiro ? null : +(r['i' + w] ?? 0), output_tokens: kiro ? null : +(r['o' + w] ?? 0), credits: kiro && r['c' + w] != null ? +r['c' + w] : null });
  return Object.fromEntries(VENDORS.map(v => {
    const r = rows.find(x => x.v === v) ?? {};
    return [v, { observed_at, source, ...(observed_at ? { '24h': win(r, '1', v === 'kiro'), '7d': win(r, '7', v === 'kiro') } : { last_error: 'store unavailable' }) }];
  }));
}

const files = () => Object.assign({}, ...['ship', 'clickhouse'].map(f => {
  try { return parseEnv(readFileSync(`${homedir()}/.config/tokenlayer/${f}.env`, 'utf8')); } catch { return {}; }
}));
// Never throws: without the store's address (ship.env), or on any failure, each vendor says so.
export async function readUse(now = Date.now(), env: Record<string, string> = files()) {
  try {
    if (!env.CLICKHOUSE_URL) throw 0;
    const res = await fetch(`${env.CLICKHOUSE_URL}/?wait_end_of_query=1&default_format=JSON`, { method: 'POST', body: useSql(now),
      headers: { 'X-ClickHouse-User': env.CLICKHOUSE_USER ?? '', 'X-ClickHouse-Key': env.CLICKHOUSE_PASSWORD ?? '' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok || res.headers.has('x-clickhouse-exception-code')) throw 0;
    return useBlocks((await res.json()).data, new Date(now).toISOString());
  } catch {
    return useBlocks([], null);
  }
}
