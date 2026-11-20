import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

class Element {
  textContent = ''; className = ''; dataset: Record<string, string> = {};
  children: Element[] = [];
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
}
function client() {
  const nodes: Record<string, any> = {};
  nodes['#pressed'] = Object.assign(new Element(), { account: {} });
  const timers = new Map<number, () => void>();
  let serial = 0, now = Date.now(), next: () => Promise<unknown>;
  const row = { name: 'Codex', tool: 'codex', mark: 'OK', pct: 54, window: '7d',
    resets_at: new Date(now + 3600000).toISOString(), use: null };
  const success = () => Promise.resolve({ rows: [row], m4: { state: 'fresh' } });
  next = success;
  const context = createContext({
    document: { querySelector: (s: string) => nodes[s] ??= new Element(), createElement: () => new Element() },
    Date: class extends Date { static now() { return now; } },
    Intl, AbortController,
    setInterval() {},
    setTimeout(fn: () => void) { timers.set(++serial, fn); return serial; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch: async () => ({ ok: true, json: () => next() }),
  });
  const source = readFileSync('src/dashboard/app.js', 'utf8')
    .replace(/^refresh\(\);$/m, '').replace(/^refreshSessions\(\);$/m, '').replace(/^refreshTools\(\);$/m, '');
  runInContext(source, context);
  return {
    nodes, timers, success,
    refresh: () => runInContext('refreshTools()', context),
    set: (fn: () => Promise<unknown>) => { next = fn; },
    advance: (ms: number) => { now += ms; },
  };
}
function assertUnknown(c: ReturnType<typeof client>) {
  const row = c.nodes['#tools'].children[0];
  expect(row.dataset.mark).toBe('UNKNOWN');
  expect(row.children[1].children).toHaveLength(1); // old meter removed
  expect(row.children[1].children[0].textContent).toBe('UNKNOWN % used');
  expect(c.nodes['#tools-source'].textContent).toContain('last success 90 s ago');
}
test('success then rejection clears previously OK rows to UNKNOWN with last-success age', async () => {
  const c = client();
  await c.refresh();
  expect(c.nodes['#tools'].children[0].dataset.mark).toBe('OK');
  c.advance(90000);
  c.set(() => Promise.reject(Error('offline')));
  await c.refresh();
  assertUnknown(c);
  expect(c.timers.size).toBe(0);
});
test('success then a hung body expires, clears meters, releases inflight and can recover', async () => {
  const c = client();
  await c.refresh();
  c.advance(90000);
  c.set(() => new Promise(() => {}));
  const pending = c.refresh();
  // A deterministic deadline, even if fetch/json ignores abort and never settles.
  expect(c.timers.size).toBe(1);
  for (const fire of [...c.timers.values()]) fire();
  await pending;
  assertUnknown(c);
  c.set(c.success);
  await c.refresh();
  expect(c.nodes['#tools'].children[0].dataset.mark).toBe('OK');
  expect(c.timers.size).toBe(0);
});
