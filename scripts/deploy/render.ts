import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clickhouseBinary, renderJob } from './jobs';

// Render only: no credentials, config changes, or launchctl calls.
export function renderAgents(machine: string, output: string, binary = clickhouseBinary(homedir())) {
  if (machine !== 'm1' && machine !== 'm4' || !output) throw Error('render.ts m1|m4 output-directory [clickhouse-binary]');
  const agents = machine === 'm1' ? ['clickhouse', 'drain', 'ship'] : ['ship'];
  const rendered = agents.map(agent => [agent, renderJob(agent, { machine, clickhouse: binary })]);
  mkdirSync(output, { recursive: true });
  for (const [agent, xml] of rendered) writeFileSync(join(output, `com.tokenlayer.${agent}.plist`), xml);
}
if (import.meta.main) renderAgents(...process.argv.slice(2) as [string, string, string?]);
