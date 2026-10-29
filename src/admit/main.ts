import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deny, evaluate, timestamp } from './admit';
let result;
try {
  const { values } = parseArgs({ args:process.argv.slice(2), strict:true, options:{ kind:{type:'string'}, 'active-leads':{type:'string'}, essential:{type:'boolean'}, now:{type:'string'}, file:{type:'string'} } });
  const kind = values.kind;
  if (kind !== 'lead' && kind !== 'claude.judgment' && kind !== 'claude.subagent.cheap' && kind !== 'claude.subagent.mechanical') throw Error();
  if (kind === 'lead' && values['active-leads'] === undefined) throw Error();
  if (values.now !== undefined && values.file === undefined) throw Error();
  const count = values['active-leads'] ?? '0';
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw Error();
  const now = values.now === undefined ? Date.now() : timestamp(values.now);
  if (!Number.isFinite(now)) throw Error();
  result = evaluate(JSON.parse(readFileSync(values.file ?? join(homedir(),'.config/tokenlayer/usage.json'),'utf8')), {kind, activeLeads:Number(count), essential:values.essential === true, now});
} catch {
  result = deny('invalid arguments or unavailable healthy telemetry');
}
process.stdout.write(JSON.stringify(result)+'\n');
process.exitCode = result.admit ? 0 : 1;
