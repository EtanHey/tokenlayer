import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/usage-queue.json";
import { mapUsageRecord } from "../../src/drain/record";
import { labelHash } from "../../src/lib/hash";

const [ok, rateLimited] = fixture as Record<string, unknown>[];

describe("mapUsageRecord", () => {
  test("maps tokens, latency and timestamps to proxy_usage columns", () => {
    const row = mapUsageRecord(ok, { hub: "m1" });
    expect(row.ts).toBe("2026-10-28 07:31:07.123");
    expect(row.hub).toBe("m1");
    expect(row.provider).toBe("claude");
    expect(row.model).toBe("claude-opus-5-5");
    expect(row.response_model).toBe("claude-opus-5-5-20261001");
    expect(row.input_tokens).toBe(41250);
    expect(row.uncached_input_tokens).toBe(1150);
    expect(row.cache_read_tokens).toBe(38000);
    expect(row.cache_creation_tokens).toBe(2100);
    expect(row.output_tokens).toBe(1830);
    expect(row.total_tokens).toBe(43080);
    expect(row.accounting_quality).toBe("complete");
    expect(row.latency_ms).toBe(4210);
    expect(row.ttft_ms).toBe(812);
    expect(row.status_code).toBe(200);
    expect(row.failed).toBe(false);
    expect(row.stream).toBe(true);
    expect(row.session_id).toBe("6740716a-2133-4127-bdad-a239335a23fa");
    expect(row.execution_id).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("credential is the stable label hash of auth_index, shared with steer", () => {
    const row = mapUsageRecord(ok, { hub: "m1" });
    expect(row.credential).toBe(labelHash("0a1b2c3d4e5f6071"));
    expect(row.credential).toMatch(/^[0-9a-f]{16}$/);
    expect(mapUsageRecord(ok, { hub: "m1" }).credential).toBe(row.credential);
  });

  test("never carries raw account, upstream key, client key or token hash", () => {
    const serialized = JSON.stringify([mapUsageRecord(ok, { hub: "m1" }), mapUsageRecord(rateLimited, { hub: "m1" })]);
    for (const secret of [
      "max-a@example.invalid",
      "sk-ant-api03-redacted",
      "sk-client-redacted-m4",
      "sk-client-redacted-m1",
      "redacted-sha256",
      "session=redacted",
      "req_redacted",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const row = mapUsageRecord(ok, { hub: "m1" });
    expect(row.account_hash).toBe(labelHash("max-a@example.invalid"));
    expect(row.client_key_hash).toBe(labelHash("sk-client-redacted-m4"));
  });

  test("keeps only rate-limit response headers, lowercased", () => {
    const row = mapUsageRecord(ok, { hub: "m1" });
    expect(row.ratelimit).toEqual({
      "anthropic-ratelimit-unified-5h-reset": "1761652800",
      "anthropic-ratelimit-unified-7d-reset": "1762000000",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
    });
  });

  test("maps failures with status, code and the complete body", () => {
    const row = mapUsageRecord(rateLimited, { hub: "m1" });
    expect(row.ts).toBe("2026-10-28 07:32:00.000");
    expect(row.failed).toBe(true);
    expect(row.status_code).toBe(429);
    expect(row.fail_code).toBe("rate_limited");
    expect(row.fail_body).toContain("rate_limit_error");
    expect(row.ratelimit).toEqual({});
    expect(row.session_id).toBe("");

    const huge = { ...rateLimited, fail: { status_code: 500, body: "x".repeat(10_000) } };
    expect(mapUsageRecord(huge, { hub: "m1" }).fail_body.length).toBe(10000);
  });

  test("failure text, codes and user agent are preserved at ingest", () => {
    const key = "sk-ant-api03-FAKEfakeFAKEfake0123456789";
    const email = "carol.fake@example.invalid";
    const leaky = {
      ...rateLimited,
      user_agent: `  curl/8 (${email})  `,
      fail: {
        status_code: 401,
        code: `invalid_key:${key}`,
        body: JSON.stringify({ error: { message: `invalid x-api-key ${key} for ${email}`, refresh_token: "1//0gFAKEfakeFAKE0123456789" } }),
      },
    };
    const row = mapUsageRecord(leaky, { hub: "m1" });
    const serialized = JSON.stringify(row);
    for (const secret of [key, email, "1//0gFAKEfakeFAKE0123456789"]) expect(serialized).toContain(secret);
    expect(row.user_agent).toBe(leaky.user_agent);
    expect(row.fail_code).toBe(leaky.fail.code);
    expect(row.fail_body).toBe(leaky.fail.body);
    expect(row.status_code).toBe(401);
    expect(row.fail_body).toContain("invalid x-api-key");
  });

  test("missing optional fields fall back to defaults", () => {
    const row = mapUsageRecord({ timestamp: "2026-10-28T00:00:00Z", execution_id: "e1" }, { hub: "m1" });
    expect(row.credential).toBe("");
    expect(row.input_tokens).toBe(0);
    expect(row.model).toBe("unknown");
    expect(row.status_code).toBe(0);
  });

  test("rejects records that are not objects or lack a usable timestamp", () => {
    expect(() => mapUsageRecord("not-json", { hub: "m1" })).toThrow();
    expect(() => mapUsageRecord({ timestamp: "garbage" }, { hub: "m1" })).toThrow();
  });
});

 test('all public rate-limit buckets round-trip exactly', () => {
 const headers = Object.fromEntries([
 ...['requests','tokens','input-tokens','output-tokens'].flatMap(b => ['limit','remaining','reset'].map(f => `anthropic-ratelimit-${b}-${f}`)),
 ...['requests','tokens'].flatMap(b => ['limit','remaining','reset'].map(f => `x-ratelimit-${f}-${b}`)),
 ...['5h','7d'].flatMap(w => ['reset','status','utilization'].map(f => `anthropic-ratelimit-unified-${w}-${f}`)),
 'retry-after','x-codex-primary-reset-after-seconds'
 ].map((h,i) => [h, `${i}.125`]));
 expect(mapUsageRecord({...ok,response_headers:headers},{hub:'m1'}).ratelimit).toEqual(headers);
 });
