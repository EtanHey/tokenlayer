import { test, expect } from "bun:test";
import { diskVerdict } from "../../src/archaeology/disk-plan";

test("S-1 disk verdict uses import bytes plus 25 percent and a 14 GiB margin", () => {
  const gib=1024**3,raw=16*gib;
  expect(diskVerdict(raw,21*gib)).toMatchObject({import_bytes:raw,overhead_bytes:4*gib,margin_bytes:14*gib,required_free_bytes:51*gib,verdict:"FAIL"});
  expect(diskVerdict(raw,60*gib).verdict).toBe("PASS");
  expect(diskVerdict(raw,34*gib-1).verdict).toBe("FAIL");
});

test("35 GiB of real free space must remain after import", () => {
  const gib=1024**3;
  expect(diskVerdict(4*gib,20*gib)).toMatchObject({verdict:"FAIL",after_import_free_bytes:16*gib});
  expect(diskVerdict(4*gib,40*gib)).toMatchObject({verdict:"PASS",after_import_free_bytes:36*gib});
  expect(diskVerdict(4*gib,39*gib).verdict).toBe("PASS");
  expect(diskVerdict(4*gib,39*gib-1).verdict).toBe("FAIL");
});

test("disk plan CLI fails closed on unknown or insufficient destination free space", async () => {
  const {mkdtempSync,writeFileSync,readFileSync}=await import("node:fs");
  const dir=mkdtempSync(`${process.cwd()}/.local/disk-review-`);
  const report=`${dir}/report.json`,out=`${dir}/plan.json`;
  writeFileSync(report,JSON.stringify({import_bytes:4*1024**3,groups:{"m1\tcodex\tfixture":{bytes:4*1024**3}}}));
  const run=(extra:string[])=>Bun.spawnSync([process.execPath,"src/archaeology/disk-plan.ts","--report",report,"--out",out,...extra],{stdout:"pipe",stderr:"pipe",env:{...process.env,USER:"fixture"}});
  const unknown=run([]);
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr.toString()).toContain("--m1-free-gib");
  const low=run(["--m1-free-gib","20"]);
  expect(low.exitCode).not.toBe(0);
  expect(low.stdout.toString()+low.stderr.toString()).toContain("after import");
  const high=run(["--m1-free-gib","40"]);
  const plan=JSON.parse(readFileSync(out,"utf8"));
  expect(plan.destinations.m1).toMatchObject({verdict:"PASS",after_import_free_bytes:36*1024**3});
  expect(high.exitCode).toBe(plan.destinations.m4.verdict==="PASS"?0:1);
});
