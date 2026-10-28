import { expect, test } from "bun:test";
import { labelHash } from "../../src/steer/hash";

test("labelHash matches P4's sha256('tokenlayer:v1:' + value)[:16] so credentials_snap joins proxy_usage", () => {
  expect(labelHash("0000000000000ab0")).toBe("4232de26ae910bdf");
  expect(labelHash(" 0000000000000ab0 ")).toBe("4232de26ae910bdf");
  expect(labelHash("")).toBe("");
  expect(labelHash(undefined)).toBe("");
});
