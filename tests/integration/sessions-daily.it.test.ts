import { FIXTURE_HOME, recentDay } from "../support/recent-day";
import { expect } from 'bun:test';
import { test } from '../support/clickhouse-gate';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { repoCwds } from '../fixtures/repo-cwds';
import { KNOWN_REPOS } from '../../src/lib/repo';
import { parseLine } from '../../src/ship/parse';
import { shipOnce } from '../../src/ship/ship';

test('daily sessions: normalized repos, per-event models, native child ids and replay', async () => {
  const ch = await startLocalClickHouse({ prepare: applySchema });
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.local/daily-'));
  try {
    const claude = join(dir, 'claude'); const codex = join(dir, 'codex');
    mkdirSync(claude); mkdirSync(codex);
    const assistant = (sessionId: string, daysAgo: number, repo: string, model: string) => ({
      type: 'assistant', sessionId, cwd: repo, timestamp: `${recentDay(daysAgo)}T12:00:00Z`,
      message: { role: 'assistant', model },
    });
    writeFileSync(join(claude, 'multi.jsonl'), [
      assistant('multi', 3, `${FIXTURE_HOME}/.t3/worktrees/repo-a/branch`, 'model-a'),
      assistant('multi', 3, `${FIXTURE_HOME}/Gits/repo-a/.worktrees/branch`, 'model-b'),
      assistant('multi', 3, `${FIXTURE_HOME}/Gits/repo-a`, 'model-b'),
      assistant('multi', 2, `${FIXTURE_HOME}/Gits/repo-a`, 'model-a'),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'other.jsonl'), [assistant('other', 2, `${FIXTURE_HOME}/Gits/repo-b`, 'model-b')].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'empty.jsonl'), JSON.stringify(assistant('empty', 2, `${FIXTURE_HOME}/Gits/repo-b`, '')) + '\n');
    writeFileSync(join(claude, 'lab.jsonl'), JSON.stringify(assistant('lab', 1, `${FIXTURE_HOME}/Gits/VoiceLayer-Lab.noindex/2026-10-30/exploration/code`, 'model-a')) + '\n');
    for (const id of ['parent', 'child']) writeFileSync(join(codex, `${id}.jsonl`), [
      { type: 'session_meta', timestamp: `${recentDay(2)}T12:00:00Z`, payload: { id, session_id: 'parent', cwd: `${FIXTURE_HOME}/Gits/repo-b` } },
      { type: 'turn_context', timestamp: `${recentDay(2)}T12:01:00Z`, payload: { model: 'model-a' } },
      { type: 'event_msg', timestamp: `${recentDay(2)}T12:02:00Z`, payload: { type: 'fixture' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const opts = { machine: 'm4', roots: [{ kind: 'claude' as const, dir: claude }, { kind: 'codex' as const, dir: codex }], clickhouse: ch.client, statePath: join(dir, 'state'), rateBytesPerSec: 0 };
    await shipOnce(opts);
    // Replay with a second checkpoint: FINAL must still count once.
    await shipOnce({ ...opts, statePath: join(dir, 'replay') });
    const rows = await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, repo, model, harness, machine');
    expect(rows).toEqual([
      { day: recentDay(3), repo: 'repo-a', model: 'model-a', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: recentDay(3), repo: 'repo-a', model: 'model-b', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: recentDay(2), repo: 'repo-a', model: 'model-a', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: recentDay(2), repo: 'repo-b', model: '(none)', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: recentDay(2), repo: 'repo-b', model: 'model-a', harness: 'codex', machine: 'm4', sessions: 2 },
      { day: recentDay(2), repo: 'repo-b', model: 'model-b', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: recentDay(1), repo: 'VoiceLayer-Lab', model: 'model-a', harness: 'claude', machine: 'm4', sessions: 1 },
    ]);
    expect((await ch.client.queryJSON<{ name: string }>('DESCRIBE tokenlayer.v_sessions_daily')).map(r => r.name)).toEqual(['day', 'repo', 'model', 'harness', 'machine', 'sessions']);
    await applySchema(ch.client);
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, repo, model, harness, machine')).toEqual(rows);
  } finally { await ch.stop(); }
}, 40000);

test('daily sessions: (none) only for sessions without a model that day', async () => {
  const ch = await startLocalClickHouse({ prepare: applySchema });
  try {
    const cases: [string, string, number, string][] = [
      ['mixed', 'claude', 3, ''],
      ['mixed', 'claude', 3, 'model-a'],
      ['mixed', 'claude', 3, 'model-a'],
      ['mixed', 'claude', 3, ''],
      ['model-less', 'antigravity', 3, ''],
      ['model-less', 'antigravity', 3, ''],
      ['two-models', 'claude', 3, ''],
      ['two-models', 'claude', 3, 'model-a'],
      ['two-models', 'claude', 3, 'model-b'],
      ['two-models', 'claude', 3, 'model-b'],
      ['two-days', 'codex', 3, ''],
      ['two-days', 'codex', 3, ''],
      ['two-days', 'codex', 2, ''],
      ['two-days', 'codex', 2, 'model-c'],
      ['two-days', 'codex', 2, 'model-c'],
    ];
    await ch.client.insert('session_events', cases.map(([sessionId, harness, daysAgo, model], i) => ({
      ...parseLine(JSON.stringify({ type: 'assistant', sessionId, cwd: '/Users/test/Gits/tokenlayer',
        timestamp: `${recentDay(daysAgo)}T12:00:00Z`, message: { role: 'assistant', model } })),
      harness, machine: 'fixture', path: `/synthetic/${sessionId}.jsonl`, generation: 'fixture',
      byte_offset: i, content_hash: `line-${i}`, line_bytes: 1,
    })));
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, model, harness')).toEqual([
      { day: recentDay(3), repo: 'tokenlayer', model: '(none)', harness: 'antigravity', machine: 'fixture', sessions: 1 },
      { day: recentDay(3), repo: 'tokenlayer', model: '(none)', harness: 'codex', machine: 'fixture', sessions: 1 },
      { day: recentDay(3), repo: 'tokenlayer', model: 'model-a', harness: 'claude', machine: 'fixture', sessions: 2 },
      { day: recentDay(3), repo: 'tokenlayer', model: 'model-b', harness: 'claude', machine: 'fixture', sessions: 1 },
      { day: recentDay(2), repo: 'tokenlayer', model: 'model-c', harness: 'codex', machine: 'fixture', sessions: 1 },
    ]);
  } finally { await ch.stop(); }
}, 40000);

test('existing archive and ship rows normalize from cwd; slug fallback never overrides recorded cwd', async () => {
  const ch = await startLocalClickHouse({ prepare: applySchema });
  try {
    const cases = [
      ...repoCwds.map(([cwd, repo]) => ({ cwd, repo, path: '/synthetic/ship.jsonl', debug: cwd.replace(/\/+$/, '').split('/').at(-1) ?? '' })),
      ...KNOWN_REPOS.map(repo => ({ cwd: '', repo, path: `/Users/happycampr/.claude/projects/-Users-happycampr-Gits-${repo.toUpperCase().replace(/[^A-Z0-9-]/g, '-')}-src/id.jsonl`, debug: `-Users-happycampr-Gits-${repo.toUpperCase().replace(/[^A-Z0-9-]/g, '-')}-src` })),
      { cwd: '', repo: 'golems-rig', path: '/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-golems-rig-hooks/id.jsonl', debug: '-Users-etanheyman-Gits-golems-rig-hooks' },
      { cwd: '', repo: 'skill-creator', path: '/Users/etanheyman/.claude/projects/-Users-etanheyman--t3-worktrees-skill-creator-t3-xxxx/id.jsonl', debug: '-Users-etanheyman--t3-worktrees-skill-creator-t3-xxxx' },
      { cwd: '', repo: '(other)', path: '/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-unknown-repo-src/id.jsonl', debug: '-Users-etanheyman-Gits-unknown-repo-src' },
      { cwd: '', repo: '(other)', path: '-Users-etanheyman-Gits-golemsish-src', debug: '-Users-etanheyman-Gits-golemsish-src' },
      { cwd: '/x/unknown', repo: '(other)', path: '/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-golems/id.jsonl', debug: 'unknown' },
      { cwd: '/Users/happycampr/Gits/tokenlayer/src', repo: 'tokenlayer', path: '/Users/happycampr/.claude/projects/-Users-happycampr-Gits-golems/id.jsonl', debug: 'src' },
    ];
    const rows = cases.flatMap((c, i) => ['m4', 'm1'].map(machine => ({
      ...parseLine(JSON.stringify({ type: 'assistant', sessionId: `fixture-${i}`, cwd: c.cwd,
        timestamp: `${recentDay(1)}T06:48:00Z`, message: { role: 'assistant', model: `fixture-${i}` } })),
      // Deliberately retain the old wrong project value; query-time attribution must repair it.
      project: c.debug, machine, harness: machine === 'm4' ? 'claude' : 't3',
      path: `${machine === 'm4' ? '' : 'archive://fixture/'}${c.path}`, generation: 'fixture',
      byte_offset: i, content_hash: `fixture-${i}`, line_bytes: 1,
    })));
    await ch.client.insert('session_events', rows);
    const archived = await ch.client.queryJSON('SELECT * FROM tokenlayer.session_events FINAL ORDER BY machine, byte_offset');
    await applySchema(ch.client);
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.session_events FINAL ORDER BY machine, byte_offset')).toEqual(archived);
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY model, machine')).toEqual(
      cases.flatMap((c, i) => ['m1', 'm4'].map(machine => ({ day: recentDay(1), repo: c.repo,
        model: `fixture-${i}`, harness: machine === 'm4' ? 'claude' : 't3', machine, sessions: 1 })))
        .sort((a, b) => a.model.localeCompare(b.model) || a.machine.localeCompare(b.machine)),
    );
    expect(await ch.client.queryJSON('SELECT project, cwd_basename FROM tokenlayer.v_session_events_context ORDER BY model, machine')).toEqual(
      cases.flatMap((c, i) => ['m1', 'm4'].map(machine => ({ model: `fixture-${i}`, machine, project: c.repo, cwd_basename: c.debug })))
        .sort((a, b) => a.model.localeCompare(b.model) || a.machine.localeCompare(b.machine))
        .map(({ project, cwd_basename }) => ({ project, cwd_basename })),
    );
  } finally { await ch.stop(); }
}, 40000);

test('a later recorded cwd suppresses slug fallback for the whole source stream', async () => {
  const ch = await startLocalClickHouse({ prepare: applySchema });
  try {
    const path = '/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-golems/id.jsonl';
    await ch.client.insert('session_events', ['', '/Users/etanheyman/Gits/tokenlayer/src', ''].map((cwd, i) => ({
      ...parseLine(JSON.stringify({ type: 'assistant', sessionId: 'later-cwd', cwd,
        timestamp: `${recentDay(1)}T06:48:00Z`, message: { role: 'assistant', model: 'fixture' } })),
      machine: 'm4', harness: 'claude', path, generation: 'fixture', byte_offset: i, content_hash: `line-${i}`, line_bytes: 1,
    })));
    expect(await ch.client.queryJSON('SELECT project, cwd_basename FROM tokenlayer.v_session_events_context ORDER BY byte_offset')).toEqual([
      { project: '(other)', cwd_basename: '' }, { project: 'tokenlayer', cwd_basename: 'src' }, { project: 'tokenlayer', cwd_basename: 'src' },
    ]);
  } finally { await ch.stop(); }
}, 40000);
