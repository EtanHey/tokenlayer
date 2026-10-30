import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { repoCwds } from '../fixtures/repo-cwds';
import { KNOWN_REPOS } from '../../src/lib/repo';
import { parseLine } from '../../src/ship/parse';
import { shipOnce } from '../../src/ship/ship';

test('daily sessions: normalized repos, per-event models, native child ids and replay', async () => {
  const ch = await startLocalClickHouse();
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.local/daily-'));
  try {
    await applySchema(ch.client);
    const claude = join(dir, 'claude'); const codex = join(dir, 'codex');
    mkdirSync(claude); mkdirSync(codex);
    const assistant = (sessionId: string, day: number, repo: string, model: string) => ({
      type: 'assistant', sessionId, cwd: repo, timestamp: `2026-10-${day}T12:00:00Z`,
      message: { role: 'assistant', model },
    });
    writeFileSync(join(claude, 'multi.jsonl'), [
      assistant('multi', 28, '/Users/test/.t3/worktrees/repo-a/branch', 'model-a'),
      assistant('multi', 28, '/Users/etanheyman/Gits/repo-a/.worktrees/branch', 'model-b'),
      assistant('multi', 28, '/Users/etanheyman/Gits/repo-a', 'model-b'),
      assistant('multi', 29, '/Users/etanheyman/Gits/repo-a', 'model-a'),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'other.jsonl'), [assistant('other', 29, '/Users/happycampr/Gits/repo-b', 'model-b')].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'empty.jsonl'), JSON.stringify(assistant('empty', 29, '/Users/happycampr/Gits/repo-b', '')) + '\n');
    for (const id of ['parent', 'child']) writeFileSync(join(codex, `${id}.jsonl`), [
      { type: 'session_meta', timestamp: '2026-10-29T12:00:00Z', payload: { id, session_id: 'parent', cwd: '/Users/happycampr/Gits/repo-b' } },
      { type: 'turn_context', timestamp: '2026-10-29T12:01:00Z', payload: { model: 'model-a' } },
      { type: 'event_msg', timestamp: '2026-10-29T12:02:00Z', payload: { type: 'fixture' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const opts = { machine: 'm4', roots: [{ kind: 'claude' as const, dir: claude }, { kind: 'codex' as const, dir: codex }], clickhouse: ch.client, statePath: join(dir, 'state'), rateBytesPerSec: 0 };
    await shipOnce(opts);
    // Replay with a second checkpoint: FINAL must still count once.
    await shipOnce({ ...opts, statePath: join(dir, 'replay') });
    const rows = await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, repo, model, harness, machine');
    expect(rows).toEqual([
      { day: '2026-10-28', repo: 'repo-a', model: 'model-a', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: '2026-10-28', repo: 'repo-a', model: 'model-b', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: '2026-10-29', repo: 'repo-a', model: 'model-a', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: '2026-10-29', repo: 'repo-b', model: '(none)', harness: 'claude', machine: 'm4', sessions: 1 },
      { day: '2026-10-29', repo: 'repo-b', model: '(none)', harness: 'codex', machine: 'm4', sessions: 2 },
      { day: '2026-10-29', repo: 'repo-b', model: 'model-a', harness: 'codex', machine: 'm4', sessions: 2 },
      { day: '2026-10-29', repo: 'repo-b', model: 'model-b', harness: 'claude', machine: 'm4', sessions: 1 },
    ]);
    expect((await ch.client.queryJSON<{ name: string }>('DESCRIBE tokenlayer.v_sessions_daily')).map(r => r.name)).toEqual(['day', 'repo', 'model', 'harness', 'machine', 'sessions']);
    await applySchema(ch.client);
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, repo, model, harness, machine')).toEqual(rows);
  } finally { await ch.stop(); }
}, 40000);

test('existing archive and ship rows normalize from cwd; slug fallback never overrides recorded cwd', async () => {
  const ch = await startLocalClickHouse();
  try {
    await applySchema(ch.client);
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
        timestamp: '2026-10-30T06:48:00Z', message: { role: 'assistant', model: `fixture-${i}` } })),
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
      cases.flatMap((c, i) => ['m1', 'm4'].map(machine => ({ day: '2026-10-30', repo: c.repo,
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
  const ch = await startLocalClickHouse();
  try {
    await applySchema(ch.client);
    const path = '/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-golems/id.jsonl';
    await ch.client.insert('session_events', ['', '/Users/etanheyman/Gits/tokenlayer/src', ''].map((cwd, i) => ({
      ...parseLine(JSON.stringify({ type: 'assistant', sessionId: 'later-cwd', cwd,
        timestamp: '2026-10-30T06:48:00Z', message: { role: 'assistant', model: 'fixture' } })),
      machine: 'm4', harness: 'claude', path, generation: 'fixture', byte_offset: i, content_hash: `line-${i}`, line_bytes: 1,
    })));
    expect(await ch.client.queryJSON('SELECT project, cwd_basename FROM tokenlayer.v_session_events_context ORDER BY byte_offset')).toEqual([
      { project: '(other)', cwd_basename: '' }, { project: 'tokenlayer', cwd_basename: 'src' }, { project: 'tokenlayer', cwd_basename: 'src' },
    ]);
  } finally { await ch.stop(); }
}, 40000);
