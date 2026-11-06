import { expect, test } from "bun:test";
import { REDACTED, redactText } from "../../src/lib/redact";

// Exact synthetic reproductions from the path probe; no credential material.
const paths = [
  "/Users/happycampr/.t3/worktrees/tokenlayer/t3-ba23bdb1/.local/tokenlayer-restore-ERa284/out/restore-e2H7zS/session.jsonl",
  "/Users/happycampr/Gits/tokenlayer/docs.local/full-history/baseline-context-fix/scratch/candidate-4wgjgvck/.local/tokenlayer-restore-ERa284/out/restore-e2H7zS/session.jsonl",
  "/Users/happycampr/Gits/tokenlayer/.local/tokenlayer-restore-ERa284/out/restore-e2H7zS/session.jsonl",
  "/home/runner/work/tokenlayer/tokenlayer/.local/tokenlayer-restore-ERa284/out/restore-e2H7zS/session.jsonl",
];

test("attacker-labelled paths retain opaque credential protection", () => {
  const secret = "R8vK2qM7xP4nY9bF3wH6sJ1d";
  for (const label of ["file=", "path: ", "cwd=", "docs "]) {
    for (const path of [`/tmp/.${secret}`, `/tmp/.prefixsk-proj-${secret}/receipt.json`]) {
      let input = `password hint ${label}${path}`;
      for (let depth = 0; depth < 3; depth++, input = JSON.stringify(input)) {
        expect(redactText(input)).not.toContain(secret);
      }
    }
  }
});

// Real key shapes with fake values. A path label never exempts these earlier rules.
const shaped = [
  "sk-ant-api03-SYNTHETICfake01234567890123456789",
  "sk-ant-oat01-SYNTHETICfake01234567890123456789",
  "sk-proj-SYNTHETICfake01234567890123456789",
  "sk_live_SYNTHETICfake0123456789",
  "ghp_SYNTHETICfake01234567890123456789",
  "github_pat_SYNTHETICfake01234567890123456789",
  "glpat-SYNTHETICfake01234567890123456789",
  "xoxb-SYNTHETICfake0123456789",
  "AKIAFAKE123456789012",
  "AIzaSYNTHETICfake0123456789012345678901",
  "ya29.SYNTHETICfake01234567890123456789",
  "1//0SYNTHETICfake01234567890123456789",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlZmFrZQ",
];

test("key shapes inside and beside dotted paths stay redacted at every echo depth", () => {
  for (const key of shaped) {
    for (const input of [
      `file=${paths[0]}/${key}/receipt.json`,
      `file=${paths[1]}.${key}.log`,
      `file=${paths[0]}\nupstream rejected ${key}`,
    ]) {
      let encoded = input;
      for (let depth = 0; depth < 3; depth++, encoded = JSON.stringify(encoded)) {
        const out = redactText(encoded);
        expect(out).not.toContain(key);
        expect(out).toContain(REDACTED);
        expect(redactText(out)).toBe(out);
        if (depth) expect(() => JSON.parse(out)).not.toThrow();
      }
    }
  }
});

test("named passwords, tokens, secrets and auth values in paths/logs stay redacted", () => {
  const value = "SYNTHETICopaqueCredential0123456789";
  for (const name of ["password", "api_key", "access_token", "client_secret", "Authorization", "Cookie"]) {
    for (const input of [
      `file=${paths[0]}/${name}=${value}/receipt.json`,
      `file=${paths[1]}?${name}=${value}&count=123`,
      `file=${paths[0]}\n${name}: ${value}\nrows=4`,
    ]) {
      const out = redactText(input);
      expect(out).not.toContain(value);
      expect(out).toContain(REDACTED);
    }
  }
});

test("a labelled path does not exempt nearby opaque prose or unlabelled dotted tails", () => {
  const opaque = "Q7mV2xB9nK4pR8tY3uH6dF1s";
  for (const suffix of [` password hint ${opaque}`, `\nsecret hint ${opaque}`, `. ${opaque} cookie hint`]) {
    expect(redactText(`file=${paths[0]}${suffix}`)).not.toContain(opaque);
  }
  expect(redactText(`password hint prefix.${opaque}`)).not.toContain(opaque);
  expect(redactText(`password hint file=relative.${opaque}`)).not.toContain(opaque);
});

test("registered secrets and encoded forms in dotted paths still pass through exact stripping", async () => {
  // Separate process so synthetic registration never changes other tests' egress state.
  const proc = Bun.spawn([process.execPath, "-e", `
    import { registerSecrets, sanitizeOutput } from './src/lib/egress';
    const value = 'SYNTHETIC opaque/+?=credential';
    registerSecrets({ CUSTOM_PASSWORD: value });
    const forms = [value, encodeURIComponent(value),
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, v => v.toLowerCase()),
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
    for (const form of forms) {
      for (const input of ['file=' + ${JSON.stringify(paths[1])} + '.' + form + '.log',
        'file=' + ${JSON.stringify(paths[0])} + '\\nfailed ' + form]) {
        const out = sanitizeOutput(input);
        if (out.includes(form) || !out.includes('[redacted]')) process.exit(3);
      }
    }
  `], { cwd: new URL("../..", import.meta.url).pathname, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await new Response(proc.stderr).text()).toBe("");
  expect(await proc.exited).toBe(0);
});

test("only verified local restore receipts use the structured path channel", async () => {
  const script = `
    import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    import { writeVerifiedRestoreReceipt, registerSecrets } from './src/lib/egress';
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'structured-receipt-')));
    try {
      const dotted = join(parent, '.t3', 'worktrees', 'tokenlayer', 't3-ba23bdb1', '.local');
      mkdirSync(dotted, {recursive:true});
      const dir = mkdtempSync(join(dotted, 'restore-'));
      const file = join(dir, 'session.jsonl');
      const bytes = Buffer.from('synthetic transcript\\n');
      writeFileSync(file, bytes, {mode:0o600});
      const receipt = { file, sha256:createHash('sha256').update(bytes).digest('hex'), bytes:bytes.length,
        rows:1, scope:'archived-contiguous-prefix', sourceComplete:'unknown' };
      writeFileSync(join(dir,'receipt.json'), JSON.stringify(receipt), {mode:0o600});
      const mode = process.argv.at(-1);
      if (mode === 'changed') writeFileSync(file, Buffer.alloc(bytes.length, 120));
      if (mode === 'fake') receipt.rows = 2;
      if (mode === 'secret') registerSecrets({CUSTOM_SECRET:'t3-ba23bdb1'});
      writeVerifiedRestoreReceipt(receipt);
    } finally { rmSync(parent, {recursive:true, force:true}); }
  `;
  for (const mode of ['valid', 'changed', 'fake', 'secret']) {
    const proc = Bun.spawn([process.execPath, '-e', script, mode], {
      cwd: new URL('../..', import.meta.url).pathname, env: {PATH:process.env.PATH}, stdout:'pipe', stderr:'pipe',
    });
    const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (mode === 'changed' || mode === 'fake') { expect(code).not.toBe(0); expect(out).toBe(''); }
    else {
      expect(code).toBe(0);
      expect(out).toContain('file=');
      expect(out).toContain('scope=archived-contiguous-prefix');
      if (mode === 'valid') { expect(out).toContain('t3-ba23bdb1'); expect(out).not.toContain(REDACTED); }
      else { expect(out).not.toContain('t3-ba23bdb1'); expect(out).toContain(REDACTED); }
    }
  }
});
