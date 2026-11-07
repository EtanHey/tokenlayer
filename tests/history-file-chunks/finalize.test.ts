import { test, expect, afterAll, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ClickHouse as LegacyClickHouse, RAW_BYTES } from '../../src/lib/clickhouse';
import { RawClickHouse as ClickHouse } from '../../src/raw-document/client';
import { RawDocumentStore } from '../../src/raw-document/storage';
import { readFinalCoverage } from '../../src/history-file-chunks/coverage';
import { describe } from '../../src/history-file-chunks/durable';
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const columns = [...fs.readFileSync('src/raw-document/schema.sql', 'utf8').matchAll(/^    (\w+) (String|UInt64|UInt8),?$/gm)].map(m => ({ name: m[1], type: m[2] }));
const rows = new Map<string, Record<string, unknown>>(), releases: (() => void)[] = [];
let mode = 'ok', requests = 0, inserts = 0, insertBytes = 0, inserted!: () => void;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
  requests++; const bytes = Buffer.from(await req.arrayBuffer()), sql = new URL(req.url).searchParams.get('query') ?? bytes.toString();
  if (sql.startsWith('INSERT')) {
    inserts++; inserted?.(); insertBytes = Buffer.byteLength(req.url) + bytes.length;
    if (mode === 'stall') await new Promise<void>(r => releases.push(r));
    if (mode === 'stream') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('partial')); releases.push(() => { try { c.close(); } catch {} }); } }));
    if (mode === 'exception' || mode === 'exception-body') return new Response('DB::Exception SYNTHETIC_SECRET_BODY', { headers: mode === 'exception' ? { 'X-ClickHouse-Exception-Code': '42' } : {} });
    if (mode === 'oversize') return new Response('x'.repeat(2 * 1024 ** 2));
    if (mode === 'oversize-stream') return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2 * 1024 ** 2)); c.close(); } }));
    if (mode === 'partial') return new Response('partial');
    if (mode === 'redirect') return new Response('', { status: 302, headers: { location: server.url.origin + '/must-not-follow' } });
    const row = JSON.parse(bytes.toString('latin1')); const raw = Buffer.from(row.raw, 'latin1'); delete row.raw;
    rows.set(`${row.revision_id}:${row.acquisition_id}`, { ...row, actual_bytes: String(raw.length), actual_hash: sha(raw) });
    return new Response('');
  }
  const json = (v: unknown[]) => new Response(v.map(r => JSON.stringify(r) + '\n').join(''));
  if (sql.includes('system.tables')) return json([{ engine: 'ReplacingMergeTree', sorting_key: 'revision_id, acquisition_id', storage_policy: 'default' }]);
  if (sql.includes('system.columns')) return json(columns);
  if (sql.includes('system.disks')) return json([{ name: 'default', free_space: String(40 * 1024 ** 3), unreserved_space: String(40 * 1024 ** 3), keep_free_space: String(15 * 1024 ** 3) }]);
  if (sql.includes(' FINAL ')) {
    if (mode === 'read-stall') await new Promise<void>(r => releases.push(r));
    expect(Buffer.byteLength(sql)).toBeLessThan(192 * 1024); expect(sql).toContain('max_threads=1');
    let found = [...sql.matchAll(/\('([a-f0-9]{64})','([a-f0-9]{64})'\)/g)].map(m => rows.get(`${m[1]}:${m[2]}`)!).filter(Boolean).sort((a, b) => `${a.revision_id}:${a.acquisition_id}`.localeCompare(`${b.revision_id}:${b.acquisition_id}`));
    if (mode === 'missing') found = []; if (mode === 'duplicate') found = [...found, ...found]; if (mode === 'extra') found.push({ ...found[0], revision_id: '0'.repeat(64) });
    if (mode === 'hash') found = found.map(r => ({ ...r, actual_hash: '0'.repeat(64) }));
    if (mode === 'metadata') found = found.map(r => ({ ...r, origin_machine: 'INFERRED' }));
    if (mode === 'numeric') found = found.map(r => ({ ...r, original_bytes: Number(r.original_bytes), actual_bytes: Number(r.actual_bytes) }));
    if (mode === 'bad-number') found = found.map(r => ({ ...r, actual_bytes: '01' }));
    if (mode === 'reversed') found.reverse();
    if (mode === 'bad-json') return new Response('{\n');
    if (mode === 'duplicate-key') return new Response('{"contract_version":0,' + JSON.stringify(found[0]).slice(1) + '\n');
    return json(found);
  }
  return new Response('x'.repeat(4096));
} });
const config = () => ({ url: server.url.origin, user: 'synthetic', password: 'SYNTHETIC_KEY', database: 'owned', requestTimeoutMs: 150, maxRequestBytes: 9 * 1024 ** 2, maxResponseBytes: 1024 ** 2 });
const document = () => ({ bytes: Buffer.from([0, 255, 128, 10]), originalHash: sha(Buffer.from([0, 255, 128, 10])), originalBytes: 4,
  custodyMachine: 'synthetic', sourceLocator: 'synthetic:1', format: 'opaque', formatVersion: '1', acquisition: { method: 'owned', observedAt: '2026-11-07T00:00:00.000Z', receiptHash: 'a'.repeat(64) } });
afterEach(() => { for (const r of releases.splice(0)) r(); mode = 'ok'; rows.clear(); });
afterAll(async () => { await server.stop(true); console.log(`OWNED_LOOPBACK_STOPPED requests=${requests} pending=${server.pendingRequests}`); });
test('real bounded clone path, exact request charge and legacy unset behavior', async () => {
  const changing = config(); let reads = 0; Object.defineProperty(changing, 'requestTimeoutMs', { enumerable: true, get: () => ++reads === 1 ? 150 : 0 });
  expect(new ClickHouse(changing).config.requestTimeoutMs).toBe(150); expect(reads).toBe(1);
  const d = document(), cfg = config(), store = new RawDocumentStore(new ClickHouse(cfg), 'streaming'); cfg.requestTimeoutMs = 1;
  expect((await store.put(d)).status).toBe('ACKNOWLEDGED'); const row = { raw: '', [RAW_BYTES]: d.bytes };
  const ch = new ClickHouse(config()); await ch.insert('tiny', [row]); const charge = insertBytes, count = requests;
  await new ClickHouse({ ...config(), maxRequestBytes: charge }).insert('tiny', [row]);
  await expect(new ClickHouse({ ...config(), maxRequestBytes: charge - 1 }).insert('tiny', [row])).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/); expect(requests).toBe(count + 1);
  const { requestTimeoutMs: _, maxRequestBytes: _r, maxResponseBytes: _s, ...legacy } = config(); expect((await new LegacyClickHouse(legacy).exec('LEGACY')).length).toBe(4096);
  await new LegacyClickHouse(legacy).insert('tiny', [row]); expect(insertBytes).toBe(charge);
  const circular: { privateSynthetic?: unknown } = {}; circular.privateSynthetic = circular;
  await expect(ch.insert('tiny', [circular])).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
});
test('actual loopback deadline/stream/exception/oversize/partial and abort remain unknown ACK without retry', async () => {
  for (const fault of ['stall', 'stream', 'exception', 'exception-body', 'oversize', 'oversize-stream', 'partial', 'redirect', 'abort']) {
    mode = fault; let ready!: () => void; const reached = new Promise<void>(r => { ready = r; }); inserted = ready;
    const before = inserts, beforeRequests = requests;
    const abort = new AbortController(), pending = new RawDocumentStore(new ClickHouse(config()), 'streaming').put(document(), abort.signal); pending.catch(() => {});
    if (fault === 'abort') { mode = 'stall'; await reached; abort.abort(); }
    await expect(pending).rejects.toThrow(/^ACK_UNKNOWN:/); expect(inserts).toBe(before + 1); expect(requests).toBe(beforeRequests + 4); for (const r of releases.splice(0)) r();
  }
});
test('concrete FINAL checks full metadata and actual raw proof, strict coverage and numeric forms', async () => {
  const ch = new ClickHouse(config()), d = document(), second = { ...d, sourceLocator: 'synthetic:2' };
  await new RawDocumentStore(ch, 'streaming').put(d); await new RawDocumentStore(ch, 'streaming').put(second); const expected = [describe(d, -1, null), describe(second, 0, 0)];
  for (mode of ['ok', 'numeric']) expect((await readFinalCoverage(ch, expected, async () => {})).documents).toBe(2);
  for (mode of ['missing', 'duplicate', 'extra', 'hash', 'metadata', 'bad-number', 'reversed', 'bad-json', 'duplicate-key']) await expect(readFinalCoverage(ch, expected, async () => {})).rejects.toThrow(/^FINAL_COVERAGE_REFUSED$/);
  mode = 'ok'; const count = requests;
  await expect(readFinalCoverage(new ClickHouse({ ...config(), database: 'a'.repeat(192 * 1024) }), expected, async () => {})).rejects.toThrow(/^FINAL_COVERAGE_REFUSED$/); expect(requests).toBe(count);
  for (const change of [{ requestTimeoutMs: NaN }, { maxResponseBytes: -1 }, { maxRequestBytes: 0 }]) expect(() => new ClickHouse({ ...config(), ...change })).toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
});
