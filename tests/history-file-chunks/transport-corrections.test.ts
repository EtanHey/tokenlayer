import { test, expect, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { ClickHouse as LegacyClickHouse } from '../../src/lib/clickhouse';
import { RawClickHouse as ClickHouse } from '../../src/raw-document/client';
import { describe } from '../../src/history-file-chunks/durable';
import { readFinalCoverage, expectedRow } from '../../src/history-file-chunks/coverage';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let response = '', status = 200, headers: Record<string, string> = {};
const seen: { url: string; body: string; charge: number }[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
  const body = await req.text(); seen.push({ url: req.url, body, charge: Buffer.byteLength(req.url) + Buffer.byteLength(body) });
  return new Response(response, { status, headers });
} });
const cfg = () => ({ url: server.url.origin, user: 'owned', password: '', database: 'owned', requestTimeoutMs: 500, maxRequestBytes: 192 * 1024, maxResponseBytes: 1024 ** 2 });
const legacy = () => ({ url: server.url.origin, user: 'owned', password: '', database: 'owned' });
afterAll(async () => { await server.stop(true); console.log('CORRECTION_A_STOPPED ' + JSON.stringify({ requests: seen.length, pending: server.pendingRequests })); });
test('canonical URL is charged before ordinary exec and INSERT; exact ASCII and encoded boundaries', async () => {
  response = ''; status = 200; headers = {};
  // Unicode numeric host maps to the owned loopback; punycode hosts below are preflight-only.
  for (const url of [server.url.origin, server.url.origin + '/é space', server.url.origin.replace('127.0.0.1', '１２７。０。０。１') + '/é space']) {
    const sql = 'x', actual = new URL(url + '/?wait_end_of_query=1').href, cap = Buffer.byteLength(actual) + 1;
    let before = seen.length;
    await expect(new ClickHouse({ ...cfg(), url, maxRequestBytes: cap - 1 }).exec(sql)).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
    expect(seen.length).toBe(before);
    await new ClickHouse({ ...cfg(), url, maxRequestBytes: cap }).exec(sql);
    expect(seen.length).toBe(before + 1); expect(seen.at(-1)!.url).toBe(actual); expect(seen.at(-1)!.charge).toBe(cap);
    await new ClickHouse({ ...cfg(), url }).insert('tiny', [{ a: 1 }]);
    const insertCap = seen.at(-1)!.charge; before = seen.length;
    await expect(new ClickHouse({ ...cfg(), url, maxRequestBytes: insertCap - 1 }).insert('tiny', [{ a: 1 }])).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
    expect(seen.length).toBe(before);
    await new ClickHouse({ ...cfg(), url, maxRequestBytes: insertCap }).insert('tiny', [{ a: 1 }]);
    expect(seen.at(-1)!.charge).toBe(insertCap); expect(seen.at(-1)!.body).toBe('{"a":1}\n');
    console.log('CANONICAL_CHARGE ' + JSON.stringify({ configured: url, canonical: actual, execCap: cap, insertCap }));
  }
  for (const host of ['é.invalid', 'xn--9ca.invalid']) {
    const url = `http://${host}/é space`, before = seen.length;
    expect(new URL(url).hostname).toBe('xn--9ca.invalid');
    await expect(new ClickHouse({ ...cfg(), url, maxRequestBytes: 1 }).exec('x')).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
    expect(seen.length).toBe(before); // Too small even before serialization: no DNS or external request.
  }
});
test('structured marker metadata succeeds; HTTP/header/standalone/trailing diagnostics and partial JSON refuse', async () => {
  const bytes = Buffer.from('tiny');
  const d = describe({ bytes, originalHash: sha(bytes), originalBytes: bytes.length, custodyMachine: 'owned', sourceLocator: 'owned:marker', format: 'opaque', formatVersion: '1', acquisition: { method: 'owned DB::Exception fixture', observedAt: '2026-11-07T00:00:00.000Z', receiptHash: 'a'.repeat(64) } }, -1, null);
  const good = JSON.stringify(expectedRow(d)) + '\n';
  response = good; status = 200; headers = {};
  expect((await readFinalCoverage(new ClickHouse(cfg()), [d], async () => {})).documents).toBe(1);
  for (const fault of ['http', 'header', 'diagnostic', 'code-diagnostic', 'trailing', 'partial', 'unframed']) {
    status = fault === 'http' ? 500 : 200; headers = fault === 'header' ? { 'X-ClickHouse-Exception-Code': '42' } : {};
    response = fault === 'diagnostic' ? 'DB::Exception owned\n' : fault === 'code-diagnostic' ? '  Code: 42. DB::Exception owned\n' : fault === 'trailing' ? good + 'Code: 42. DB::Exception owned\n' : fault === 'partial' ? good.slice(0, -3) + '\n' : fault === 'unframed' ? good.slice(0, -1) : good;
    const before = seen.length;
    await expect(readFinalCoverage(new ClickHouse(cfg()), [d], async () => {})).rejects.toThrow(/^FINAL_COVERAGE_REFUSED$/);
    expect(seen.length).toBe(before + 1);
  }
});
test('unset flatMap holes, all holes, empty, dense and source order; bounded holes stay strict', async () => {
  response = ''; status = 200; headers = {};
  const sparse = new Array(4); sparse[1] = { a: 1 }; sparse[3] = { b: 2 };
  for (const [rows, body] of [[sparse, '{"a":1}\n{"b":2}\n'], [new Array(3), ''], [[], null], [[{ z: 3 }, { a: 1 }], '{"z":3}\n{"a":1}\n']] as const) {
    const before = seen.length; await new LegacyClickHouse(legacy()).insert('tiny', rows);
    expect(seen.length).toBe(before + (body === null ? 0 : 1)); if (body !== null) expect(seen.at(-1)!.body).toBe(body);
  }
  for (const rows of [sparse, new Array(3)]) {
    const before = seen.length;
    await expect(new ClickHouse(cfg()).insert('tiny', rows)).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/); expect(seen.length).toBe(before);
  }
  const explicitUndefined = [undefined], before = seen.length;
  await expect(new LegacyClickHouse(legacy()).insert('tiny', explicitUndefined)).rejects.toBeInstanceOf(TypeError); expect(seen.length).toBe(before);
});

// Byte framing: TextDecoder strips an initial BOM; INSERT ACK requires zero wire bytes.
test('BOM-only nonempty INSERT ACK refuses by response byte count', async () => {
  response = '\uFEFF'; status = 200; headers = {};
  expect(Buffer.from(response).toString('hex')).toBe('efbbbf');
  const before = seen.length;
  await expect(new ClickHouse(cfg()).insert('tiny', [{ a: 1 }])).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
  expect(seen.length).toBe(before + 1);
});
test('zero-byte INSERT ACK remains accepted and space-only ACK refuses', async () => {
  response = ''; status = 200; headers = {};
  const before = seen.length; await new ClickHouse(cfg()).insert('tiny', [{ a: 1 }]);
  expect(seen.length).toBe(before + 1);
  response = ' ';
  await expect(new ClickHouse(cfg()).insert('tiny', [{ a: 1 }])).rejects.toThrow(/^CLICKHOUSE_BOUNDED_REFUSED$/);
});
test('BOM query decoding retains prior behavior', async () => {
  response = '\uFEFF'; status = 200; headers = {};
  expect(await new ClickHouse(cfg()).exec('SELECT 1')).toBe('');
});
