import { describe, expect, test } from "bun:test";
import { REDACTED, redactDeep, redactText } from "../../src/lib/redact";

// Synthetic sentinels only: none of these are real credentials or addresses.
const KEY = "sk-ant-api03-FAKEfakeFAKEfake0123456789";
const OAUTH = "sk-ant-oat01-FAKEfakeFAKEfake0123456789";
const REFRESH = "1//0gFAKEfakeFAKEfake0123456789abcdef";
const GOOGLE = "ya29.FAKEfakeFAKEfake0123456789";
const BEARER = "fakeBearerValue0123456789abcdef";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlZmFrZQ";
const EMAIL = "alice.fake@example.invalid";
const PASSWORD = "hunter2-fake-pw";
const SENTINELS = [KEY, OAUTH, REFRESH, GOOGLE, BEARER, JWT, EMAIL, PASSWORD];

test('stack review: key families and JWTs after JSON escapes at every echo depth', () => {
  for (const key of [KEY, 'ghp_SYNTHETICfake01234567890123456789', JWT, REFRESH]) {
    for (const prefix of ['\\n', '\\t', '\\r', '\\b', '\\f', '\\u003e', '>']) {
      let input = `{"text":"here:${prefix}${key}"}`;
      for (let depth = 0; depth < 4; depth++, input = JSON.stringify(input)) {
        const out = redactText(input);
        expect(out).not.toContain(key);
        expect(out).toContain(REDACTED);
        expect(() => JSON.parse(out)).not.toThrow();
      }
    }
  }
});

test('sensitive names match complete segments, never identifier substrings', () => {
  const controls = { tokenlayer: 'm1', TOKENLAYER_HOST: '5', monkey: 'e', keyboard: 'public' };
  expect(redactDeep(controls)).toEqual(controls);
  expect(redactText(JSON.stringify(controls))).toBe(JSON.stringify(controls));
  for (const key of ['token', 'access_token', 'X-Auth-Token', 'accessToken', 'APIKey']) {
    expect(redactDeep({ [key]: 'opaque' })).toEqual({ [key]: REDACTED });
  }
});

const authFile = {
  type: "claude",
  email: EMAIL,
  access_token: OAUTH,
  refresh_token: REFRESH,
  expired: "2026-10-28T09:00:00Z",
};

function expectClean(out: unknown) {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  for (const secret of SENTINELS) expect(s).not.toContain(secret);
}

describe("redactText", () => {
  test("strips API keys, OAuth tokens, bearer headers, JWTs and emails from free text", () => {
    const text = `401 from upstream: invalid x-api-key ${KEY} for ${EMAIL}; Authorization: Bearer ${BEARER}; oauth ${GOOGLE} jwt ${JWT}`;
    const out = redactText(text);
    expectClean(out);
    expect(out).toContain("401 from upstream");
    expect(out).toContain(REDACTED);
  });

  test("strips auth-file JSON embedded in a string, including password-like fields", () => {
    const out = redactText(`cat auth.json\n${JSON.stringify(authFile)}\npassword=${PASSWORD}`);
    expectClean(out);
    expect(out).toContain('"type":"claude"');
  });

  test("strips PEM private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END PRIVATE KEY-----";
    expect(redactText(`key:\n${pem}\n`)).not.toContain("MIIFAKEFAKEFAKE");
  });

  test("leaves ordinary text, uuids, model names and hashes alone", () => {
    const text = "claude-opus-5-5 session 6740716a-2133-4127-bdad-a239335a23fa took 4210ms, hash 0a1b2c3d4e5f6071";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactDeep", () => {
  test("recurses through objects, arrays and nested strings", () => {
    const value = {
      message: { content: [{ type: "tool_result", content: `here: ${JSON.stringify(authFile)}` }] },
      headers: { Authorization: `Bearer ${BEARER}` },
      list: [[`${EMAIL}`], { deeper: { api_key: KEY } }],
      auth: authFile,
    };
    const out = redactDeep(value);
    expectClean(out);
    expect((out as { message: { content: { type: string }[] } }).message.content[0].type).toBe("tool_result");
  });

  test("redacts sensitive keys by name but keeps numeric token counts", () => {
    const out = redactDeep({ access_token: "opaque-but-secret", password: PASSWORD, input_tokens: 12, usage: { output_tokens: 3 } });
    expect(out).toEqual({ access_token: REDACTED, password: REDACTED, input_tokens: 12, usage: { output_tokens: 3 } });
  });

  test("handles top-level strings and primitives", () => {
    expectClean(redactDeep(`{"api_key":"${KEY}"} ${EMAIL}`));
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(null)).toBe(null);
  });

  test("redacts extra caller-supplied keys", () => {
    expect(redactDeep({ source: "acct-1", model: "m" }, { extraKeys: ["source"] })).toEqual({ source: REDACTED, model: "m" });
  });
});
