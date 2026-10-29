import { describe, expect, test } from "bun:test";
import { REDACTED, redactDeep, redactText } from "../../src/lib/redact";
import { newFileState, parseLine } from "../../src/ship/parse";

// Synthetic only. Each of these shapes leaked at the issue #5 baseline.
const secret = "syntheticOpaqueCredential";

describe("review round 1 persistence regressions", () => {
  const probes = [
    `tool --password first\\ ${secret} --count 123`,
    `tool --password 'first'"${secret}" --count 123`,
    `DATABASE_PASSWORD=prefix\\n${secret}\nPUBLIC_COUNT=123`,
    `DATABASE_PASSWORD=prefix\\r${secret}\nPUBLIC_COUNT=123`,
  ];
  for (const [index, probe] of probes.entries()) {
    const retained = index < 2 ? "--count 123" : "PUBLIC_COUNT=123";
    for (const [path, persist] of [
      ["text", (s: string) => redactText(s)],
      ["parsed raw", (s: string) => parseLine(JSON.stringify({ type: "tool_result", content: s }), newFileState("claude", "claude", 0)).raw],
      ["invalid raw", (s: string) => parseLine(s, newFileState("claude", "claude", 0)).raw],
    ] as const) {
      test(`probe ${index + 1}: ${path}`, () => {
        const out = redactText(persist(probe));
        expect(out).not.toContain(secret);
        expect(out).toContain(REDACTED);
        expect(out).toContain(retained);
      });
    }
  }

  test("JSON encoding preserves shell arguments and literal env escapes at each nesting depth", () => {
    for (const probe of probes) {
      let input = probe;
      for (let depth = 0; depth < 4; depth++) {
        const out = redactText(input);
        expect(out).not.toContain(secret);
        expect(out).toContain(probe.includes("PUBLIC_COUNT") ? "PUBLIC_COUNT=123" : "--count 123");
        expect(redactText(out)).toBe(out);
        if (depth) expect(() => JSON.parse(out)).not.toThrow();
        input = JSON.stringify(input);
      }
    }
  });

  test("shell argument scanning respects escapes, quote transitions and command separators", () => {
    for (const value of [
      `first\\ ${secret}`, `first\\\t${secret}`, `'first'"${secret}"`,
      `"first"'${secret}'`, `first'${secret}'last`, `first\\;${secret}`,
      `"first\\\"${secret}"`, `'first\\${secret}'`,
    ]) {
      const input = `tool --client-secret=${value}; echo 123`;
      const out = redactText(input);
      expect(out).not.toContain(secret);
      expect(out).toBe(`tool --client-secret=${REDACTED}; echo 123`);
      expect(redactText(out)).toBe(out);
    }
    expect(redactText(`tool --password 'unfinished ${secret}`)).not.toContain(secret);
  });
});
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

describe("round 2 structural value boundaries", () => {
  const sentinel = "ReviewR2SyntheticOpaqueSentinel";
  const probes = [
    `export DATABASE_PASSWORD='first'${sentinel}\nPUBLIC_COUNT=123`,
    `export DATABASE_PASSWORD="first"${sentinel}\nPUBLIC_COUNT=123`,
    `DATABASE_PASSWORD='first'"${sentinel}"\r\nPUBLIC_COUNT=123`,
    ...["\r\n\t", "\n "].flatMap((fold) => [
      `Authorization: Digest${fold}username="${sentinel}", response="syntheticDigest"\nX-Count: 123`,
      `Authorization: Bearer first${fold}${sentinel}\nX-Count: 123`,
      `Authorization: opaque${fold}${sentinel}\nX-Count: 123`,
      `Cookie: first=value;${fold}session=${sentinel}\nX-Count: 123`,
    ]),
  ];
  for (const [i, probe] of probes.entries()) {
    test(`review probe ${i + 1} survives no persistence path`, () => {
      const keep = i < 3 ? "PUBLIC_COUNT=123" : "X-Count: 123";
      for (const input of [probe, JSON.stringify(probe), JSON.stringify(JSON.stringify(probe))]) {
        const outputs = [redactText(input), redactText(parseLine(input, newFileState("claude", "claude", 0)).raw),
          ...[{ type: "tool_result", content: input }, { type: "function_call_output", output: input }]
            .map((event) => redactText(parseLine(JSON.stringify(event), newFileState("codex", "codex", 0)).raw))];
        for (const out of outputs) {
          expect(out).not.toContain(sentinel);
          expect(out).toContain(keep);
          expect(redactText(out)).toBe(out);
        }
      }
    });
  }
  test("all sensitive key families use complete word/line/header boundaries", () => {
    for (const key of ["PASSWORD", "client.secret", "accessTOKEN", "api-key", "Auth", "Cookie", "CREDENTIAL", "SESSION"]) {
      for (const input of [`export ${key}='first'"${sentinel}"\nPUBLIC_COUNT=123`,
        `tool --${key}='first'"${sentinel}" --count 123`,
        `run ${key}='first'"${sentinel}" --count 123`,
        `${key}='first\n${sentinel}'\nPUBLIC_COUNT=123`,
        `${key}: first\r\n\t${sentinel}\nX-Count: 123`]) {
        expect(redactText(input)).not.toContain(sentinel);
        expect(redactText(input)).toContain("123");
      }
      expect(redactDeep({ [key]: sentinel })).toEqual({ [key]: REDACTED });
    }
  });
  test("tail guard removes nearby opaque base64, hex and base64url runs only within 64 chars", () => {
    for (const opaque of ["Q7mV2xB9nK4pR8tY3uH6dF1s", "a39f7c20e18b46d590ac3f72", "Q7mV2xB9/nK4+pR8tY3uH6dF1s==", "Q7mV2xB9_nK4-pR8tY3uH6dF1s", "/Q7mV2xB9nK4pR8tY3uH6dF1s", "/Q7mV2x/B9nK4pR8tY3uH6dF1s", "qwertyuiopasdfghjklzxcvbnm"]) {
      expect(redactText(`password hint ${opaque}`)).not.toContain(opaque);
      expect(redactText(`p-a-s-s-w-o-r-d hint ${opaque}`)).not.toContain(opaque);
      expect(redactText(`${opaque} cookie hint`)).not.toContain(opaque);
      expect(redactText(`password ${" ".repeat(65)}${opaque}`)).toContain(opaque);
    }
  });
  test("telemetry identifiers and derived label hashes keep their existing contracts", () => {
    const metadata = { sessionId: "synthetic-session", parent_session_id: "6740716a-2133-4127-bdad-a239335a23fa",
      client_key_hash: "a373bc804e9d7eb5", auth_type: "oauth", token: 123, output_tokens_details: { thinking_tokens: 48 } };
    expect(redactDeep(metadata)).toEqual(metadata);
    expect(redactText(JSON.stringify(metadata))).toContain('"sessionId":"synthetic-session"');
    expect(redactDeep({ credential: "a37b5080741be88e", session: "syntheticOpaqueCredential" }))
      .toEqual({ credential: REDACTED, session: REDACTED });
  });
  test("bounded redaction retains numeric usage, paths, git SHAs, UUIDs and prose near sensitive names", () => {
    const controls = [
      "token_count=123 input_tokens=123 output_tokens=45 total_tokens: 168 cost=0.0042",
      "password docs /Users/u/Gits/0123456789abcdef0123456789abcdef01234567/file.ts",
      "secret docs C:\\Users\\u\\0123456789abcdef0123456789abcdef01234567\\file.ts",
      "token git SHA d67ceefa8f0e29fbae6b9e0afa1854d5e8b1319b",
      "session 6740716a-2133-4127-bdad-a239335a23fa",
      "Explain password hashing and token counts. Authentication documentation is useful.",
    ];
    for (const input of controls) {
      expect(redactText(input)).toBe(input);
      expect(redactDeep({ content: input, token: 123, input_tokens: 45 })).toEqual({ content: input, token: 123, input_tokens: 45 });
    }
  });
});
