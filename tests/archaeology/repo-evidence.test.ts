import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeGit, deriveRepoEvidence } from "../../src/archaeology/repo-evidence";
import { origin } from "../../src/archaeology/pipeline";

test("MF-4 real git toplevels prevent coach poisoning and conflicting aliases stay unresolved", () => {
  const dir=mkdtempSync(join(tmpdir(),"repo-evidence-"));
  const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(["git","-C",cwd,...args],{stderr:"ignore"});expect(p.exitCode).toBe(0);};
  const repo=(path:string,remote:string)=>{mkdirSync(path,{recursive:true});git(path,"init","-q");git(path,"remote","add","origin",`https://github.com/${remote}.git`);return path;};
  // Fixture paths inherit the physical host identity, even though the target is synthetic M4 data.
  const observe=(cwd:string)=>observeGit({machine:"m4",cwd,git_remote:""},origin({machine:"m4",cwd,member_path:""}));
  try {
    const coach=repo(join(dir,"a","coach"),"EtanHey/coach"),golems=repo(join(dir,"golems"),"EtanHey/golems");
    const nested=join(golems,"packages","coach");mkdirSync(nested,{recursive:true});
    const target={machine:"m4",cwd:"/Users/etanheyman/.t3/worktrees/coach/t3-x"};
    const observations=[coach,nested].map(observe);
    const lookup=new Map([["EtanHey/coach","EtanHey/coach"],["EtanHey/golems","EtanHey/golems"],["Other/coach","Other/coach"]]);
    expect(deriveRepoEvidence([target],observations,lookup)[0].repo).toBe("EtanHey/coach");
    const collision=repo(join(dir,"b","coach"),"Other/coach");
    expect(deriveRepoEvidence([target],[...observations,observe(collision)],lookup)).toEqual([]);
  } finally {rmSync(dir,{recursive:true});}
});
