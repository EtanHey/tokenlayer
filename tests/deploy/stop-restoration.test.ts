import { expect, test } from 'bun:test';
import { withPausedSidecars } from '../../scripts/deploy/launchd';

const labels = ['com.tokenlayer.ship', 'com.tokenlayer.drain'];
for (const stuck of labels) test(`successful bootout restores ${stuck} after teardown timeout`, async () => {
  const stopped = new Set<string>(), restored: string[] = [], waits: number[] = [];
  let worked = false;
  const command = (args: string[]) => {
    const label = args.at(-1)!.split('/').pop()!.replace('.plist', '');
    if (args[0] === 'bootout') stopped.add(label);
    if (args[0] === 'bootstrap') restored.push(label);
    return { status: args[0] === 'print' && stopped.has(label) && label !== stuck ? 1 : 0, stderr: '' };
  };
  await expect(withPausedSidecars(async () => { worked = true; }, '/owned', command, async ms => { waits.push(ms); }))
    .rejects.toThrow(`teardown ${stuck} timed out after 10 seconds`);
  expect(worked).toBe(false);
  expect(waits).toEqual(Array(40).fill(250));
  expect(restored).toEqual(labels.slice(0, labels.indexOf(stuck) + 1));
});
for (const failed of labels) test(`failed bootout of ${failed} does not invent a stopped service`, async () => {
  const stopped = new Set<string>(), restored: string[] = [];
  const command = (args: string[]) => {
    const label = args.at(-1)!.split('/').pop()!.replace('.plist', '');
    if (args[0] === 'bootout' && label === failed) return { status: 1, stderr: 'owned refusal' };
    if (args[0] === 'bootout') stopped.add(label);
    if (args[0] === 'bootstrap') restored.push(label);
    return { status: args[0] === 'print' && stopped.has(label) ? 1 : 0, stderr: '' };
  };
  await expect(withPausedSidecars(async () => { throw Error('must not work'); }, '/owned', command, async () => {}))
    .rejects.toThrow(`bootout ${failed} failed`);
  expect(restored).toEqual(labels.slice(0, labels.indexOf(failed)));
});
for (const primary of [Error('owned teardown failure'), undefined, null, false, 0, '', {}]) {
  test('teardown primary and every restoration failure retain order and reference', async () => {
    const stopped = new Set<string>(), restored: string[] = [];
    const errors = [Error('owned ship restore'), Error('owned drain restore')];
    const command = (args: string[]) => {
      const label = args.at(-1)!.split('/').pop()!.replace('.plist', '');
      if (args[0] === 'bootout') stopped.add(label);
      if (args[0] === 'bootstrap') { restored.push(label); throw errors[labels.indexOf(label)]; }
      return { status: args[0] === 'print' && stopped.has(label) && label === labels[0] ? 1 : 0, stderr: '' };
    };
    const failure = await withPausedSidecars(async () => { throw Error('must not work'); }, '/owned', command,
      async () => { throw primary; }).then(() => { throw Error('expected rejection'); }, err => err);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(3);
    [primary, ...errors].forEach((err, i) => expect(failure.errors[i]).toBe(err));
    expect(restored).toEqual(labels);
  });
}
