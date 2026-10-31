import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CLAUDE_POLICY as policy } from '../../src/admit/policy';
test('policy and model config match fleet canon #5', () => {
  const canon = readFileSync('tests/fixtures/admit/fleet-canon-5.md','utf8');
  const number = (pattern: RegExp) => {
    const match = canon.match(pattern);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };
  expect<Record<string,number>>(policy.leads).toEqual({
    green: number(/at most (\d+) parallel Claude lead/),
    slow: number(/no new Claude workers and <=(\d+) active leads/),
    stop: number(/no Claude workers and <=(\d+) essential lead turn/),
  });
  expect<Record<string,number>>(policy.workerCaps).toEqual({judgment:number(/<=([0-9]+) `claude.judgment`/),
    cheap:number(/<=([0-9]+) `claude.subagent.cheap`/), mechanical:number(/<=([0-9]+) `claude.subagent.mechanical`/)});
  expect<number>(policy.judgmentSlots).toBe(number(/shared\s+(\d+)-slot/));
  expect<number>(policy.workerSharePct).toBe(number(/together <=(\d+)%/));
  expect<Record<string,number>>(policy.brake).toEqual({
    stopUsedPct: number(/STOP at >=(\d+)%/),
    projectionPct: number(/elapsed-minutes > (\d+)/),
    minElapsedPct: number(/first (\d+)% of the window/),
  });
  const config = readFileSync('spec/Admit.cfg','utf8');
  for (const [name,value] of Object.entries(policy.leads))
    expect(config).toContain(`${name}Cap = ${value}`);
});
