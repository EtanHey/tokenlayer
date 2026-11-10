import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';

test('actual page handlers send toggle, count and distinct press payloads; retry preserves id',
async function forms() {
  const calls: any[] = [];
  const forms: any = {};
  for (const id of ['switch', 'counts', 'pressed']) forms['#' + id] = {
    account: { value: 'etanface@gmail.com' }, strict: { checked: false }, spillover: { value: "false" },
    allowNonFableOnFableAccount: { checked: false },
    left: { value: '2' }, confirmed: { checked: true }, opId: { value: '' },
  };
  forms['meta[name="csrf-token"]'] = { content: 'csrf' };
  forms['#session-window'] = { value: '3h' };
  forms['#sessions'] = {};
  forms['#retry'] = { hidden: true };
  forms['#notice'] = {};
  let fail = false;
  let serial = 0;
  const context: any = { document: { querySelector: function select(s: string) { return forms[s]; } },
    confirm: function confirm() { return true; }, crypto: { randomUUID: function uuid() { return 'op-' + ++serial; } },
    setInterval: function timer() {}, fetch: async function fakeFetch(path: string, options: any) {
      calls.push({ path, body: JSON.parse(options.body) });
      return { ok: !fail, json: async function json() { return { error: 'fixture unavailable' }; } };
    },
  };
  createContext(context);
  const source = readFileSync('src/dashboard/app.js', 'utf8')
    .replace(/^refresh\(\);$/m, '').replace(/^refreshSessions\(\);$/m, '');
  runInContext(source + '\nrefresh = async function refreshed() {};', context);
  async function submit(id: string) {
    await forms['#' + id].onsubmit({ preventDefault: function preventDefault() {}, target: forms['#' + id] });
  }
  await submit('switch');
  expect(calls.at(-1)).toEqual({ path: '/api/switch', body: {
    account: 'etanface@gmail.com', on: true, strict: false, spillover: false, allowNonFableOnFableAccount: false,
  } });
  runInContext('latestState = { state: { requested: { mode: "manual" } } };', context);
  await submit('switch');
  expect(calls.at(-1).body.on).toBe(false);
  await submit('counts');
  expect(calls.at(-1).body).toEqual({ account: 'etanface@gmail.com', left: 2, confirmed: true });
  await submit('pressed');
  const first = calls.at(-1).body.opId;
  fail = true;
  await submit('pressed');
  const retry = calls.at(-1).body.opId;
  expect(retry).not.toBe(first);
  expect(forms['#retry'].hidden).toBe(false);
  fail = false;
  await forms['#retry'].onclick();
  expect(calls.at(-1).body.opId).toBe(retry);
  expect(forms['#retry'].hidden).toBe(true);
});
