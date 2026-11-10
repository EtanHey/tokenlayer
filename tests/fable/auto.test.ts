import { test, expect } from 'bun:test';
import { allowed, plan } from '../../src/fable/core';
import { resetPressed, type ResetState } from '../../src/fable/reset';
import { models, state, observed } from './fixtures';

for (const spillover of [false, true, 'auto'] as const) {
  test(`healthy A retains Fable with spill ${spillover}`, () => {
    const s = { ...state(), spillover, resets: { a: { left: 0, confirmedByEtan: true } } };
    expect(allowed(models, plan(s, [observed('a', .2, .1), observed('b')]).desired.b))
      .not.toContain(models[0]);
  });
}
test('auto cap boundaries and confirmed/unconfirmed reset presses', async () => {
  const s: ResetState = { ...state(), spillover: 'auto' };
  const obs = [observed('a', .2, 1), observed('b')];
  const check = (spill: boolean) => {
    const p = plan(s, obs);
    expect(allowed(models, p.desired.b).includes(models[0])).toBe(spill);
    if (!spill) expect(p.exceptions[models[0]]).toBe('WAIT_AT_CAP');
  };
  check(false);
  s.resets = { a: { left: 2, confirmedByEtan: true } };
  check(false);
  s.resets.a = { left: null, confirmedByEtan: false };
  check(false);
  const hub = { observations: async () => obs, request: async () => ({}) };
  s.resets.a = { left: 1, confirmedByEtan: true };
  await resetPressed(s, 'a', 'a', 'confirmed', true, hub, () => {}, () => {});
  expect(s.resets.a.left).toBe(0);
  expect(s.resets.a.confirmedZero).toBe(true);
  check(true);
  s.resets.a = { left: null, confirmedByEtan: false, confirmedZero: true };
  check(true);
  s.resets.a = { left: 1, confirmedByEtan: true };
  await resetPressed(s, 'a', 'a', 'unconfirmed', false, hub, () => {}, () => {});
  expect(s.resets.a.left).toBeNull();
  expect(s.resets.a.confirmedZero).toBeFalsy();
  check(false);
});
