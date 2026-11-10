import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
test('dashboard startup uses sanitized egress and council port', function startupContract() {
  const source = readFileSync('src/dashboard/server.ts', 'utf8');
  expect(source).not.toMatch(/console\./);
  expect(source).toContain('8448');
});
