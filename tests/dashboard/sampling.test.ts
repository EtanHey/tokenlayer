import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHandler } from '../../src/dashboard/server';
import { page } from '../../src/dashboard/page';
import { Hub } from '../../src/fable/io';
import { fakeHub, state } from '../fable/fixtures';
import { labelHash } from '../../src/lib/hash';

test('sampling persists, dedupes concurrent GETs, caps history and ignores proxied intervals', async () => {
  const dir = mkdtempSync(tmpdir() + '/outside-fixture-');
  const fixture = fakeHub();
  writeFileSync(dir + '/state', JSON.stringify(state()));
  let at = Date.now() - 100000;
  let requests = 0;
  let samples = 0;
  const fake = Bun.serve({ port: 0, fetch: async r => {
    const url = new URL(r.url);
    if (url.pathname.endsWith('/models')) return Response.json({
      models: (await fixture.catalog(url.searchParams.get('name')!)).map(id => ({ id })) });
    return Response.json({ files: fixture.obs.map(c => ({ ...c, provider: 'claude', account_type: 'oauth' })) });
  } });
  const hub = new Hub('http://127.0.0.1:' + fake.port, 'fixture');
  const ch = { queryJSON: async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('count() AS requests') && !sql.includes('GROUP BY')) {
      samples++;
      await Promise.resolve();
      return [{ requests }] as T[];
    }
    return [{ session_id: 'fixture-session', credentials: [labelHash('a')], requests: 3,
      tokens: 100, output_tokens: 20, fable_pct: 50, machine: 'fixture', project: 'project' }] as T[];
  } };
  const make = () => createHandler({ logins: ['owner'], origin: 'https://dash.test', secret: 'fixture',
    hub, ch, path: dir + '/state' });
  let handler = make();
  const get = (path = 'accounts') => handler(new Request('https://dash.test/api/' + path, {
    headers: { 'Tailscale-User-Login': 'owner' } }));
  function advance(u: number) {
    at += 1000;
    const q = fixture.obs[0].quota!;
    q.observed_at = new Date(at).toISOString();
    q.signals!['Anthropic-Ratelimit-Unified-7d-Utilization'] = String(u);
  }
  try {
    advance(.2);
    expect((await get()).status).toBe(200);
    handler = make(); // next interval must survive handler recreation
    advance(.3);
    await Promise.all([get(), get('recommendation')]);
    const accounts = await (await get()).json();
    expect(accounts[0].outside).toHaveLength(1);
    expect(accounts[0].outside[0].delta).toBeCloseTo(10);
    expect(samples).toBe(1);
    expect(statSync(dir + '/outside-use.json').mode & 0o777).toBe(0o600);
    handler = make();
    expect((await (await get()).json())[0].outside).toHaveLength(1);
    requests = 1;
    advance(.4);
    expect((await (await get()).json())[0].outside).toHaveLength(1);
    requests = 0;
    for (let i = 0; i < 22; i++) { advance(.41 + i / 100); await get(); }
    expect((await (await get()).json())[0].outside).toHaveLength(20);
    expect((await get('sessions?window=12h')).status).toBe(400);
    for (const window of ['3h', '24h']) {
      const sessions = await (await get('sessions?window=' + window)).json();
      expect(sessions.rows[0]).toMatchObject({ requests: 3, tokens: 100, output_tokens: 20,
        fable_pct: 50, accounts: ['a'], project: 'project' });
    }
  } finally { fake.stop(true); rmSync(dir, { recursive: true }); }
});

test('page includes both complete plain-language explanations and unknown-count policy', () => {
  const text = page('fixture').replace(/\s+/g, ' ');
  expect(text).toContain("Before today, when one account used up its Fable allowance, the proxy wrongly paused " +
    "that whole account, and with your other account already used up, every Claude request on both Macs would " +
    "have failed. Now only Fable pauses on that account; Opus, Sonnet and Haiku keep working.");
  expect(text).toContain("The old proxy key had been printed into an agent's log, so anyone who could read " +
    "that log could have used your Claude accounts through the proxy; it has now been switched off. " +
    "It had to wait only until every running app had moved to the new key, and the logs showed they all " +
    "moved within seconds, so there was no need to wait for Thursday.");
  expect(text).toContain('count unknown: waiting; confirm your reset count to allow spill');
});

test('a corrupt outside-use.json never stops the dashboard from starting', () => {
  const dir = mkdtempSync(tmpdir() + '/outside-corrupt-');
  writeFileSync(dir + '/state', JSON.stringify(state()));
  writeFileSync(dir + '/outside-use.json', '{not json');
  const hub = new Hub('http://127.0.0.1:9', 'fixture');
  const ch = { queryJSON: async <T>(): Promise<T[]> => [] as T[] };
  try {
    expect(() => createHandler({ logins: ['owner'], origin: 'https://dash.test', secret: 'fixture',
      hub, ch, path: dir + '/state' })).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
