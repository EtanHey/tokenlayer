import { test, expect } from "bun:test";
import { diskVerdict } from "../../src/archaeology/disk-plan";

test("S-1 disk verdict uses import bytes plus 25 percent and a 14 GiB margin", () => {
  const gib=1024**3,raw=16*gib;
  expect(diskVerdict(raw,21*gib)).toMatchObject({import_bytes:raw,overhead_bytes:4*gib,margin_bytes:14*gib,required_free_bytes:34*gib,verdict:"FAIL"});
  expect(diskVerdict(raw,40*gib).verdict).toBe("PASS");
  expect(diskVerdict(raw,34*gib-1).verdict).toBe("FAIL");
});
