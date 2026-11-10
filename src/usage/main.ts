import { installErrorHandlers } from '../lib/egress';
installErrorHandlers();
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { enrich, parseHistory } from './projection';
import { serialize, staleSnapshot } from './snapshot';

const remote = '. ~/.config/tokenlayer/hub.env; printf \'Authorization: Bearer %s\\n\' "$CLIPROXY_MGMT_KEY" | curl -fsS -m 10 -H @- http://127.0.0.1:8317/v8/management/credentials';
const dir = join(homedir(), '.config/tokenlayer');
const target = join(dir, 'usage.json');
await mkdir(dir, { recursive: true });
let value;
try {
  const proc = Bun.spawn(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'm1', remote], { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill(), 25000);
  try {
    const body = await new Response(proc.stdout).text();
    if (await proc.exited !== 0) throw new Error('hub unavailable');
    let history: ReturnType<typeof parseHistory> = [];
    const historyPath = join(dir, 'usage-history.jsonl');
    try { history = parseHistory(await readFile(historyPath, 'utf8')); } catch {}
    const enriched = enrich(JSON.parse(body), history);
    const { history: nextHistory, ...published } = enriched;
    const historyTmp = `${historyPath}.${process.pid}.tmp`;
    try {
      await writeFile(historyTmp, nextHistory.map(s => JSON.stringify(s)).join('\n') + '\n', {mode:0o600});
      await rename(historyTmp, historyPath);
    } finally { await rm(historyTmp, {force:true}); }
    value = published;
  } finally { clearTimeout(timer); }
} catch {
  try {
    const previous = JSON.parse(await readFile(target, 'utf8'));
    value = staleSnapshot(previous);
  } catch {
    value = { generated_at: null, source: 'cliproxy-hub', stale: true, accounts: [], last_error: 'hub unavailable' };
  }
}
const tmp = `${target}.${process.pid}.tmp`;
try {
  await writeFile(tmp, serialize(value), { mode: 0o644, flag: 'wx' });
  await chmod(tmp, 0o644);
  await rename(tmp, target);
} finally { await rm(tmp, { force: true }); }
