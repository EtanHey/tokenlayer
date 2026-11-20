import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { render } from '../../scripts/deploy/deploy';
import { renderAgents } from '../../scripts/deploy/render';

mkdirSync('.local', { recursive: true });

const home = '/Users/synthetic';
const repo = `${home}/Gits/tokenlayer`;
const values = { HOME: home, REPO: repo, BUN: '/opt/homebrew/Cellar/bun/1.4.4_1/bin/bun', CLICKHOUSE: `${home}/.local/bin/clickhouse-d1-26.10.2.103` };
Object.assign(values, { OUTBOX: `${home}/outbox.md` });
const parse = (xml: string) => {
  const result = spawnSync('python3', ['-c', 'import json,plistlib,sys;json.dump(plistlib.loads(sys.stdin.buffer.read()),sys.stdout)'], { input: xml, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};
for (const machine of ['m1', 'm4']) test(`${machine}: every rendered plist avoids Cellar paths`, () => {
  for (const file of readdirSync('launchd').filter(f => f.includes('.plist'))) {
    const xml = render(readFileSync(`launchd/${file}`, 'utf8'), { ...values, MACHINE: machine });
    expect(xml).not.toContain('/Cellar/');
    const plist = parse(xml);
    if (plist.Label === 'com.tokenlayer.ship') expect(plist.EnvironmentVariables.TOKENLAYER_MACHINE).toBe(machine);
    const agent = plist.Label.replace('com.tokenlayer.', '') as keyof typeof names;
    if (agent in names) expect(basename(plist.ProgramArguments[0])).toBe(names[agent]);
    if (['com.tokenlayer.usage', 'com.tokenlayer.steer', 'com.tokenlayer.jev'].includes(plist.Label)) expect(plist.ProgramArguments[0]).toBe('/opt/homebrew/bin/bun');
  }
});
test('ratchet-live: snapshot runner every 15 min posts to the rendered outbox', () => {
  const plist = parse(render(readFileSync('launchd/com.tokenlayer.ratchet-live.plist.template', 'utf8'), values));
  expect(plist.ProgramArguments).toEqual(['/opt/homebrew/bin/bun', `${repo}/ratchet/live-schedule.ts`]);
  expect(plist.StartInterval).toBe(900);
  expect(plist.EnvironmentVariables.TOKENLAYER_RATCHET_OUTBOX).toBe(`${home}/outbox.md`);
});
test('jev: bundled one-shot every minute reads credentials from env files only', () => {
  const plist = parse(render(readFileSync('launchd/com.tokenlayer.jev.plist.template', 'utf8'), values));
  expect(plist.ProgramArguments).toEqual(['/opt/homebrew/bin/bun', `${home}/.config/tokenlayer/bin/jev.js`]);
  expect([plist.StartInterval, plist.KeepAlive, plist.RunAtLoad]).toEqual([60, undefined, true]);
  expect(plist.EnvironmentVariables).toEqual({ TOKENLAYER_ENV_FILES: `${home}/.config/tokenlayer/ship.env:${home}/.config/tokenlayer/clickhouse.env:${home}/.config/tokenlayer/jev.env` });
  expect(plist.StandardOutPath).toBe(`${home}/Library/Logs/tokenlayer/jev.log`);
});
const names = { ship: 'tokenlayer session uploader', drain: 'tokenlayer usage recorder', clickhouse: 'tokenlayer database' };
for (const agent of ['ship', 'drain', 'clickhouse'] as const) test(`${agent}: named executable preserves launch arguments and settings`, () => {
  const template = readFileSync(`launchd/com.tokenlayer.${agent}.plist.template`, 'utf8');
  const plist = parse(render(template, { ...values, MACHINE: 'm1' }));
  expect(plist.ProgramArguments).toEqual([`${repo}/bin/${names[agent]}`, ...(agent === 'clickhouse' ? [`${repo}/scripts/deploy/deploy.ts`, 'server', values.CLICKHOUSE] : [`${repo}/src/${agent}/main.ts`])]);
  expect(plist.AssociatedBundleIdentifiers).toBeUndefined();
  expect(plist.StandardOutPath).toBe(`${home}/Library/Logs/tokenlayer/${agent === 'clickhouse' ? 'clickhouse-launchd' : agent}.log`);
  expect(plist.StandardErrorPath).toBe(plist.StandardOutPath);
  expect(plist.EnvironmentVariables).toEqual(agent === 'ship' ? { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', TOKENLAYER_MACHINE: 'm1', CLICKHOUSE_USER: 'tokenlayer_writer', TOKENLAYER_ENV_FILES: `${home}/.config/tokenlayer/ship.env:${home}/.config/tokenlayer/clickhouse.env:${home}/.config/tokenlayer/clickhouse-writer.env` } : agent === 'drain' ? { TOKENLAYER_HUB: 'm1', TOKENLAYER_HUB_URL: 'http://127.0.0.1:8317', CLICKHOUSE_USER: 'tokenlayer_writer', TOKENLAYER_ENV_FILES: `${home}/.config/tokenlayer/hub.env:${home}/.config/tokenlayer/clickhouse.env:${home}/.config/tokenlayer/clickhouse-writer.env` } : undefined);
  expect([plist.LowPriorityIO, plist.Nice]).toEqual(agent === 'ship' ? [true, 10] : [undefined, undefined]);
  expect([plist.RunAtLoad, plist.KeepAlive, plist.ThrottleInterval]).toEqual([true, true, 30]);
  expect(plist.WorkingDirectory).toBe(agent === 'clickhouse' ? `${home}/Library/Application Support/tokenlayer/clickhouse` : repo);
  expect(plist.ProcessType).toBe(agent === 'clickhouse' ? undefined : 'Background');
  expect(basename(plist.ProgramArguments[0])).toBe(names[agent]);
  const wrapper = `bin/${names[agent]}`;
  expect(statSync(wrapper).mode & 0o111).toBe(0o111);
  expect(readFileSync(wrapper, 'utf8')).toBe('#!/bin/sh\nexec /opt/homebrew/bin/bun "$@"\n');
  expect(spawnSync('/bin/sh', ['-n', wrapper]).status).toBe(0);
});
test('renderer refuses any remaining Cellar path', () => {
  expect(() => renderAgents('invalid', '.local/unused')).toThrow('render.ts');
  expect(() => render('<plist>__CLICKHOUSE__</plist>', { CLICKHOUSE: '/opt/homebrew/Cellar/clickhouse/1/bin/clickhouse' })).toThrow('Cellar');
});

test('render-only CLI writes the correct agent set without touching home config or services', () => {
  for (const machine of ['m1', 'm4']) {
    const root = mkdtempSync(`${process.cwd()}/.local/render-`), output = `${root}/plists`;
    const run = spawnSync(process.execPath, ['scripts/deploy/render.ts', machine, output], { env: { ...process.env, HOME: root, PATH: '' }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(readdirSync(output).sort()).toEqual((machine === 'm1' ? ['clickhouse', 'drain', 'ship'] : ['ship']).map(a => `com.tokenlayer.${a}.plist`));
    for (const file of readdirSync(output)) { // daemons run the pinned copy, never a git checkout a pull can change
      const plist = parse(readFileSync(`${output}/${file}`, 'utf8'));
      expect(plist.ProgramArguments[0].startsWith(`${root}/.config/tokenlayer/app/current/`)).toBe(true);
      if (!file.includes('clickhouse')) expect(plist.WorkingDirectory).toBe(`${root}/.config/tokenlayer/app/current`);
    }
    expect(existsSync(`${root}/.config`)).toBe(false);
    expect(existsSync(`${root}/Library/LaunchAgents`)).toBe(false);
    expect(existsSync(`${root}/Library/Logs/tokenlayer`)).toBe(false);
  }
});
