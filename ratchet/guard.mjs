import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function checkRows(base, rows, event = {}) {
  for (const old of base) {
    const next = rows.find(r => r.id === old.id);
    const changed = next ? [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(k => {
      if (JSON.stringify(old[k]) === JSON.stringify(next[k])) return false;
      if (k === 'ceiling' && old.direction === next.direction) return old.direction === 'min' ? next[k] < old[k] : old.direction === 'max' ? next[k] > old[k] : true;
      if (k === 'maxRegression') return (next[k] ?? 0) > (old[k] ?? 0);
      if (k === 'timeout_s') return next[k] > old[k];
      return true;
    }) : ['removed'];
    if (!changed.length) continue;
    const disclosure = `ratchet-change: ${old.id} ${next ? changed.map(k => `${k}=${JSON.stringify(next[k])}`).join(' ') : 'removed'}`;
    const pr = event.pull_request;
    if (!pr?.labels?.some(l => l.name === 'ratchet-change') || !pr.body?.split('\n').some(line => line.trim() === disclosure))
      throw Error(`row removed or loosened: ${old.id}\nRequired label ratchet-change and PR body line:\n${disclosure}`);
  }
}
export const raisedFloor = (floor, median) => {
  if (!Number.isFinite(median) || median <= 0) throw Error('invalid main median');
  return Math.max(floor, Math.floor(median * 80) / 100);
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkRows(...process.argv.slice(2, 4).map(p => JSON.parse(readFileSync(p, 'utf8')).rows), process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
