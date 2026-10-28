import { describe, expect, test } from "bun:test";
import { REDACTED, redactDeep, redactText } from "../../src/lib/redact";

// Synthetic only. Each of these shapes leaked at the issue #5 baseline.
const secret = "syntheticOpaqueCredential";
const leakingShapes = [
  ...["CLICKHOUSE_PASSWORD", "CLIPROXY_MGMT_KEY", "PREFIX_PASSWORD", "PREFIX_KEY", "SERVICE_TOKEN", "SERVICE_SECRET"].flatMap(
    (key) => ["", '"', "'"].map((quote) => `${key}=${quote}${secret}${quote}`),
  ),
  ...["password", "token", "client_secret", "id_token"].flatMap(
    (key) => ['"', "'"].map((quote) => `${key}=${quote}${secret}${quote}`),
  ),
  ...["accessToken", "refreshToken", "idToken", "clientSecret"].flatMap(
    (key) => [`{"${key}":"${secret}"}`, `'${key}': '${secret}'`],
  ),
  `--password ${secret}`, `--password "${secret}"`, `--token '${secret}'`,
  `--token="${secret}"`, `--client-secret ${secret}`,
  `X-ClickHouse-Key: ${secret}`, `X-Service-Key: ${secret}`,
  `https://fakeuser:${secret}@localhost:8123/path`,
  `postgres://fakeuser:${secret}@localhost/db`,
  `Bearer ${secret}`, `bearer alphabeticfake`,
  `Cookie: session=${secret}; other=fakeCookieTail`,
];

// The original panel's 24 probes, recovered from its synthetic probe artifact.
const panelSecret = "Zq9xW2vB7nM4kL8pR3tY6uH1";
const panelLetters = "ZqxWvBnMkLpRtYuHabcdefgh";
const panelShapes: [string, string][] = [
  [`key sk-ant-api03-${panelSecret}`, panelSecret],
  [`{"accessToken":"sk-ant-oat01-${panelSecret}"}`, panelSecret],
  [`OPENAI_API_KEY=sk-proj-${panelSecret}`, panelSecret],
  [`Authorization: Bearer ${panelSecret}`, panelSecret],
  [`Authorization: Bearer ${panelLetters}`, panelLetters],
  ["id eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl", "eyJzdWIiOiIx"],
  [`1//0${panelSecret}`, panelSecret],
  [`{"refresh_token":"${panelSecret}"}`, panelSecret],
  [`"{\\"refresh_token\\":\\"${panelSecret}\\"}"`, panelSecret],
  [`{"refreshToken":"${panelSecret}"}`, panelSecret],
  [`{"accessToken":"${panelSecret}"}`, panelSecret],
  ["contact synthetic.user@example.test now", "synthetic.user"],
  ...["PASSWORD", "CLICKHOUSE_PASSWORD", "CLIPROXY_MGMT_KEY"].map((key): [string, string] => [`${key}=${panelSecret}`, panelSecret]),
  [`password="${panelSecret}"`, panelSecret], [`password: "${panelSecret}"`, panelSecret],
  [`API_KEY='${panelSecret}'`, panelSecret], [`export GITHUB_TOKEN="${panelSecret}"`, panelSecret],
  [`clickhouse client --password ${panelSecret}`, panelSecret],
  [`curl -H "X-ClickHouse-Key: ${panelSecret}" http://127.0.0.1:8123`, panelSecret],
  [`postgres://app:${panelSecret}@localhost:5432/db`, panelSecret],
  [`x-api-key: ${panelSecret}`, panelSecret],
  [`-----BEGIN OPENSSH PRIVATE KEY-----\n${panelSecret}\n-----END OPENSSH PRIVATE KEY-----`, panelSecret],
];

test.each(panelShapes)("original panel probe %s", (input, sentinel) => {
  expect(redactText(input)).not.toContain(sentinel);
});

describe("issue #5 formerly leaking shapes", () => {
  test.each(leakingShapes)("removes %s", (input) => {
    const out = redactText(input);
    expect(out).not.toContain(input === "bearer alphabeticfake" ? "alphabeticfake" : secret);
    expect(out).not.toContain("fakeCookieTail");
    expect(out).toContain(REDACTED);
  });
});

test("sensitive structured names normalize camelCase and env prefixes", () => {
  for (const key of ["accessToken", "refreshToken", "idToken", "clientSecret", "CLICKHOUSE_PASSWORD", "CLIPROXY_MGMT_KEY"]) {
    expect(redactDeep({ [key]: secret })).toEqual({ [key]: REDACTED });
  }
});

test("quoted values include spaces, punctuation, escaped quotes and nested JSON escaping", () => {
  for (const value of ["fake password with spaces", 'fake\\\"quoteTail', "fake;comma,amp&tail", "fake\\nlineTail"]) {
    for (const key of ["password", "accessToken", "client_secret"]) {
      const json = JSON.stringify({ [key]: value, input_tokens: 123 });
      for (const input of [json, JSON.stringify(json), JSON.stringify(JSON.stringify(json))]) {
        const out = redactText(input);
        expect(out).not.toContain("Tail");
        expect(out).not.toContain("fake");
        expect(out).toContain("123");
      }
    }
  }
});

test("real-shaped synthetic sessions preserve prose and numeric usage", () => {
  const lines = [
    { type: "assistant", message: { model: "claude-opus-5-5", content: "Explain password hashing; token counts are usage. Bearer of good news.", usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 67 } } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999, output_tokens: 12 }, last_token_usage: { input_tokens: 123, cached_input_tokens: 45 } } } },
    { type: "tool_result", content: "token_count=123 input_tokens=123 output_tokens=45 total_tokens: 168; https://localhost:8123/path; set password to continue" },
  ];
  for (const line of lines) expect(redactDeep(line)).toEqual(line);
});

test("JSON-escaped newlines still separate env lines and bearer tokens", () => {
  const text = JSON.stringify(`tool output\nCLICKHOUSE_PASSWORD=${secret}\nCLIPROXY_MGMT_KEY=${secret}\nBearer ${secret}`);
  expect(redactText(text)).not.toContain(secret);
});

test("text and structured matching agree for prefixed camelCase fields", () => {
  for (const key of ["serviceToken", "databasePassword", "customClientSecret", "XClickHouseKey"]) {
    expect(redactText(JSON.stringify({ [key]: secret }))).not.toContain(secret);
    expect(redactDeep({ [key]: secret })).toEqual({ [key]: REDACTED });
  }
});

test("repeated persistence boundaries do not change an already redacted value", () => {
  for (const input of leakingShapes) {
    const once = redactText(input);
    expect(redactText(once)).toBe(once);
  }
});

test("headers remove quoted cookie components and retain the next line", () => {
  for (const input of [`Cookie: session="${secret}"; other=fakeCookieTail\nnext line`, `Authorization: Digest username="${secret}", response="fakeCookieTail"\nnext line`]) {
    const out = redactText(input);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("fakeCookieTail");
    expect(out).toContain("next line");
  }
});

test("short opaque values in named fields, flags and authorization headers are removed", () => {
  for (const input of ['--token=x', 'Authorization: Bearer abc', '{"id_token":"x"}', '{"client_secret":"x"}', 'Set-Cookie: a=x; b=y']) {
    expect(redactText(input)).toContain(REDACTED);
  }
});

test("unquoted env-file values include punctuation and spaces", () => {
  for (const value of ["fakePrefix&syntheticSecretTail", "fakePrefix;syntheticSecretTail", "fakePrefix,syntheticSecretTail", "fakePrefix syntheticSecretTail", "fakePrefix\\syntheticSecretTail"]) {
    expect(redactText(`CLICKHOUSE_PASSWORD=${value}\nnext line`)).not.toContain("syntheticSecretTail");
  }
  expect(redactText("https://localhost/?token=fake&count=123")).toBe("https://localhost/?token=[redacted]&count=123");
});

test("escaped newlines cannot hide header names in nested tool output", () => {
  for (const key of ["Cookie", "Authorization", "X-ClickHouse-Key"]) {
    for (const encode of [(s: string) => s, JSON.stringify, (s: string) => JSON.stringify(JSON.stringify(s))]) {
      const input = encode(`before\n${key}: syntheticSecretTail\nafter`);
      expect(redactText(input)).not.toContain("syntheticSecretTail");
      expect(redactText(input)).toContain("after");
    }
  }
});
