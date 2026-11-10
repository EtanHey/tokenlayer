import { test, expect } from "bun:test";
import { arrangement, outsideDelta, sessionsSQL } from "../../src/dashboard/advice";
import { defaults, spillEnabled } from "../../src/fable/core";
const meter = (u: number) => ({ utilization: u, stale: false, reset: '2026-11-15T02:00:00Z' });
const c = (email: string, w: number, f: number) =>
  ({ email, status: 'active', weekly: meter(w), fable: meter(f), resets: { left: 2 } });
test('auto waits with resets and spills only after confirmed zero', () => {
  const s = defaults();
  expect(s.spillover).toBe('auto');
  expect(spillEnabled(s, 'a')).toBe(false);
  s.resets = { a: {left: 2, confirmedByEtan: true} };
  expect(spillEnabled(s, 'a')).toBe(false);
  s.resets.a.left = 0;
  expect(spillEnabled(s, 'a')).toBe(true);
  s.resets.a = { left: null, confirmedByEtan: false, confirmedZero: true };
  expect(spillEnabled(s, 'a')).toBe(true);
});
test('arrangement accounts for both meters', () => {
  expect(arrangement([c('h',1,1), c('e',.46,.39)]).keepOff).toBe(true);
  const friday = arrangement([c('h',0,0), c('e',.95,.95)]);
  expect(friday.keepOff).toBe(true);
  expect(friday.account).toBe('e');
  expect(arrangement([c('h',0,0), c('e',0,0)]).keepOff).toBe(false);
});
test('outside use requires positive delta and zero observed requests', () => {
  expect(outsideDelta(.2,.3,0)).toBeCloseTo(10);
  expect(outsideDelta(.2,.3,1)).toBe(null);
  expect(outsideDelta(.3,.2,0)).toBe(null);
});
test('sessions queries bounded fixed windows', () => {
  expect(sessionsSQL(24)).toContain('LIMIT 10');
  expect(() => sessionsSQL(12)).toThrow();
});

test('arrangement pins account and reason for today, Friday, Sunday and stale data', () => {
  const today = arrangement([c('h', 1, 1), c('e', .46, .39)]);
  expect(today.account).toBe('h');
  expect(today.reason).toContain('until h resets');
  const friday = arrangement([c('h', 0, 0), c('e', .95, .95)]);
  expect(friday.account).toBe('e');
  expect(friday.reason).toContain('until e resets');
  const sunday = arrangement([c('h', 0, 0), c('e', 0, 0)]);
  expect(sunday.account).toBe('h');
  expect(sunday.reason).toContain('Fable → h. Best combined');
  const stale = c('h', 0, 0);
  stale.weekly.stale = true;
  expect(arrangement([stale, c('e', 0, 0)]).reason).toContain('data stale');
});
