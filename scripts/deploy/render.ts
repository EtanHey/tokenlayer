import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from './deploy';

// Render only: no credentials, config changes, or launchctl calls.
export function renderAgents(machine: string, output: string, binary = join(homedir(), '.local/bin/clickhouse-d1-26.10.2.103')) {
  if (!['m1', 'm4'].includes(machine) || !output) throw Error('render.ts m1|m4 output-directory [clickhouse-binary]');
  const repo = resolve(import.meta.dir, '../..');
  const agents = machine === 'm1' ? ['clickhouse', 'drain', 'ship'] : ['ship'];
  const rendered = agents.map(agent => [agent, render(readFileSync(join(repo, `launchd/com.tokenlayer.${agent}.plist.template`), 'utf8'), { HOME: homedir(), REPO: repo, MACHINE: machine, CLICKHOUSE: binary })]);
  mkdirSync(output, { recursive: true });
  for (const [agent, xml] of rendered) writeFileSync(join(output, `com.tokenlayer.${agent}.plist`), xml);
}
if (import.meta.main) renderAgents(...process.argv.slice(2) as [string, string, string?]);
