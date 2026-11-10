import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/fable/io';
import { createHandler } from '../../src/dashboard/server';
import { labelHash } from '../../src/lib/hash';
import { createHmac } from 'node:crypto';

test('real Hub fixture: mutating HTTP switch replay, email join and planted key isolation', async function fixture() {
  const dir = mkdtempSync(tmpdir() + '/dash-fixture-');
  const secrets = ['management-canary-123', 'oauth-canary-456', 'clickhouse-canary-789'];
  const ids = ['claude-a.json', 'claude-b.json'];
  const excluded: Record<string, string[] | null> = Object.fromEntries(ids.map(function entry(id) {
    return [id, null];
  }));
  function persist(id: string) {
    writeFileSync(dir + '/' + id, JSON.stringify({ access_token: secrets[1], excluded_models: excluded[id] }));
  }
  ids.forEach(persist);
  let writes = 0;
  let fail = false;
  const fake = Bun.serve({ port: 0, fetch: async function hubRequest(r) {
    expect(r.headers.get('Authorization')).toBe('Bearer ' + secrets[0]);
    if (fail) return new Response(secrets.join(' '), { status: 500 });
    if (r.method === 'PATCH') {
      const body = await r.json();
      excluded[body.name] = body.excluded_models;
      persist(body.name);
      writes++;
      return Response.json({});
    }
    if (new URL(r.url).pathname.endsWith('/models')) return Response.json({ models: [] });
    return Response.json({ files: ids.map(function observation(id, i) {
      function quota(window: string) {
        return { observed_at: new Date().toISOString(), signals: {
          ['anthropic-ratelimit-unified-' + window + '-utilization']: '0.2',
          ['anthropic-ratelimit-unified-' + window + '-status']: 'allowed',
        } };
      }
      return { id, email: i ? 'b' : 'a', auth_index: 'index-' + i, provider: 'claude',
        account_type: 'oauth', status: 'active', quota: quota('7d'),
        model_quotas: { 'claude-fable-5-2': quota('7d_oi') }, access_token: secrets[1] };
    }) });
  } });
  const hub = new Hub('http://127.0.0.1:' + fake.port, secrets[0], dir);
  const handler = createHandler({ logins: ['owner'], origin: 'https://dash.test', secret: 'csrf', hub,
    path: dir + '/state', events: dir + '/events', ch: { queryJSON: async function query(sql) {
      if (fail) throw Error(secrets[2]);
      return (sql.includes('GROUP BY') ? [{ credential: labelHash('index-0'), model: 'claude-fable-5-2' }] : []) as any;
    } } });
  async function request(path: string, body?: unknown) {
    const response = await handler(new Request('https://dash.test/' + path, {
      method: body ? 'POST' : 'GET', headers: { 'Tailscale-User-Login': 'owner',
        Origin: 'https://dash.test', 'Content-Type': 'application/json',
        'X-CSRF-Token': createHmac('sha256', 'csrf').update('owner').digest('hex') },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const text = await response.text();
    secrets.forEach(function noLeak(secret) { expect(text).not.toContain(secret); });
    return { status: response.status, data: text.startsWith('<') ? {} : JSON.parse(text) };
  }
  try {
    const body = { mode: 'manual', account: 'a', strict: false, spillover: false, opId: 'switch-on' };
    expect((await request('api/switch', body)).status).toBe(200);
    expect(writes).toBe(1);
    expect((await request('api/switch', body)).status).toBe(200);
    expect(writes).toBe(1);
    expect((await request('api/metrics')).data.rows[0].account).toBe('a');
    for (const path of ['', 'api/state', 'api/accounts', 'api/metrics', 'api/burn', 'api/recommendation']) {
      expect((await request(path)).status).toBe(200);
    }
    expect((await request('api/resets', { account: 'a', left: 2, confirmed: true })).status).toBe(200);
    fail = true;
    for (const path of ['api/state', 'api/accounts', 'api/metrics', 'api/burn', 'api/recommendation']) {
      expect((await request(path)).status).toBe(503);
    }
    for (const path of ['switch', 'resets', 'reset-pressed']) {
      expect((await request('api/' + path, { account: 'a', opId: 'error' })).status).toBe(503);
    }
  } finally {
    fake.stop(true);
    rmSync(dir, { recursive: true });
  }
});
