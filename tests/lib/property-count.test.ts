import { expect, test } from "bun:test";
import { propertyCount } from "../support/ship-rewrites";

test("property trials default to 40 and accept the full 300-trial setting", () => {
  expect(propertyCount({})).toBe(40);
  expect(propertyCount({ TOKENLAYER_PROPERTY_N: "300" })).toBe(300);
});
for (const value of ["0", "-1", "", "1.5", "NaN"]) test(`invalid property count fails closed: ${value}`, () => {
  expect(() => propertyCount({ TOKENLAYER_PROPERTY_N: value })).toThrow("positive integer");
});
