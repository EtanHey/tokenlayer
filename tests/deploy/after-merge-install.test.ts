import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drift, orderProblems, plan, prelude, quote, run, type Exec, type Kind, type Mac, type Options } from '../../scripts/after-merge-install';

const o: Options = { sha: 'a'.repeat(40), stamp: '20261120T000000Z', clickhouse: '.local/bin/clickhouse-test' };
const ids = (opts = o) => plan(opts).map(s => s.id);
const at = (id: string, opts = o) => ids(opts).indexOf(id);

type Call = { mac: Mac; kind: Kind; id: string; script: string };
/** Commands mocked: every call is recorded; `answer` picks the exit code (default: nothing in place, everything passes). */
function mock(answer: (c: Call) => number | undefined = () => undefined) {
  const calls: Call[] = [];
  const exec: Exec = async (mac, script, kind, id) => {
    const c = { mac, kind, id, script };
    calls.push(c);
    const code = answer(c) ?? (kind === 'probe' && script.includes('$MARK/') && !script.includes('touch') ? 1 : 0);
    return { code, out: '' };
  };
  return { calls, exec };
}
const lines: string[] = [];
const quiet = { log: (l: string) => lines.push(l), self: '/repo' };

describe('order', () => {
  test('every dependency runs before the step that needs it', () => {
    expect(orderProblems(plan(o))).toEqual([]);
    expect(orderProblems(plan({ ...o, clickhouseWindow: true }))).toEqual([]);
  });
  test('a plan out of order is reported', () => {
    const steps = plan(o);
    const swapped = [steps[1], steps[0], ...steps.slice(2)];
    expect(orderProblems(swapped)).toEqual([]); // the two preflights are independent
    const bad = steps.filter(s => s.id !== 'm1-schema');
    bad.push(steps.find(s => s.id === 'm1-schema')!);
    expect(orderProblems(bad)).toContain('m1-ship runs before m1-schema');
  });
  test("the receipts' order: config, tables, both ships, then the ratchet snapshot; drift last on each Mac", () => {
    expect(at('m1-pin')).toBeLessThan(at('m1-clickhouse-config'));
    expect(at('m1-clickhouse-config')).toBeLessThan(at('m1-schema')); // R5: the views fit only with the reader profile
    expect(at('m1-schema')).toBeLessThan(at('m1-ship')); // H1: table before ship code
    expect(at('m1-schema')).toBeLessThan(at('m4-ship'));
    expect(at('m4-writer-env')).toBeLessThan(at('m4-ship')); // R6
    expect(at('m1-ship')).toBeLessThan(at('m1-ratchet-live')); // H1: ship code on both Macs before the snapshot
    expect(at('m4-ship')).toBeLessThan(at('m1-ratchet-live'));
    expect(at('m4-usage-bundle')).toBeLessThan(at('m4-usage-plist'));
    for (const mac of ['m1', 'm4'] as const) {
      const own = plan(o).filter(s => s.mac === mac).map(s => s.id);
      expect(own.at(-1)).toBe(`${mac}-drift`);
      expect(own.indexOf(`${mac}-checkout`)).toBeLessThan(own.indexOf(`${mac}-pin`));
      for (const id of own.filter(i => /-(ship|drain|fable|dashboard|hubupdate|bundle|plist|ratchet-live|writer-env)/.test(i)))
        expect(own.indexOf(`${mac}-pin`)).toBeLessThan(own.indexOf(id));
    }
  });
  test('the ClickHouse job is repointed only in an approved window, and only after the writers moved', () => {
    expect(ids()).not.toContain('m1-clickhouse');
    const w = { ...o, clickhouseWindow: true };
    expect(at('m1-clickhouse', w)).toBeGreaterThan(at('m4-ship', w));
    expect(at('m1-clickhouse', w)).toBeLessThan(at('m1-drift', w));
  });
  test('the preflights come first and change nothing', () => {
    expect(ids().slice(0, 2)).toEqual(['m1-commit', 'm4-reachable']);
    for (const s of plan(o).slice(0, 2)) expect(s.apply).toEqual([]);
  });
});

describe('scripts', () => {
  test('every generated script parses in bash', () => {
    for (const opts of [o, { ...o, clickhouseWindow: true }])
      for (const s of plan(opts))
        for (const body of [s.done, s.capture, s.apply.join('\n'), s.verify, s.health?.script].filter(Boolean)) {
          const r = spawnSync('bash', ['-n', '-c', `${prelude(s.mac, opts)}\n${body}`], { encoding: 'utf8' });
          expect({ id: s.id, err: r.stderr }).toEqual({ id: s.id, err: '' });
        }
  });
  test('ssh quoting keeps quotes and dollars literal', () => {
    const text = `it's $HOME "x" \\n`;
    expect(spawnSync('bash', ['-c', `printf %s ${quote(text)}`], { encoding: 'utf8' }).stdout).toBe(text);
  });
});

describe('drift check (real bash, a fake setup.sh)', () => {
  /** Run the drift check with HOME in a temp dir whose pinned tree has a setup.sh printing `out` and exiting `rc`. */
  function check(allowClickhouse: boolean, tree?: { out: string; rc: number }) {
    const home = mkdtempSync(join(tmpdir(), 'i1-drift-'));
    try {
      if (tree) {
        const dir = join(home, '.config/tokenlayer/app', o.sha, 'scripts/deploy');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'setup.sh'), `#!/bin/bash\nprintf '%s\\n' ${quote(tree.out)}\nexit ${tree.rc}\n`);
        chmodSync(join(dir, 'setup.sh'), 0o755);
      }
      const r = spawnSync('bash', ['-c', `${prelude('m1', o)}\nSELF=/nonexistent\n${drift('m1', allowClickhouse)}`], { encoding: 'utf8', env: { ...process.env, HOME: home } });
      return r.status;
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const ck = 'DRIFT clickhouse:\n        ProgramArguments[0]: live "~/Gits/tokenlayer/bin/tokenlayer", repo "~/.config/tokenlayer/app/current/bin/tokenlayer"';
  test('no tree to run drift from is a failure, not a clean result', () => {
    expect(check(true)).not.toBe(0);
    expect(check(false)).not.toBe(0);
  });
  test('exit 0 passes', () => expect(check(false, { out: 'ok    ship', rc: 0 })).toBe(0));
  test('clickhouse alone passes only outside a window', () => {
    expect(check(true, { out: `ok    ship\n${ck}`, rc: 1 })).toBe(0);
    expect(check(false, { out: `ok    ship\n${ck}`, rc: 1 })).not.toBe(0);
  });
  test('any other drift fails', () => {
    expect(check(true, { out: `${ck}\nDRIFT ship:\n        x: live 1, repo 2`, rc: 1 })).not.toBe(0);
    expect(check(true, { out: 'DRIFT spendtable: no template in this repo', rc: 1 })).not.toBe(0);
  });
  test('a crash is not drift', () => expect(check(true, { out: 'TypeError: boom', rc: 1 })).not.toBe(0));
});

describe('dry run', () => {
  test('sends read-only probes only, and lists every step with its commands', async () => {
    const { calls, exec } = mock();
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: false, exec });
    expect(calls.filter(c => c.kind !== 'probe')).toEqual([]);
    expect(out.changed).toEqual([]);
    const text = lines.join('\n');
    for (const s of plan(o)) {
      expect(text).toContain(`${s.mac} ${s.id}:`);
      for (const command of s.apply) expect(text).toContain(command.split('\n')[0]);
    }
  });
  test('an unreachable M4 is reported, still without changing anything', async () => {
    const { calls, exec } = mock(c => (c.mac === 'm4' ? 255 : undefined));
    lines.length = 0;
    await run({ ...o, ...quiet, apply: false, exec });
    expect(calls.some(c => c.kind !== 'probe')).toBe(false);
    expect(lines.join('\n')).toContain('UNREACHABLE');
  });
});

describe('apply', () => {
  const applied = (calls: Call[]) => [...new Set(calls.filter(c => c.kind === 'apply' && c.id !== 'lock' && !c.script.includes('touch "$MARK/')).map(c => c.id))];

  test('stops at the first failed check: nothing after it runs, rollback for what changed, newest first, lock released', async () => {
    const { calls, exec } = mock(c => (c.kind === 'verify' && c.id === 'm1-schema' ? 1 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.ok).toBe(false);
    expect(out.failed?.id).toBe('m1-schema');
    const order = ids();
    const ran = applied(calls);
    expect(ran.every(id => order.indexOf(id) <= order.indexOf('m1-schema'))).toBe(true);
    expect(ran).toEqual(['m1-checkout', 'm4-checkout', 'm1-pin', 'm4-pin', 'm1-clickhouse-config', 'm4-writer-env', 'm1-schema']);
    const text = lines.join('\n');
    const rollback = text.slice(text.indexOf('STOPPED at m1 m1-schema'));
    const pos = (id: string) => rollback.indexOf(` ${id}: `);
    expect(pos('m1-schema')).toBeGreaterThan(0);
    expect(pos('m1-schema')).toBeLessThan(pos('m1-clickhouse-config'));
    expect(pos('m1-clickhouse-config')).toBeLessThan(pos('m1-pin'));
    expect(pos('m1-pin')).toBeLessThan(pos('m1-checkout'));
    expect(pos('m1-ship')).toBe(-1);
    expect(calls.at(-1)).toMatchObject({ id: 'lock', kind: 'apply' });
    expect(calls.at(-1)!.script).toContain('rmdir ~/.m1-heavy.lock');
  });

  test('a failing command stops the run inside its step', async () => {
    const { calls, exec } = mock(c => (c.kind === 'apply' && c.id === 'm4-ship' && !c.script.includes('touch') ? 1 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.failed?.id).toBe('m4-ship');
    expect(calls.some(c => c.id === 'm4-ship' && c.kind === 'verify')).toBe(false);
    expect(applied(calls).at(-1)).toBe('m4-ship');
    expect(lines.join('\n')).toContain('m4 m4-ship: cp -p "$HOME/.config/tokenlayer/backups/after-merge-20261120T000000Z/com.tokenlayer.ship.plist" "$HOME/Library/LaunchAgents/"');
  });

  test('a health check on the other Mac counts: the M4 ship without an M4 heartbeat stops the run', async () => {
    const { exec } = mock(c => (c.kind === 'verify' && c.id === 'm4-ship' && c.mac === 'm1' ? 1 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.failed?.id).toBe('m4-ship');
  });

  test('an unreachable M4 stops at the preflight before anything changes', async () => {
    const { calls, exec } = mock(c => (c.mac === 'm4' ? 255 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.failed?.id).toBe('m4-reachable');
    expect(applied(calls)).toEqual([]);
    expect(lines.join('\n')).toContain('(nothing was changed)');
  });

  test('a rerun skips steps already in place and still checks them, without demanding a restart', async () => {
    const { calls, exec } = mock(c => (c.kind === 'probe' && c.script.includes('$MARK/') ? 0 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.ok).toBe(true);
    expect(applied(calls)).toEqual([]);
    const verifies = calls.filter(c => c.kind === 'verify');
    expect(verifies.length).toBeGreaterThanOrEqual(plan(o).length);
    expect(verifies.every(c => c.script.includes('APPLIED=0'))).toBe(true);
  });

  test('a held lock stops before any step', async () => {
    const { calls, exec } = mock(c => (c.id === 'lock' && c.kind === 'apply' ? 4 : undefined));
    lines.length = 0;
    const out = await run({ ...o, ...quiet, apply: true, exec });
    expect(out.ok).toBe(false);
    expect(calls.filter(c => c.id !== 'lock')).toEqual([]);
  });

  test('the captured state reaches the check and the rollback', async () => {
    const { calls, exec } = mock(c => {
      if (c.id === 'm1-ship' && c.kind === 'verify') return 1;
      return undefined;
    });
    const withPid: Exec = async (mac, script, kind, id) => (kind === 'probe' && id === 'm1-pin' && !script.includes('$MARK/') ? { code: 0, out: 'b'.repeat(40) } : exec(mac, script, kind, id));
    lines.length = 0;
    await run({ ...o, ...quiet, apply: true, exec: withPid });
    expect(lines.join('\n')).toContain(`m1 m1-pin: [[ ${'b'.repeat(40)} == none ]] || ~/Gits/tokenlayer/scripts/deploy/setup.sh use ${'b'.repeat(40)}`);
    expect(calls.find(c => c.id === 'm1-ship' && c.kind === 'verify')!.script).toContain('APPLIED=1');
  });
});
