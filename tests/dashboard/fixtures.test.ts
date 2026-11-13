import { fakeHub, state } from "../fable/fixtures";
import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/fable/io';
import { createHandler } from '../../src/dashboard/server';
import { ClickHouse } from '../../src/lib/clickhouse';
import { labelHash } from '../../src/lib/hash';
import { createHmac } from 'node:crypto';

test('real Hub fixture: mutating HTTP switch replay, email join and planted key isolation', async function fixture() {
  const dir = mkdtempSync(tmpdir() + '/dash-fixture-');
  const secrets = ['sk-mgmt-' + 'x'.repeat(48), 'sk-ant-oat01-' + 'y'.repeat(80), 'sk-' + 'z'.repeat(48)];
  const fixture = fakeHub();
  writeFileSync(dir + '/state', JSON.stringify(state()));
  writeFileSync(dir + '/events', JSON.stringify({ stage: 'reset-recovery', index: 'private-index-fixture' }) + '\n');
  let writes = 0;
  let fail = false;
  const fake = Bun.serve({ port: 0, fetch: async function hubRequest(r) {
    if (new URL(r.url).pathname === '/') {
      expect(r.headers.get('X-ClickHouse-Key')).toBe(secrets[2]);
      if (fail) return new Response(secrets.join(' '), { status: 500 });
      const sql = await r.text();
      if (sql.includes('UNION ALL')) return new Response([0.2, 0.4].map((u, i) => JSON.stringify({
        credential: labelHash('a'), window: 'weekly', ts: '2026-11-10 0' + i + ':00:00',
        utilization: u })).join('\n'));
      return new Response(sql.includes('GROUP BY')
        ? JSON.stringify({ credential: labelHash('a'), model: 'claude-fable-5-2' }) + '\n' : '');
    }
    expect(r.headers.get('Authorization')).toBe('Bearer ' + secrets[0]);
    if (fail) return new Response(secrets.join(' '), { status: 500 });
    if (r.method === 'PATCH') {
      const body = await r.json();
      await fixture.patch(body.name, body);
      writes++;
      return Response.json({});
    }
    const url = new URL(r.url);
    if (url.pathname.endsWith('/models')) return Response.json({
      models: (await fixture.catalog(url.searchParams.get('name')!)).map(id => ({ id })) });
    if (url.pathname.includes('model-definitions')) return Response.json({
      models: (await fixture.registry()).map(id => ({ id })) });
    return Response.json({ files: (await fixture.observations()).map(c => ({ ...c,
      provider: 'claude', account_type: 'oauth', access_token: secrets[1] })) });
  } });
  const hub = new Hub('http://127.0.0.1:' + fake.port, secrets[0]);
  const handler = createHandler({ logins: ['owner'], origin: 'https://dash.test', secret: 'csrf', hub,
    path: dir + '/state', events: dir + '/events', ch: new ClickHouse({ url: 'http://127.0.0.1:' + fake.port,
      user: 'fixture', password: secrets[2], database: 'tokenlayer' }) });
  const output: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation(function capture(chunk: any) {
    output.push(String(chunk)); return true;
  });
  const stderr = spyOn(process.stderr, 'write').mockImplementation(function capture(chunk: any) {
    output.push(String(chunk)); return true;
  });
  async function request(path: string, body?: unknown) {
    const response = await handler(new Request('https://dash.test/' + path, {
      method: body ? 'POST' : 'GET', headers: { 'Tailscale-User-Login': 'owner',
        Origin: 'https://dash.test', 'Content-Type': 'application/json',
        'X-CSRF-Token': createHmac('sha256', 'csrf').update('owner').digest('hex') },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const text = await response.text();
    secrets.forEach(function noLeak(secret) { expect(text).not.toContain(secret); });
    if (path === 'api/state' || path.startsWith('api/switch')) {
      expect(text).not.toContain('private-index-fixture');
      expect(text).not.toContain('auth_index'); expect(text).not.toContain('baseline');
    }
    return { status: response.status, data: text.startsWith('<') ? {} : JSON.parse(text) };
  }
  try {
    const body = { on: true, account: 'a', strict: false, spillover: false, opId: 'switch-on' };
    expect((await request('api/switch', body)).status).toBe(200);
    expect(writes).toBe(3);
    expect((await request('api/switch', body)).status).toBe(200);
    expect(writes).toBe(3);
    expect((await request('api/metrics')).data.rows[0].account).toBe('a');
    const burn = (await request('api/burn')).data;
    expect(burn.rows[0].account).toBe('a');
    expect(burn.projections[0].perHour).toBeCloseTo(0.2);
    for (const path of ['', 'api/state', 'api/accounts', 'api/metrics', 'api/burn', 'api/recommendation']) {
      expect((await request(path)).status).toBe(200);
    }
    const auto = await request('api/switch', { on: true, account: 'a', opId: 'auto-default' });
    expect(auto.data.state.spillover).toBe('auto');
    expect((await request('api/resets', { account: 'a', left: 2, confirmed: true })).status).toBe(200);
    fail = true;
    for (const path of ['api/state', 'api/accounts', 'api/metrics', 'api/burn', 'api/recommendation']) {
      expect((await request(path)).status).toBe(path === 'api/state' ? 200 : 503);
    }
    for (const path of ['switch', 'resets', 'reset-pressed']) {
      expect((await request('api/' + path, { account: 'a', on: true, opId: 'error' })).status).toBe(503);
    }
    const off = await request('api/switch', { on: false, account: 'a' });
    expect(off.status).toBe(503);
    expect(off.data.state.requested.mode).toBe('off');
    expect(off.data.reason).toBe('hub HTTP 500');
    expect(off.data.error).toBe('hub HTTP 500');
    fake.stop(true);
    const offline = await request('api/switch', { on: false, account: 'a' });
    expect(offline.status).toBe(202);
    expect(offline.data.reason).toBe('OFF saved; applies when the hub is reachable');
    for (const secret of secrets) expect(output.join('')).not.toContain(secret);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    fake.stop(true);
    rmSync(dir, { recursive: true });
  }
});
