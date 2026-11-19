// Report-only probes, enabled on M1 after deployment; no CI or production writes.
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { ClickHouse } from '../src/lib/clickhouse';
import { loadEnvFiles } from '../src/lib/env';
import { unreconciledSQL } from '../src/jev/unreconciled';
import { LIVE_QUERY_SQL, liveRatioSQL, shipperLagSQL } from './live-sql';
import { readUsageAge } from './usage-age';
import { HEARTBEAT_MACHINES, readHeartbeatAge, type HeartbeatMachine } from './heartbeat-age';
import { burnSQL, burnVerdict, parsePoints, readTarget } from './burn';
const env = loadEnvFiles(['~/.config/tokenlayer/hub.env', '~/.config/tokenlayer/clickhouse.env']);
const ch = ClickHouse.fromEnv(env);
const id = process.argv[2];
const scalar = async (sql: string) => Number((await ch.exec(sql)).trim());
let value: number;
if (id === 'claude_burn_2h') {
  // Judged against orc's target, not the row's ceiling: one JSON line that live-schedule reads.
  const target = readTarget(), nowS = Math.floor(Date.now() / 1000);
  console.log(JSON.stringify(burnVerdict(parsePoints(await ch.exec(burnSQL(nowS))), target, nowS)));
  process.exit(0);
} else if (id === 'm1_disk_free_gb') {
  const disk = statfsSync(homedir()); value = disk.bavail * disk.bsize / 1e9;
} else if (id === 'usage_json_age_s') {
  const age = readUsageAge();
  // 'skip': the M4 is asleep or just woke; live-schedule holds the row's state.
  if (age === 'skip') { console.log('skip'); process.exit(0); }
  value = age ?? NaN;
} else if (id?.startsWith('ship_heartbeat_age_s_')) {
  const machine = id.slice('ship_heartbeat_age_s_'.length) as HeartbeatMachine;
  if (!HEARTBEAT_MACHINES.includes(machine)) throw Error('unknown heartbeat machine');
  const age = await readHeartbeatAge(machine, (sql) => ch.queryJSON(sql));
  // 'skip': the M4 is asleep, off the tailnet or just woke; live-schedule holds the row's state.
  if (age === 'skip') { console.log('skip'); process.exit(0); }
  value = age ?? NaN;
} else if (id?.startsWith('hub_mgmt_latency_')) {
  if (!env.CLIPROXY_MGMT_KEY) throw Error('management credential unavailable');
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const response = await fetch(`${env.TOKENLAYER_HUB_URL ?? 'http://127.0.0.1:8317'}/v8/management/credentials`, {
      headers: { Authorization: `Bearer ${env.CLIPROXY_MGMT_KEY}` }, signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || !Array.isArray((await response.json() as { files: unknown[] }).files)) throw Error('management probe failed');
    samples.push(performance.now() - start);
  }
  value = samples.sort((a, b) => a - b)[id.includes('p50') ? 9 : 18]!;
} else if (id === 'shipper_live_lag_s') {
  value = await scalar(shipperLagSQL());
} else if (id === 'jev_unreconciled_24h') {
  value = await scalar(unreconciledSQL());
} else if (id === 'ch_live_query_p95_ms') {
  const times: number[] = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); await ch.exec(LIVE_QUERY_SQL); times.push(performance.now() - start); }
  value = times.sort((a, b) => a - b)[18]!;
} else {
  value = await scalar(liveRatioSQL(id ?? ''));
}
if (!Number.isFinite(value) || value < 0) throw Error('missing live measurement');
console.log(value);
