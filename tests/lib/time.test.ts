import { expect, test } from "bun:test";
import { parseTimestampMs, toClickHouseTime } from "../../src/lib/time";
import { labelHash } from "../../src/lib/hash";

test("parses Go RFC3339Nano with offsets and epoch seconds/ms", () => {
  expect(parseTimestampMs("2026-10-28T10:31:07.123456789+03:00")).toBe(Date.UTC(2026, 9, 28, 7, 31, 7, 123));
  expect(parseTimestampMs("2026-10-28T07:32:00Z")).toBe(Date.UTC(2026, 9, 28, 7, 32, 0));
  expect(parseTimestampMs(1761652800)).toBe(1761652800000);
  expect(parseTimestampMs(1761652800123)).toBe(1761652800123);
  expect(parseTimestampMs("nope")).toBeNull();
  expect(parseTimestampMs(undefined)).toBeNull();
});

test("formats ClickHouse DateTime64(3) text in UTC", () => {
  expect(toClickHouseTime(Date.UTC(2026, 9, 28, 7, 31, 7, 5))).toBe("2026-10-28 07:31:07.005");
});

test("labelHash is stable, 16 hex chars, empty for empty input", () => {
  expect(labelHash("abc")).toBe(labelHash(" abc "));
  expect(labelHash("abc")).toMatch(/^[0-9a-f]{16}$/);
  expect(labelHash("")).toBe("");
  expect(labelHash(undefined)).toBe("");
});
