import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readVendors, VENDOR_STALE_MS, vendorReading } from '../../src/usage/vendors';

const now = Date.parse('2026-11-18T10:15:00Z');
// Synthetic T3 provider caches (~/.t3/caches/<instance>.json); shapes copied from T3 Code nightly, values invented.
const auth = { status: 'authenticated', type: 'chatgpt', label: 'ChatGPT Pro', email: 'person@example.invalid', workspaceId: 'ws-synthetic-secret' };
const codex = (instanceId = 'codex', checkedAt = '2026-11-18T10:14:30.000Z', windows: unknown[] = [
  { id: 'primary', kind: 'weekly', label: 'Weekly', usedPercent: 100, windowDurationMins: 10080, resetsAt: '2026-11-20T00:02:00.000Z' },
  { id: 'secondary', kind: 'session', label: '5-hour', usedPercent: 12.5, windowDurationMins: 300, resetsAt: '2026-11-18T13:00:00.000Z' },
]) => ({ driver: 'codex', instanceId, enabled: true, auth, models: [{ slug: 'gpt-x' }], usageLimits: { checkedAt, windows, resetCredits: { availableCount: 1, nextCreditId: 'credit-secret' } } });
const cursor = (checkedAt = '2026-11-18T10:14:50.000Z', resetsAt = '2026-11-18T20:43:56.746Z') => ({ driver: 'cursor', instanceId: 'cursor', enabled: true,
  auth: { status: 'authenticated', type: 'browser', email: 'person@example.invalid', token: 'sk-synthetic' },
  usageLimits: { checkedAt, windows: [
    { id: 'autoPercentUsed', kind: 'monthly', label: 'Cursor Models', usedPercent: 40, windowDurationMins: 10080, resetsAt },
    { id: 'totalPercentUsed', kind: 'monthly', label: 'Overall', usedPercent: 63.25, windowDurationMins: 10080, resetsAt },
  ] } });

test('codex reading reports the binding window with reset, observation and source', () => {
  expect(vendorReading(codex(), now)).toEqual({
    pct: 100, window: '7d', resets_at: '2026-11-20T00:02:00.000Z', observed_at: '2026-11-18T10:14:30.000Z',
    source: 't3-cache:codex', stale: false,
    windows: [
      { id: 'primary', window: '7d', pct: 100, resets_at: '2026-11-20T00:02:00.000Z' },
      { id: 'secondary', window: '5h', pct: 12.5, resets_at: '2026-11-18T13:00:00.000Z' },
    ],
  });
});

test('cursor reading takes the highest window and its billing-cycle reset', () => {
  const r = vendorReading(cursor(), now);
  expect(r).toMatchObject({ pct: 63.25, window: '7d', resets_at: '2026-11-18T20:43:56.746Z', source: 't3-cache:cursor', stale: false });
  expect(r.windows.map(w => w.id)).toEqual(['autoPercentUsed', 'totalPercentUsed']);
});

test('equal percentages bind on the later reset', () => {
  const r = vendorReading(codex('codex', undefined, [
    { id: 'a', kind: 'session', usedPercent: 100, windowDurationMins: 300, resetsAt: '2026-11-18T12:00:00.000Z' },
    { id: 'b', kind: 'weekly', usedPercent: 100, windowDurationMins: 10080, resetsAt: '2026-11-19T12:00:00.000Z' },
  ]), now);
  expect(r).toMatchObject({ pct: 100, window: '7d', resets_at: '2026-11-19T12:00:00.000Z' });
});

test('stale when the observation is older than the threshold or its reset has passed', () => {
  expect(vendorReading(codex('codex', new Date(now - VENDOR_STALE_MS).toISOString()), now).stale).toBe(false);
  expect(vendorReading(codex('codex', new Date(now - VENDOR_STALE_MS - 1).toISOString()), now).stale).toBe(true);
  const passed = vendorReading(codex('codex', undefined, [{ id: 'primary', kind: 'weekly', usedPercent: 100, resetsAt: '2026-11-18T10:00:00.000Z' }]), now);
  expect(passed).toMatchObject({ pct: 100, window: 'weekly', stale: true });
});

test('unavailable or malformed limits publish nulls, never guesses', () => {
  const unavailable = { driver: 'cursor', instanceId: 'cursor', usageLimits: { checkedAt: '2026-11-18T10:14:50.000Z', windows: [], unavailable: { reason: 'unsupported' } } };
  expect(vendorReading(unavailable, now)).toEqual({ pct: null, window: null, resets_at: null, observed_at: '2026-11-18T10:14:50.000Z', source: 't3-cache:cursor', stale: true, windows: [], last_error: 'usage unavailable' });
  for (const usedPercent of [-1, 101, '50', NaN, null]) {
    expect(vendorReading(codex('codex', undefined, [{ id: 'primary', kind: 'weekly', usedPercent }]), now)).toMatchObject({ pct: null, stale: true, last_error: 'usage unavailable' });
  }
  expect(vendorReading(codex('codex', 'yesterday'), now)).toMatchObject({ observed_at: null, stale: true });
  expect(vendorReading({ driver: 'codex', instanceId: '../../etc/passwd', usageLimits: {} }, now).source).toBe('t3-cache');
  expect(vendorReading(null, now)).toMatchObject({ pct: null, stale: true });
});

test('no credential, email, workspace or credit id survives into a reading', () => {
  const text = JSON.stringify([vendorReading(codex(), now), vendorReading(cursor(), now)]);
  expect(text).not.toMatch(/@|sk-|secret|workspace|credit|Bearer/i);
});

test('readVendors prefers the default instance, falls back to the freshest other one, ignores other drivers and junk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlayer-t3-caches-'));
  try {
    await writeFile(join(dir, 'codex-worker.json'), JSON.stringify(codex('codex-worker', '2026-11-18T10:14:59.000Z', [{ id: 'primary', kind: 'weekly', usedPercent: 5, windowDurationMins: 10080, resetsAt: '2026-11-21T00:00:00.000Z' }])));
    await writeFile(join(dir, 'codex.json'), JSON.stringify(codex()));
    await writeFile(join(dir, 'grok.json'), JSON.stringify({ ...cursor(), driver: 'grok', instanceId: 'grok' }));
    await writeFile(join(dir, 'broken.json'), '{not json');
    await mkdir(join(dir, 'worktree-checkouts'));
    const v = await readVendors(dir, now);
    expect(v.codex).toMatchObject({ pct: 100, source: 't3-cache:codex', stale: false });
    expect(v.cursor).toEqual({ pct: null, window: null, resets_at: null, observed_at: null, source: 't3-cache', stale: true, windows: [], last_error: 'no T3 usage cache' });

    await rm(join(dir, 'codex.json'));
    await writeFile(join(dir, 'codex-eval.json'), JSON.stringify(codex('codex-eval', '2026-11-18T10:10:00.000Z')));
    await writeFile(join(dir, 'cursor.json'), JSON.stringify(cursor()));
    const w = await readVendors(dir, now);
    expect(w.codex).toMatchObject({ pct: 5, source: 't3-cache:codex-worker', observed_at: '2026-11-18T10:14:59.000Z' });
    expect(w.cursor).toMatchObject({ pct: 63.25, source: 't3-cache:cursor' });
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect((await readVendors(join(dir, 'missing'), now)).codex.last_error).toBe('no T3 usage cache');
});

test('writer publishes vendors next to unchanged Claude keys, even during a hub outage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenlayer-vendors-'));
  try {
    await mkdir(join(home, '.t3/caches'), { recursive: true });
    const fresh = new Date().toISOString();
    await writeFile(join(home, '.t3/caches/codex.json'), JSON.stringify(codex('codex', fresh)));
    await writeFile(join(home, '.t3/caches/cursor.json'), JSON.stringify(cursor(fresh, new Date(Date.now() + 86_400_000).toISOString())));
    const preload = join(home, 'offline.ts');
    await writeFile(preload, "Bun.spawn = (() => ({ stdout: new Blob(['']).stream(), exited: Promise.resolve(1), kill() {} })) as typeof Bun.spawn;\n");
    const proc = Bun.spawn([process.execPath, '--preload', preload, resolve('src/usage/main.ts')], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(out + err).toBe('');
    const text = await readFile(join(home, '.config/tokenlayer/usage.json'), 'utf8');
    const value = JSON.parse(text);
    expect(value).toMatchObject({ generated_at: null, source: 'cliproxy-hub', stale: true, accounts: [], last_error: 'hub unavailable' });
    expect(value.vendors.codex).toMatchObject({ pct: 100, window: '7d', observed_at: fresh, source: 't3-cache:codex', stale: false });
    expect(value.vendors.cursor).toMatchObject({ pct: 63.25, source: 't3-cache:cursor', stale: false });
    expect(text).not.toMatch(/@|sk-|secret|workspace/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Shapes copied from the M4's T3 caches on 2026-11-19 (keys only); values invented.
const antigravity = (checkedAt = '2026-11-18T10:14:40.000Z') => ({ driver: 'antigravity', instanceId: 'antigravity', enabled: true,
  auth: { status: 'authenticated', type: 'google', label: 'Google AI Pro' },
  usageLimits: { checkedAt, credentialFingerprint: 'f'.repeat(64), windows: [
    { id: '3p-5h', kind: 'session', label: 'Third-party models (5 hours)', usedPercent: 0, windowDurationMins: 300 },
    { id: 'gemini-5h', kind: 'session', label: 'Gemini models (5 hours)', usedPercent: 0.3, windowDurationMins: 300, resetsAt: '2026-11-18T14:42:12.000Z' },
    { id: '3p-weekly', kind: 'weekly', label: 'Third-party models (weekly)', usedPercent: 100, windowDurationMins: 10080, resetsAt: '2026-11-25T00:26:21.000Z' },
  ] } });
const kiro = { driver: 'kiro', instanceId: 'kiro', enabled: true, installed: true, version: '1.0.0', status: 'ready', checkedAt: '2026-11-18T10:14:45.000Z',
  auth: { status: 'authenticated', label: 'Builder ID', email: 'person@example.invalid' }, setup: { canAuthenticate: true, canInstall: true },
  models: [{ slug: 'claude-x' }], versionAdvisory: { status: 'current' } };

test('readVendors publishes Antigravity limits and a Kiro placeholder that says why it is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlayer-t3-caches-'));
  try {
    await writeFile(join(dir, 'antigravity.json'), JSON.stringify(antigravity()));
    await writeFile(join(dir, 'kiro.json'), JSON.stringify(kiro));
    const v = await readVendors(dir, now);
    expect(Object.keys(v)).toEqual(['codex', 'cursor', 'antigravity', 'kiro']);
    expect(v.antigravity).toEqual({ pct: 100, window: '7d', resets_at: '2026-11-25T00:26:21.000Z', observed_at: '2026-11-18T10:14:40.000Z',
      source: 't3-cache:antigravity', stale: false, windows: [
        { id: '3p-5h', window: '5h', pct: 0, resets_at: null },
        { id: 'gemini-5h', window: '5h', pct: 0.3, resets_at: '2026-11-18T14:42:12.000Z' },
        { id: '3p-weekly', window: '7d', pct: 100, resets_at: '2026-11-25T00:26:21.000Z' },
      ] });
    expect(v.kiro).toEqual({ pct: null, window: null, resets_at: null, observed_at: null, source: 't3-cache:kiro', stale: true, windows: [],
      last_error: 'usage unavailable',
      note: 'no usageLimits, only auth,checkedAt,driver,enabled,installed,instanceId,models,setup,status,version,versionAdvisory' });
    expect(JSON.stringify(v)).not.toMatch(/@|fingerprint|f{64}|Builder|Google AI/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
