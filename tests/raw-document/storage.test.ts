import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClickHouse } from '../../src/lib/clickhouse';
import { RawDocumentStore, MAX_DOCUMENT_BYTES, MAX_WIRE_BYTES } from '../../src/raw-document/storage';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const input = (raw = Buffer.from('{\n  "messages": ["שלום 🌍"]\n}')) => ({
  bytes: raw, originalHash: sha(raw), originalBytes: raw.length, custodyMachine: 'test-m4',
  sourceLocator: '/synthetic/session.json', format: 'gemini-chat-json', formatVersion: 'UNKNOWN',
  acquisition: { method: 'synthetic-complete-buffer', observedAt: '2026-11-06T00:00:00.000Z', receiptHash: 'a'.repeat(64) },
});
function fixture(policy?: 'manual' | 'streaming') {
  const inserts: { body: Buffer; token: string | null }[] = [];
  let free = 100 * 1024 ** 3, reserve = 0, fail = false, badSchema = false, reads = 0;
  let onDisk = (_sql: string) => {};
  let diskRows: Record<string, unknown>[] | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url), query = url.searchParams.get('query');
    if (query?.startsWith('INSERT')) {
      inserts.push({ body: Buffer.from(await req.arrayBuffer()), token: url.searchParams.get('insert_deduplication_token') });
      return fail ? new Response('synthetic lost acknowledgement', { status: 503 }) : new Response('');
    }
    reads++;
    const sql = await req.text();
    if (sql.includes('system.disks')) onDisk(sql);
    const rows = sql.includes('system.tables') ? [{ engine: badSchema ? 'MergeTree' : 'ReplacingMergeTree', sorting_key: 'revision_id, acquisition_id', storage_policy: 'default' }]
      : sql.includes('system.columns') ? [...readFileSync(new URL('../../src/raw-document/schema.sql', import.meta.url), 'utf8')
        .matchAll(/^    (\w+) (String|UInt64|UInt8),?$/gm)].map(m => ({ name: m[1], type: m[2] }))
      : diskRows ?? [{ name: 'default', free_space: String(free), unreserved_space: String(free), keep_free_space: String(reserve) }];
    return new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } });
  const store = new RawDocumentStore(new ClickHouse({ url: server.url.origin, user: 'default', password: '', database: 'synthetic' }), policy);
  return { store, inserts, stop: () => server.stop(true), setFree: (n: number) => { free = n; },
    setDisks: (rows: Record<string, unknown>[]) => { diskRows = rows; }, setReserve: (n: number) => { reserve = n; }, onDisk: (fn: (sql: string) => void) => { onDisk = fn; }, setFail: () => { fail = true; }, badSchema: () => { badSchema = true; }, reads: () => reads };
}

for (const bytes of [Buffer.from('{\n  "messages": []\n}\n'), Buffer.from('{"messages":[]}'),
  Buffer.from('\ufeff{\r\n "x": "é שלום 🌍"\r\n}\t '), Buffer.from('{\n "n": 1\n}')]) {
  test(`complete opaque document round-trip ${sha(bytes).slice(0, 8)}`, async () => {
    const f = fixture();
    try {
      await f.store.put(input(bytes));
      const row = JSON.parse(f.inserts[0].body.toString());
      expect(Buffer.from(row.raw)).toEqual(bytes);
      expect(row.original_hash).toBe(sha(bytes)); expect(row.original_bytes).toBe(bytes.length);
      expect(row.origin_machine).toBe('UNKNOWN'); expect(row.original_path).toBe('UNKNOWN');
      expect(Object.keys(row).some(k => /timestamp|provider|proxy|latency|credential/.test(k))).toBe(false);
    } finally { f.stop(); }
  });
}

test('replay is stable; changed bytes, paths and custody remain distinct candidate copies', async () => {
  const f = fixture();
  try {
    const a = input(), first = await f.store.put(a), replay = await f.store.put(a);
    expect(replay).toEqual(first); expect(f.inserts[0]).toEqual(f.inserts[1]);
    expect(first.revisionId).toBe(sha(JSON.stringify(['raw-document-revision-v1', a.custodyMachine, a.sourceLocator,
      a.format, a.formatVersion, a.originalHash, a.originalBytes])));
    for (const b of [{ ...a, sourceLocator: '/copy.json' }, { ...a, custodyMachine: 'test-m1' }, input(Buffer.from('{}'))])
      expect((await f.store.put(b)).revisionId).not.toBe(first.revisionId);
    const next = await f.store.put({ ...a, acquisition: { ...a.acquisition, receiptHash: 'b'.repeat(64) } });
    expect(next.revisionId).toBe(first.revisionId); expect(next.acquisitionId).not.toBe(first.acquisitionId);
    expect(JSON.parse(f.inserts[2].body.toString()).original_hash).toBe(a.originalHash);
  } finally { f.stop(); }
});

test('bad pins, exact caps, strings and unsafe identifiers refuse before IO', async () => {
  const f = fixture();
  try {
    for (const patch of [{ originalHash: 'B'.repeat(64) }, { originalBytes: 1 }, { sourceLocator: '\ud800' },
      { sourceLocator: '' }, { sourceLocator: 'x'.repeat(16385) }, { bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) },
      { acquisition: { ...input().acquisition, observedAt: 'yesterday' } }])
      await expect(f.store.put({ ...input(), ...patch })).rejects.toThrow();
    expect(f.reads()).toBe(0); expect(f.inserts).toHaveLength(0);
    const escaped = Buffer.alloc(Math.floor(MAX_WIRE_BYTES / 6), 0);
    await expect(f.store.put(input(escaped))).rejects.toThrow('WIRE_CAP');
    expect(f.reads()).toBe(0);
    expect(() => new RawDocumentStore(new ClickHouse({ url: '', user: '', password: '', database: "x';DROP" }))).toThrow();
    expect(() => new RawDocumentStore(new ClickHouse({ url: '', user: '', password: '', database: 'synthetic' }), 'bypass' as never)).toThrow();
  } finally { f.stop(); }
});

test('schema and physical space fail closed; pre-send abort leaves no insert', async () => {
  const f = fixture();
  try {
    f.setFree(35 * 1024 ** 3);
    await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED'); expect(f.inserts).toHaveLength(0);
    f.setFree(100 * 1024 ** 3); f.badSchema();
    await expect(f.store.put(input())).rejects.toThrow('SCHEMA_MISMATCH'); expect(f.inserts).toHaveLength(0);
    const signal = AbortSignal.abort();
    await expect(f.store.put(input(), signal)).rejects.toThrow(); expect(f.inserts).toHaveLength(0);
  } finally { f.stop(); }
});

test('uncertain acknowledgement is not success; replay uses identical row/token; caller mutation is isolated', async () => {
  const f = fixture();
  try {
    f.setFail(); const a = input(), pristine = input();
    const pending = f.store.put(a); a.bytes.fill(0); a.sourceLocator = '/mutated';
    await expect(pending).rejects.toThrow('ACK_UNKNOWN');
    await expect(f.store.put(pristine)).rejects.toThrow('ACK_UNKNOWN');
    expect(f.inserts).toHaveLength(2); expect(f.inserts[0]).toEqual(f.inserts[1]);
  } finally { f.stop(); }
});

test('exact wire cap boundary and binary escaping stay byte bounded', async () => {
  const f = fixture();
  try {
    await f.store.put(input(Buffer.from('x')));
    const overhead = f.inserts[0].body.length - 1;
    // Row length changes only with decimal original_bytes digit width; hashes have fixed widths.
    const n = MAX_WIRE_BYTES - overhead - (String(MAX_WIRE_BYTES).length - 1);
    await f.store.put(input(Buffer.alloc(n, 120)));
    expect(f.inserts.at(-1)!.body.length).toBe(MAX_WIRE_BYTES);
    await expect(f.store.put(input(Buffer.alloc(n + 1, 120)))).rejects.toThrow('WIRE_CAP');
    const raw = Buffer.from([0, 9, 10, 13, 31, 34, 92, 128, 255]);
    await f.store.put(input(raw));
    const body = f.inserts.at(-1)!.body;
    expect(body.includes(Buffer.from('"raw":"\\u0000\\t\\n\\r\\u001f\\"\\\\', 'latin1'))).toBe(true);
    expect(body.includes(Buffer.from([128, 255]))).toBe(true);
  } finally { f.stop(); }
});

test('saturated disk accounting and abort after guards refuse without write', async () => {
  const f = fixture();
  try {
    f.setFree(0); f.setReserve(100 * 1024 ** 3);
    await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED'); expect(f.inserts).toHaveLength(0);
    f.setFree(100 * 1024 ** 3); f.setReserve(0);
    const controller = new AbortController(); f.onDisk(() => controller.abort());
    await expect(f.store.put(input(), controller.signal)).rejects.toThrow(); expect(f.inserts).toHaveLength(0);
  } finally { f.stop(); }
});

const GiB = 1024 ** 3, streamBase = 2 * GiB + 384 * 1024 ** 2;
const disk = (u: unknown, reserve: unknown = String(15 * GiB), free: unknown = u) =>
  ({ name: 'default', free_space: free, unreserved_space: u, keep_free_space: reserve });
test('A MUST-1 explicit streaming admits tiny request at installed15GiB and ~3GiB usable', async () => {
  const f = fixture('streaming');
  try { f.setDisks([disk('3448561664')]); await f.store.put(input(Buffer.from('{}'))); expect(f.inserts).toHaveLength(1); }
  finally { f.stop(); }
});
test('A MUST-2 manual reserve40GiB cannot dispatch with unreserved1', async () => {
  const f = fixture();
  try { f.setDisks([disk('1', String(40 * GiB))]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED'); expect(f.inserts).toHaveLength(0); }
  finally { f.stop(); }
});
test('stream exact request charge boundary and installed reserve cannot be bypassed', async () => {
  const f = fixture('streaming');
  try {
    f.setDisks([disk(String(3 * GiB))]); await f.store.put(input());
    const required = streamBase + 5 * f.inserts[0].body.length;
    f.setDisks([disk(String(required), String(15 * GiB), String(required + GiB))]); await f.store.put(input());
    f.setDisks([disk(String(required - 1))]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED');
    f.setDisks([disk(String(3 * GiB), String(15 * GiB - 1))]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED');
    expect(f.inserts).toHaveLength(2);
  } finally { f.stop(); }
});
test('both policies refuse unknown/zero/negative/overflow/multi-disk/inconsistent accounting', async () => {
  for (const mode of ['manual', 'streaming'] as const) {
    const f = fixture(mode);
    try {
      const good = disk(String(100 * GiB));
      const bad = [undefined, '0', '-1', 'NaN', 'Infinity', '9007199254740992', 123, Number.NaN];
      const rowsList = [[], [good, good], [{ ...good, name: 'other' }], [disk('101', '1', '100')],
        ...['free_space', 'unreserved_space', 'keep_free_space'].flatMap(field =>
          bad.filter(v => field !== 'keep_free_space' || v !== '0' || mode === 'streaming').map(v => [{ ...good, [field]: v }]))];
      if (mode === 'manual') rowsList.push([disk(String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER))]);
      for (const rows of rowsList) { f.setDisks(rows); await expect(f.store.put(input())).rejects.toThrow(); }
      expect(f.inserts).toHaveLength(0);
    } finally { f.stop(); }
  }
});
test('one in-flight put per instance; refusal/failure release admission', async () => {
  const f = fixture();
  try {
    const pending = f.store.put(input()); await expect(f.store.put(input())).rejects.toThrow('PUT_IN_FLIGHT'); await pending;
    f.setFree(1); await expect(f.store.put(input())).rejects.toThrow();
    f.setFree(100 * GiB); await f.store.put(input()); expect(f.inserts).toHaveLength(2);
  } finally { f.stop(); }
});

test('manual default retains35GiB floor and separately budgets unreserved overhead/margin', async () => {
  const f = fixture();
  try {
    await f.store.put(input()); const charge = f.inserts[0].body.length;
    const budget = 2 * charge + Math.ceil(2 * charge / 4) + 14 * GiB, physical = 35 * GiB + 2 * charge;
    f.setDisks([disk(String(budget), String(40 * GiB))]); await f.store.put(input());
    f.setDisks([disk(String(budget - 1), String(40 * GiB))]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED');
    f.setDisks([disk(String(physical), '0')]); await f.store.put(input());
    f.setDisks([disk(String(physical - 1), '0')]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED');
    f.setDisks([disk(String(3 * GiB), String(15 * GiB))]); await expect(f.store.put(input())).rejects.toThrow('SPACE_REFUSED');
    expect(f.inserts).toHaveLength(3);
  } finally { f.stop(); }
});

test('numeric real-26.10 response is projected by exact SQL casts, independent of JSON integer settings', async () => {
  const f = fixture('streaming');
  const actual = { name: 'default', free_space: 3300585472, unreserved_space: 3300585472, keep_free_space: 16106127360 };
  const expected = 'SELECT name, toString(free_space) AS free_space, toString(unreserved_space) AS unreserved_space, toString(keep_free_space) AS keep_free_space FROM system.disks\nFORMAT JSONEachRow';
  let seen = '';
  try {
    f.setDisks([actual]);
    f.onDisk(sql => { seen = sql; if (sql === expected) f.setDisks([{ name: actual.name,
      free_space: String(actual.free_space), unreserved_space: String(actual.unreserved_space), keep_free_space: String(actual.keep_free_space) }]); });
    await f.store.put(input()); expect(seen).toBe(expected); expect(f.inserts).toHaveLength(1);
  } finally { f.stop(); }
});
