// One frozen harness, run against cwd's source and schema on both sides of CI.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startLocalClickHouse } from '../tests/support/local-clickhouse';
const root = resolve(import.meta.dir, '../.local');
mkdirSync(root, { recursive: true });
const receipt = join(root, `r1-${process.env.RATCHET_RUN_ID ?? 'manual'}.json`);
const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dir, '../tests/fixtures', name), 'utf8'));
const source = (name: string) => import(resolve(process.cwd(), `src/${name}.ts`));
const stamp = Date.parse('2026-10-29T12:00:00Z');
export function line(i: number) {
  return JSON.stringify({ type: 'assistant', entrypoint: 'cli', sessionId: `s-${i % 100}`, cwd: `/synthetic/repo-${i % 7}`,
    timestamp: new Date(stamp + i * 1000 + Math.floor(i / 1000) * 3600000).toISOString(),
    message: { id: `msg-${i}`, role: i % 4 ? 'assistant' : 'user', model: `synthetic-${i % 3}`,
      usage: { input_tokens: i % 100, output_tokens: 10, cache_read_input_tokens: i % 3 ? 100 : 0, cache_creation_input_tokens: 5 } } });
}
async function measure() {
  const out: Record<string, number> = {};
  const { snapshot, serialize } = await source('usage/snapshot');
  out['payload-usage-bytes'] = Buffer.byteLength(serialize(snapshot(fixture('steer/credentials-live-redacted.json'), stamp)));
  const admit = Bun.spawnSync(['bun', resolve('src/admit/main.ts'), '--kind', 'lead', '--active-leads', '0', '--now', new Date(stamp).toISOString(), '--file', resolve(import.meta.dir, '../tests/fixtures/admit/producer-five.json')]);
  if (admit.exitCode !== 0 || !JSON.parse(admit.stdout.toString()).admit) throw Error('admit fixture failed');
  out['payload-admit-bytes'] = admit.stdout.length;
  const { tick } = await source('steer/steer');
  const status = await tick({ list: async () => fixture('steer/credentials-live-redacted.json').files, setPriority: async () => {} }, {
    now: stamp, log: () => {}, onSnapshot: (rows: unknown) => { out['payload-steer-bytes'] = Buffer.byteLength(JSON.stringify(rows) + '\n'); },
  });
  if (status.errors) throw Error('steer fixture failed');
  const { mapUsageRecord } = await source('drain/record');
  out['payload-drain-bytes'] = Buffer.byteLength(JSON.stringify(mapUsageRecord(fixture('usage-queue.json')[0], { hub: 'synthetic' })) + '\n');
  for (const name of ['usage', 'admit', 'steer', 'drain', 'ship']) {
    const build = await Bun.build({ entrypoints: [resolve(`src/${name}/main.ts`)], target: 'bun' });
    if (!build.success || build.outputs.length !== 1) throw Error(`build failed: ${name}`);
    out[`bundle-${name}-bytes`] = build.outputs[0]!.size;
  }
  const dir = mkdtempSync(join(root, 'replay-'));
  const local = await startLocalClickHouse();
  try {
    const ch = local.client;
    const { applySchema } = await source('lib/schema');
    await applySchema(ch, resolve('schema'));
    const { shipOnce } = await source('ship/ship');
    const file = join(dir, 'fixture.jsonl');
    const opts = { machine: 'synthetic', roots: [{ kind: 'claude', dir }], clickhouse: ch,
      statePath: join(dir, 'state.json'), rateBytesPerSec: 0 };
    // Capture the full production ship row, including file identity and byte offsets.
    writeFileSync(file, line(0) + '\n');
    await shipOnce({ ...opts, clickhouse: { insert: async (_: string, rows: unknown[]) => {
      out['payload-session-bytes'] = Buffer.byteLength(JSON.stringify(rows[0]) + '\n');
    } } });
    rmSync(opts.statePath);
    const corpus = Array.from({ length: 50000 }, (_, i) => line(i)).join('\n') + '\n';
    const rates: number[] = [], lags: number[] = [];
    const count = async () => Number((await ch.exec('SELECT count() FROM tokenlayer.session_events FINAL')).trim());
    for (let run = 0; run < 5; run++) {
      await ch.exec('TRUNCATE TABLE tokenlayer.session_events');
      if (existsSync(opts.statePath)) rmSync(opts.statePath);
      writeFileSync(file, '');
      const started = performance.now();
      appendFileSync(file, corpus);
      const shipped = await shipOnce(opts);
      const ingested = performance.now();
      if (shipped.lines !== 50000 || await count() !== 50000) throw Error('fixture not fully visible in FINAL');
      rates.push(50000 * 1000 / (ingested - started));
      lags.push(performance.now() - started);
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    out['ship-ingest-rows-s'] = median(rates);
    out['ship-replay-lag-ms'] = median(lags);
    const from = ' FROM tokenlayer.session_events FINAL ';
    const queries = {
      'sessions-between': `SELECT session_id, min(ts), max(ts), count() ${from} WHERE ts BETWEEN toDateTime('2026-10-29 12:00:00') AND toDateTime('2026-11-02 12:00:00') GROUP BY session_id ORDER BY session_id`,
      'burn-by-role': `SELECT role, model, sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_creation_tokens) ${from} GROUP BY role, model ORDER BY role, model`,
      'cache-misses': `SELECT intDiv(greatest(dateDiff('second', previous, ts), 0), 300) AS gap_bucket, count(), sum(cache_creation_tokens) FROM (SELECT ts, cache_read_tokens, cache_creation_tokens, lagInFrame(ts, 1, ts) OVER (PARTITION BY session_id ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS previous ${from}) WHERE cache_read_tokens = 0 GROUP BY gap_bucket ORDER BY gap_bucket`,
    };
    for (const [name, query] of Object.entries(queries)) {
      const samples: number[] = [];
      for (let i = 0; i < 22; i++) {
        const start = performance.now();
        const answer = await ch.exec(query + ' SETTINGS use_query_cache=0, max_threads=2');
        if (!answer.trim()) throw Error(`empty golden query: ${name}`);
        if (i >= 2) samples.push(performance.now() - start);
      }
      out[`${name}-p95-ms`] = samples.sort((a, b) => a - b)[18]!;
    }
    await ch.exec('OPTIMIZE TABLE tokenlayer.session_events FINAL');
    const bytes = Number((await ch.exec("SELECT sum(bytes_on_disk) FROM system.parts WHERE active AND database='tokenlayer' AND table='session_events'")).trim());
    if (!(bytes > 0) || await count() !== 50000) throw Error('invalid storage measurement');
    out['session-disk-bytes-10k'] = bytes / 5;
    console.error(JSON.stringify({ fixture_rows: 50000, ingest_rows_s: rates, append_final_ms: lags }));
    return out;
  } finally { await local.stop(); rmSync(dir, { recursive: true, force: true }); }
}
if (import.meta.main) {
  if (!process.env.RATCHET_RUN_ID || !existsSync(receipt)) {
    try { writeFileSync(receipt, JSON.stringify(await measure())); }
    catch (error) { writeFileSync(receipt, '{}'); throw error; }
  }
  const values = JSON.parse(readFileSync(receipt, 'utf8'));
  const value = values[process.argv[2]!];
  if (!Number.isFinite(value) || value <= 0) throw Error('missing R1 measurement');
  console.log(value);
}
