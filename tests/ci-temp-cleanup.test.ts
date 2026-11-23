import { expect, test } from 'bun:test';
import { auditSuite } from '../scripts/test-temp-cleanup';
const run = (code: string) => auditSuite({ command: [process.execPath, '-e', code], quiet: true });
test('standalone audit accepts a substantial clean run', async () => {
  expect(await run('console.error("1000 pass")')).toEqual({ passed: 1000 });
});
test('standalone audit rejects residue, failed children and vacuous runs', async () => {
  await expect(run('require("fs").mkdirSync(process.env.TMPDIR + "/leftover"); console.error("1000 pass")')).rejects.toThrow('leftover=["leftover"]');
  await expect(run('console.error("1000 pass"); process.exit(1)')).rejects.toThrow('exit=1');
  await expect(run('console.error("0 pass")')).rejects.toThrow('passed=0');
});
