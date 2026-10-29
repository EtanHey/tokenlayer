import { test, expect } from 'bun:test';
import { evaluate, deny, type Kind } from '../../src/admit/admit';
test('implementation finite-state enumeration', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const kinds: Kind[] = ['lead','claude.judgment','claude.subagent.cheap','claude.subagent.mechanical'];
  for (const healthy of [false,true]) for (const used of [0,59,60,79,80,100])
  for (const paced of [false,true]) for (const kind of kinds) for (let active=0;active<=10;active++)
  for (const essential of [false,true]) {
    const elapsed = paced ? 1 : 300;
    const actualPaced = used * 300 / elapsed > 80;
    const input = { generated_at:new Date(now).toISOString(), stale:!healthy, accounts:[{
      label:'synthetic', disabled:false, status:'allowed', weekly:{used_pct:0},
      five_hour:{used_pct:used, resets_at:new Date(now+(300-elapsed)*60000).toISOString()},
    }] };
    let result;
    try { result = evaluate(input,{kind,activeLeads:active,essential,now}); } catch {result=deny('unhealthy');}
    const expected = healthy && used < 100 && (kind !== 'lead' ? used<60 && !actualPaced : used>=80 ? essential && active<3 : used>=60 ? active<5 : active<10);
    expect(result.admit).toBe(expected);
  }
});
