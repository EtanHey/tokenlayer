import { expect, test } from 'bun:test';
import { failureDetails, secondaryFailure } from '../../scripts/history/diagnostic-bundle';
import { formatError, registerSecrets } from '../../src/lib/egress';

const fallback = '[diagnostic unavailable]';
// Inspect only trusted wrapper data properties: never re-trigger hostile getters.
function contains(root: unknown, needle: unknown, seen = new Set<unknown>()): boolean {
  if (Object.is(root, needle)) return true;
  if (!root || typeof root !== 'object' || seen.has(root)) return false;
  seen.add(root);
  try {
    const members = Object.getOwnPropertyDescriptor(root, 'errors')?.value;
    const cause = Object.getOwnPropertyDescriptor(root, 'cause')?.value;
    if (contains(cause, needle, seen)) return true;
    if (Array.isArray(members)) {
      const length = Object.getOwnPropertyDescriptor(members, 'length')?.value;
      for (let i = 0; i < Math.min(length, 34); i++)
        if (contains(Object.getOwnPropertyDescriptor(members, String(i))?.value, needle, seen)) return true;
    }
  } catch { /* Revoked proxies have no safely inspectable raw children. */ }
  return false;
}

test('raw custody preserves frozen/falsy primaries without mutation', () => {
  for (const primary of [undefined, null, false, 0, '', Object.freeze(Error('frozen'))]) {
    const secondary = Object.freeze(Error('secondary'));
    const before = primary instanceof Error ? Object.getOwnPropertyDescriptors(primary) : undefined;
    retained(primary, secondary, secondaryFailure(primary, 'cleanup', secondary), []);
    if (before) expect(Object.getOwnPropertyDescriptors(primary)).toEqual(before);
    expect(failureDetails(primary).failures).toEqual([]);
  }
});

for (const fault of ['classification', 'stack', 'message', 'conversion', 'members', 'length', 'index', 'cause', 'revoked']) {
  test(`nonthrowing guards retain exact ${fault} exceptions`, () => {
    const failure = Error('exact rendering exception');
    const fail = () => { throw failure; };
    let primary: unknown = Error('primary');
    if (fault === 'classification') primary = new Proxy({}, { getPrototypeOf: fail });
    if (fault === 'stack') Object.defineProperty(primary, 'stack', { get: fail });
    if (fault === 'message') {
      Object.defineProperty(primary, 'stack', { value: undefined });
      Object.defineProperty(primary, 'message', { get: fail });
    }
    if (fault === 'conversion') primary = { toString: fail };
    if (['members', 'length', 'index'].includes(fault)) {
      primary = new AggregateError([]);
      Object.defineProperty(primary, 'errors', fault === 'members' ? { get: fail } : {
        value: new Proxy([Error('member')], { get(target, key, receiver) {
          if (key === (fault === 'length' ? 'length' : '0')) return fail();
          return Reflect.get(target, key, receiver);
        } }),
      });
    }
    if (fault === 'cause') Object.defineProperty(primary, 'cause', { get: fail });
    if (fault === 'revoked') { const proxy = Proxy.revocable({}, {}); proxy.revoke(); primary = proxy.proxy; }
    const secondary = Error('secondary');
    const bundle = secondaryFailure(primary, 'cleanup', secondary);
    retained(primary, secondary, bundle, fault === 'revoked' ? [] : [failure]);
    expect(bundle.message).toContain(fallback);
    expect(bundle.errors.length).toBeGreaterThan(2);
    expect(failureDetails(primary).failures.length).toBeGreaterThan(0);
  });
}

test('cycles, depth, width and repeated wrappers have bounded traversal', () => {
  let reads = 0, slots = 0;
  const leaf = Object.defineProperty(Error('leaf'), 'stack', { get() { reads++; return 'leaf'; } });
  const wide = new AggregateError([]);
  wide.errors = new Proxy(new Array(100_000).fill(leaf), { get(target, key, receiver) {
    if (key === Symbol.iterator || key === 'map') throw Error('arbitrary iterator used');
    if (/^\d+$/.test(String(key))) slots++;
    return Reflect.get(target, key, receiver);
  } });
  wide.cause = wide;
  const rendered = failureDetails(wide);
  expect(reads).toBe(1);
  expect(slots).toBe(16);
  expect(rendered.text).toContain('[repeated error]');
  expect(rendered.text).toContain(fallback);
  expect(rendered.failures.length).toBe(1); // Width limit only; no iterator invocation.
  let deep: unknown = leaf;
  for (let i = 0; i < 10_000; i++) deep = new AggregateError([deep]);
  expect(failureDetails(deep).text).toContain(fallback);
  let wrapped: unknown = leaf;
  for (let i = 0; i < 100; i++) wrapped = secondaryFailure(wrapped, 'cleanup', wide);
  expect(failureDetails(wrapped).text.length).toBeLessThanOrEqual(8192);
  expect(reads).toBeLessThan(40);
});

test('node budget bounds broad distinct graphs; invalid aggregate shapes fail closed', () => {
  let reads = 0;
  const node = (cause?: Error) => Object.defineProperty(Error('node', { cause }), 'stack', {
    get() { reads++; return 'node'; },
  });
  const broad = new AggregateError(Array.from({ length: 16 }, () => node(node(node()))));
  expect(failureDetails(broad).text).toContain(fallback);
  expect(reads).toBe(31); // Root plus 31 nodes exhausts the 32-node traversal budget.
  for (const members of [{}, new Proxy([], { get: () => -1 }), new Proxy([], { get: () => Infinity })]) {
    const value = new AggregateError([]);
    Object.defineProperty(value, 'errors', { value: members });
    expect(failureDetails(value).text).toContain(fallback);
  }
});

test('retention cap stops getters and never recursively renders captured failures', () => {
  const raised: Error[] = [];
  let recursivelyRead = 0;
  const fail = () => {
    const failure = Object.defineProperty(Error('new failure'), 'stack', { get() { recursivelyRead++; throw Error('recursive'); } });
    raised.push(failure);
    throw failure;
  };
  const hostile = () => {
    const value = Object.defineProperty(new AggregateError([]), 'stack', { get: fail });
    value.errors = new Proxy(new Array(16), { get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) return fail();
      return Reflect.get(target, key, receiver);
    } });
    return value;
  };
  const primary = hostile(), secondary = hostile();
  const bundle = secondaryFailure(primary, 'cleanup', secondary);
  retained(primary, secondary, bundle, raised);
  expect(raised.length).toBe(32);
  expect(bundle.errors.length).toBe(34);
  expect(recursivelyRead).toBe(0);
});

test('registered secret forms are sanitized and oversize raw text is omitted whole', () => {
  const secret = 'synthetic orchard /+?=';
  registerSecrets({ DIAGNOSTIC_SECRET: secret });
  const forms = [secret, encodeURIComponent(secret), encodeURIComponent(secret).toLowerCase(),
    new URLSearchParams({ v: secret }).toString().slice(2), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')];
  const primary = Object.defineProperty(Error('primary'), 'stack', { value: forms.join(' | ') });
  const bundle = secondaryFailure(primary, secret, Error('secondary'));
  for (const form of forms) expect(bundle.message).not.toContain(form);
  expect(bundle.message).toContain('[redacted]');
  expect(primary.stack).toBe(forms.join(' | '));
  const oversized = Object.defineProperty(Error('huge'), 'stack', { value: 'PUBLIC-PREFIX-' + 'x'.repeat(8192) + secret });
  expect(failureDetails(oversized).text).toBe(fallback);
  const many = new AggregateError(Array.from({ length: 16 }, (_, i) => String(i) + 'x'.repeat(1500)));
  expect(failureDetails(many).text.length).toBeLessThanOrEqual(8192);
  expect(failureDetails(many).text).toContain(fallback);
});
function retained(primary: unknown, secondary: unknown, bundle: AggregateError, failures: unknown[]) {
  expect(bundle.errors[0]).toBe(primary);
  expect(bundle.errors[1]).toBe(secondary);
  expect(bundle.cause).toBe(primary);
  for (const failure of failures) expect(contains(bundle, failure)).toBe(true);
  expect(formatError(bundle).length).toBeLessThanOrEqual(8192);
  expect(bundle.message).toBe(bundle.stack!);
}

for (const stage of ['stop receipt', 'writer lock removal', 'cascading-new-render-errors']) {
  test(`R2 retains every rendering failure: ${stage}`, () => {
    let reads = 0;
    const raised: Error[] = [];
    const primary = Object.defineProperty(Error('original'), 'stack', { get() {
      reads++;
      if (stage === 'cascading-new-render-errors' || reads === 2) {
        const failure = Error(`render failure ${reads}`);
        raised.push(failure);
        throw failure;
      }
      return 'Error: original';
    } });
    // Same diagnostic/wrapper order as adversarial.ts; no importer, disk or DB.
    const initial = failureDetails(primary);
    let terminal: unknown = primary;
    if (initial.failures.length)
      terminal = secondaryFailure(primary, 'diagnostic rendering', new AggregateError(initial.failures));
    const secondary = Error(stage === 'writer lock removal' ? 'EISDIR' : 'local history low space');
    const bundle = secondaryFailure(terminal, stage, secondary);
    retained(terminal, secondary, bundle, raised);
    expect(contains(bundle, primary)).toBe(true);
    expect(raised.length).toBe(stage === 'cascading-new-render-errors' ? 3 : 1);
    expect(bundle.message).toContain(fallback);
    expect(bundle.message).toContain(stage);
  });
}
