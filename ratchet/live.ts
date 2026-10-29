// Report-only probes, enabled on M1 after deployment; no CI or production writes.
import { readFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClickHouse } from '../src/lib/clickhouse';
import { loadEnvFiles } from '../src/lib/env';
const env = loadEnvFiles(['~/.config/tokenlayer/hub.env', '~/.config/tokenlayer/clickhouse.env']);
const ch = ClickHouse.fromEnv(env);
const id = process.argv[2];
const scalar = async (sql: string) => Number((await ch.exec(sql)).trim());
let value: number;
if (id === 'm1_disk_free_gb') {
  const disk = statfsSync(homedir()); value = disk.bavail * disk.bsize / 1e9;
} else if (id === 'usage_json_age_s') {
  const usage = JSON.parse(readFileSync(join(homedir(), '.config/tokenlayer/usage.json'), 'utf8'));
  value = usage.stale || !usage.generated_at ? NaN : (Date.now() - Date.parse(usage.generated_at)) / 1000;
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
  value = await scalar('SELECT quantileExact(0.95)(dateDiff(\'millisecond\', ts, ingested_at))/1000 FROM tokenlayer.session_events FINAL WHERE ingested_at > now()-INTERVAL 1 DAY HAVING count()>0');
} else if (id === 'ch_live_query_p95_ms') {
  const times: number[] = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); await ch.exec('SELECT session_id, count() FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY GROUP BY session_id SETTINGS use_query_cache=0'); times.push(performance.now() - start); }
  value = times.sort((a, b) => a - b)[18]!;
} else {
  const expr = id === 'cache_read_write_ratio_24h' ? "sum(cache_read_tokens)/nullIf(sum(cache_creation_tokens),0)"
    : id === 'w1h_share_24h' ? "sum(JSONExtractUInt(raw,'message','usage','cache_creation','ephemeral_1h_input_tokens'))/nullIf(sum(cache_creation_tokens),0)" : 'NULL';
  value = await scalar(`SELECT ${expr} FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY`);
}
if (!Number.isFinite(value) || value < 0) throw Error('missing live measurement');
console.log(value);
