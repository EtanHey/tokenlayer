import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
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
      assistant('multi', 28, '/x/repo-a/.worktrees/branch', 'model-b'),
      assistant('multi', 28, '/x/repo-a', 'model-b'),
      assistant('multi', 29, '/x/repo-a', 'model-a'),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'other.jsonl'), [assistant('other', 29, '/x/repo-b', 'model-b')].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(claude, 'empty.jsonl'), JSON.stringify(assistant('empty', 29, '/x/repo-b', '')) + '\n');
    for (const id of ['parent', 'child']) writeFileSync(join(codex, `${id}.jsonl`), [
      { type: 'session_meta', timestamp: '2026-10-29T12:00:00Z', payload: { id, session_id: 'parent', cwd: '/x/repo-b' } },
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
      { day: '2026-10-29', repo: 'repo-b', model: 'model-a', harness: 'codex', machine: 'm4', sessions: 2 },
      { day: '2026-10-29', repo: 'repo-b', model: 'model-b', harness: 'claude', machine: 'm4', sessions: 1 },
    ]);
    expect((await ch.client.queryJSON<{ name: string }>('DESCRIBE tokenlayer.v_sessions_daily')).map(r => r.name)).toEqual(['day', 'repo', 'model', 'harness', 'machine', 'sessions']);
    await applySchema(ch.client);
    expect(await ch.client.queryJSON('SELECT * FROM tokenlayer.v_sessions_daily ORDER BY day, repo, model, harness, machine')).toEqual(rows);
  } finally { await ch.stop(); }
}, 40000);
