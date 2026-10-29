import { writeOut, writeErr, installErrorHandlers } from "../lib/egress";
import { basename } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { classify, origin, type Evidence } from "./pipeline";
import { inventory, readTSV } from "./main";

type Target = { machine: string; cwd: string };
export type GitObservation = Target & { toplevel: string; remote: string; current: boolean };
export function repoName(remote: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(remote) ? remote : /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1] ?? "";
}
export function observeGit(raw: { machine: string; cwd: string; git_remote: string }, localMachine = "m4"): GitObservation {
  const machine = origin({ ...raw, member_path: "" });
  const git = (...args: string[]) => Bun.spawnSync(["git", "--no-optional-locks", "-C", raw.cwd, ...args], { stderr: "ignore" });
  const root = machine === localMachine ? git("rev-parse", "--show-toplevel") : null;
  const current = root?.exitCode === 0;
  const remote = current ? git("remote", "get-url", "origin").stdout.toString().trim() : raw.git_remote;
  return { machine, cwd: raw.cwd, toplevel: current ? root.stdout.toString().trim() : "", remote: repoName(remote), current };
}
export function repoHint(cwd: string): string {
  const match = /\/\.t3\/worktrees\/([^/]+)|\/\.config\/superpowers\/worktrees\/([^/]+)|\/m1-lanes\/rigs\/([^/]+)|\/(?:Desktop\/)?[Gg]its\/([^/]+)|\/([^/]+)\/\.(?:worktrees|claude\/worktrees)\//.exec(cwd);
  return (match?.slice(1).find(Boolean) ?? "").replace(/-slot[12]$/, "");
}
export function deriveRepoEvidence(targets: Target[], observations: GitObservation[], lookup: ReadonlyMap<string, string>): Evidence[] {
  const known = new Map<string, Set<string>>();
  const valid = observations.flatMap(o => { const repo = lookup.get(o.remote); return repo ? [{ ...o, repo }] : []; });
  for (const o of valid) {
    const names = [o.remote.split("/").at(-1) ?? "", o.repo.split("/").at(-1) ?? ""];
    if (!o.toplevel || !names.some(n => n.toLowerCase() === basename(o.toplevel).toLowerCase())) continue;
    for (const name of names) { const repos = known.get(name.toLowerCase()) ?? new Set<string>(); repos.add(o.repo); known.set(name.toLowerCase(), repos); }
  }
  const result: Evidence[] = [];
  for (const target of targets) {
    const matching = valid.filter(o => o.machine === target.machine && (o.cwd === target.cwd || (o.toplevel && (target.cwd === o.toplevel || target.cwd.startsWith(o.toplevel + "/")))));
    const hint = repoHint(target.cwd), aliases = known.get(hint.toLowerCase());
    const repos = matching.length ? new Set(matching.map(o => o.repo)) : aliases ?? new Set([lookup.get(`EtanHey/${hint}`)].filter((r): r is string => !!r));
    if (repos.size !== 1) continue;
    const repo = [...repos][0], direct = matching.some(o => o.cwd === target.cwd && o.current);
    result.push({ ...target, repo, evidence: matching.length ? matching.map(o => `git origin ${o.remote} -> ${o.repo}; toplevel=${o.toplevel || "unknown (inventory snapshot)"}`).join("; ") : `unambiguous toplevel/remote alias or GitHub redirect: ${hint} -> ${repo}`, confidence: direct ? "high" : "medium" });
  }
  return result;
}

if (import.meta.main) {
  installErrorHandlers();
  const { values } = parseArgs({ options: { inventory: { type:"string" }, "repo-raw": { type:"string",multiple:true }, lookups: { type:"string" }, out: { type:"string" } } });
  if (!values.inventory || !values.lookups || !values.out) throw Error("requires --inventory --repo-raw --lookups --out");
  if (process.env.USER === "happycampr") throw Error("Phase 4 evidence collection is M4-only");
  const targets = [...new Map(inventory(values.inventory).filter(r=>classify(r).session&&r.cwd).map(r=>{const t={machine:origin(r),cwd:r.cwd};return [JSON.stringify(t),t];})).values()];
  const observations = (values["repo-raw"] ?? []).flatMap(readTSV).filter(r=>r.cwd).map(r=>observeGit({ machine:r.machine,cwd:r.cwd,git_remote:r.git_remote }));
  const cache: Record<string, {repo:string;at:string;status:number}> = {};
  if (existsSync(values.lookups)) {
    const input: unknown = JSON.parse(readFileSync(values.lookups,"utf8"));
    if (input && typeof input === "object") for (const [name,v] of Object.entries(input)) if (v&&typeof v==="object"&&"repo" in v&&typeof v.repo==="string") cache[name]={repo:repoName(v.repo),at:"at" in v&&typeof v.at==="string"?v.at:"cached",status:"status" in v&&typeof v.status==="number"?v.status:0};
  }
  const names = new Set([...observations.map(o=>o.remote),...targets.map(t=>repoHint(t.cwd)).filter(n=>/^[\w.-]{2,80}$/.test(n)&&!/[0-9a-f-]{20}/.test(n)).map(n=>`EtanHey/${n}`)]);
  const missing = [...names].filter(n=>n&&!cache[n]); let next=0;
  await Promise.all(Array.from({length:4},async()=>{for(;;){const name=missing[next++];if(!name)break;const proc=Bun.spawn(["gh","api",`repos/${name}`,"--jq",".full_name"],{stdout:"pipe",stderr:"ignore"});const repo=repoName((await new Response(proc.stdout).text()).trim());cache[name]={repo,at:new Date().toISOString(),status:await proc.exited};}}));
  writeFileSync(values.lookups,JSON.stringify(cache,null,2)+"\n");
  const lookup=new Map(Object.entries(cache).filter(([,v])=>v.repo).map(([k,v])=>[k,v.repo]));
  const evidence=deriveRepoEvidence(targets,observations,lookup);
  writeFileSync(values.out,evidence.map(e=>JSON.stringify(e)).join("\n")+"\n");
  writeFileSync(values.out+".observations.ndjson",observations.map(o=>JSON.stringify(o)).join("\n")+"\n");
  writeOut(JSON.stringify({targets:targets.length,evidence:evidence.length,lookups:lookup.size}));
}
