import { createReadStream, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { sha256, type Entry } from "./pipeline";

const tarReader = `import sys,json,tarfile,struct
wanted=set(json.loads(sys.stdin.buffer.readline()))
with tarfile.open(sys.argv[1], 'r|*') as archive:
 for member in archive:
  if member.name not in wanted or not member.isfile(): continue
  name=member.name.encode(); stream=archive.extractfile(member)
  sys.stdout.buffer.write(struct.pack('>IQ',len(name),member.size)+name)
  while True:
   chunk=stream.read(1024*1024)
   if not chunk: break
   sys.stdout.buffer.write(chunk)
  sys.stdout.buffer.flush()
`;

/** One native metadata-only snapshot: Python exposes st_flags, unlike Bun's Stats. */
export function datalessPaths(paths: readonly string[]): Set<string> {
  const program = `import os,json,sys
blocked=[]
for path in json.load(sys.stdin):
 try:
  if getattr(os.lstat(path),'st_flags',0) & 0x40000000: blocked.append(path)
 except OSError: pass
print(json.dumps(blocked))`;
  const proc=Bun.spawnSync(["python3","-c",program],{stdin:Buffer.from(JSON.stringify(paths)),stdout:"pipe",stderr:"ignore"});
  if(proc.exitCode!==0) throw Error("native dataless metadata probe failed; no source reads allowed");
  const value: unknown=JSON.parse(proc.stdout.toString());
  if(!Array.isArray(value)||!value.every((p):p is string=>typeof p==="string")) throw Error("invalid dataless metadata response");
  return new Set(value);
}

/** Sequential tar streaming, no extraction. Only the current member is held in memory. */
export function localSources(entries: Entry[], probe: (paths: readonly string[]) => ReadonlySet<string> = datalessPaths) {
  const supported = (e:Entry) => !["drive_file","drive_tarball_member","tarball_member","t3_sqlite","icloud"].includes(e.source_kind) && !/note=dataless/.test(e.sha256);
  const blocked = probe([...new Set(entries.flatMap(e=>supported(e)?[e.member_path]:["tarball_member","drive_tarball_member"].includes(e.source_kind)?[e.container]:[]))]);
  let current: { entry: Entry; bytes: Buffer } | null = null;
  const errors: { container: string; reason: string }[] = [];
  const readable = (path: string) => {
    try { const st = lstatSync(path); return st.isFile() && !st.isSymbolicLink() && !blocked.has(path); } catch { return false; }
  };
  async function fileHash(path: string) { try { const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest("hex"); } catch { errors.push({ container: path, reason: "container hash read failed" }); return ""; } }
  async function* order() {
    const archives = new Map<string, Entry[]>();
    const loose = entries.filter(e => !["tarball_member", "drive_tarball_member"].includes(e.source_kind));
    for (const e of loose.sort((a, b) => Number(b.source_kind === "live") - Number(a.source_kind === "live") || Number(b.bytes) - Number(a.bytes))) { if (supported(e) && e.member_path.endsWith(".zst") && readable(e.member_path)) e.container_hash = await fileHash(e.member_path); yield e; }
    for (const e of entries.filter(e => ["tarball_member", "drive_tarball_member"].includes(e.source_kind))) {
      const group = archives.get(e.container) ?? []; group.push(e); archives.set(e.container, group);
    }
    for (const [container, group] of archives) {
      if (!readable(container)) { for (const e of group) yield e; continue; }
      const valid: Entry[] = [];
      for (const e of group) {
        if (/^[a-f0-9]{64}$/.test(e.sha256)) valid.push(e);
        else { e.status="invalid_member_hash"; errors.push({container,reason:`expected member hash must be SHA-256 hex: ${e.member_path}`}); yield e; }
      }
      if (!valid.length) continue;
      const hash = await fileHash(container), remaining = new Map<string, Entry[]>();
      for (const e of valid) { const versions = remaining.get(e.member_path) ?? []; versions.push(e); remaining.set(e.member_path, versions); }
      if (!hash) { for (const e of valid) yield e; continue; }
      const proc = Bun.spawn(["python3", "-c", tarReader, container], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      proc.stdin.write(JSON.stringify([...remaining.keys()]) + "\n"); proc.stdin.end();
      const reader = proc.stdout.getReader(); let carry = Buffer.alloc(0);
      async function take(size: number) {
        const parts: Buffer[] = []; let left = size;
        while (left) {
          if (!carry.length) { const next = await reader.read(); if (next.done) throw new Error("truncated archive stream"); carry = Buffer.from(next.value); }
          const count = Math.min(left, carry.length); parts.push(carry.subarray(0, count)); carry = carry.subarray(count); left -= count;
        }
        return Buffer.concat(parts, size);
      }
      try {
        while (remaining.size) {
          const header = await take(12), name = (await take(header.readUInt32BE(0))).toString();
          const size = Number(header.readBigUInt64BE(4));
          if (size > 1024 ** 3) throw new Error("archive member exceeds 1 GiB memory guard");
          const bytes = await take(size), memberHash = sha256(bytes), versions = remaining.get(name) ?? [], e = versions.find(e => e.sha256 === memberHash);
          if (!e) continue;
          versions.splice(versions.indexOf(e), 1); if (!versions.length) remaining.delete(name);
          e.container_hash = hash; current = { entry: e, bytes }; yield e; current = null;
        }
      } catch { errors.push({ container, reason: "archive stream incomplete; remaining members need fetch/repair" }); }
      finally { current = null; await reader.cancel(); proc.kill(); await proc.exited; }
      for (const versions of remaining.values()) for (const e of versions) yield e;
    }
  }
  async function read(e: Entry) {
    if (current?.entry === e) { const bytes = current.bytes; return (async function* () { yield bytes; })(); }
    if (["drive_file", "drive_tarball_member", "tarball_member", "t3_sqlite", "icloud"].includes(e.source_kind) || /note=dataless/.test(e.sha256) || !readable(e.member_path)) return null;
    if (!e.member_path.endsWith(".zst")) return createReadStream(e.member_path);
    return (async function* () {
      const proc = Bun.spawn(["zstd", "-dc", "--", e.member_path], { stdout: "pipe", stderr: "ignore" });
      try { for await (const chunk of proc.stdout) yield chunk; if (await proc.exited !== 0) throw new Error("zstd decode failed"); }
      finally { proc.kill(); await proc.exited; }
    })();
  }
  return { read, order: order(), errors };
}
