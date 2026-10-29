import { expect, test } from 'bun:test';
import { parseLine, newFileState } from '../../src/ship/parse';
import { mapUsageRecord } from '../../src/drain/record';
import { ClickHouse } from '../../src/lib/clickhouse';
const secret = 'sk-ant-api03-SYNTHETICfake01234567890123456789';
test('raw and parsed metadata retain source text without redaction or serialization', () => {
  const line = ` { "type":"user", "sessionId":"${secret}", "message":{"role":"user","content":"${secret}"} }\r\n`;
  const row = parseLine(line, newFileState('claude', 'claude', 0));
  expect(row.raw).toBe(line);
  expect(row.session_id).toBe(secret);
});
test('drain preserves whitespace and long failure text', () => {
  const text = `  ${secret} ${'x'.repeat(3000)}  `;
  const row = mapUsageRecord({ timestamp: '2026-10-28T00:00:00Z', failed: true, user_agent: text, fail: { body: text } }, { hub: 'm1' });
  expect(row.fail_body).toBe(text);
  expect(row.user_agent).toBe(text);
});
test('the same secret echoed by ClickHouse is redacted in thrown errors', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(secret, { status: 500 }) });
  try {
    const ch = new ClickHouse({ url: `http://127.0.0.1:${server.port}`, user: '', password: '', database: 'tokenlayer' });
    await expect(ch.exec('SELECT 1')).rejects.not.toThrow(secret);
  } finally { server.stop(true); }
});
