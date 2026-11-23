// D2 render test: the real page and app.js in headless Chrome at 390 px (phone) and 1280 px, through CDP device
// emulation. Read-only: GETs only, nothing is clicked. Skips (and says so) when no Chrome/Chromium is installed;
// set CHROME_BIN to point at one. D2_SHOTS=<dir> also writes the screenshots there.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHub } from "../fable/fixtures";
import { createHandler } from "../../src/dashboard/server";
import { page } from "../../src/dashboard/page";
import type { M4Snapshot } from "../../src/dashboard/tools";

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  Bun.which("google-chrome"), Bun.which("google-chrome-stable"), Bun.which("chromium"), Bun.which("chromium-browser"),
];
const chrome = CANDIDATES.find((p): p is string => !!p && existsSync(p));
if (!chrome) console.log("[tokenlayer tests] SKIPPING dashboard render tests: no Chrome/Chromium (set CHROME_BIN). Skipped is not passed.");

const now = Date.now();
const usage = (ageMs: number) => JSON.parse(readFileSync(import.meta.dir + "/fixtures/all-tools/usage-fresh.json", "utf8")
  .replaceAll("__NOW__", new Date(now - ageMs).toISOString())
  .replaceAll("__IN_3H__", new Date(now + 3 * 3600_000).toISOString())
  .replaceAll("__IN_6D__", new Date(now + 6 * 86400_000).toISOString()));
const STATES: Record<string, M4Snapshot> = {
  fresh: { state: "fresh", usage: usage(30_000), fetched_at: now },
  asleep: { state: "asleep", usage: usage(50 * 60_000), fetched_at: now - 50 * 60_000 },
  missing: { state: "missing", usage: null, fetched_at: null },
};

const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
let socket: WebSocket | undefined;
afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 0, method: "Browser.close" }));
  for (const p of procs) {
    const timer = setTimeout(() => { if (p.exitCode === null) p.kill("SIGTERM"); }, 3000);
    try { await p.exited; } finally { clearTimeout(timer); }
  }
  socket?.close();
  for (const d of dirs) {
    for (let attempt = 0;; attempt++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt >= 9 || !["ENOTEMPTY", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await Bun.sleep(100);
      }
    }
  }
});

function serve(snap: M4Snapshot) {
  const dir = mkdtempSync(tmpdir() + "/dash-render-");
  dirs.push(dir);
  const handler = createHandler({
    logins: ["render"], origin: "http://127.0.0.1", secret: "s", hub: fakeHub() as any,
    ch: { queryJSON: async () => [] as any }, path: dir + "/state.json", events: dir + "/events.jsonl",
    page, m4: async () => snap,
  });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(r) {
    if (r.method !== "GET") return new Response("render test is read-only", { status: 405 });
    const h = new Headers(r.headers);
    h.set("Tailscale-User-Login", "render");
    return handler(new Request(r.url, { headers: h }));
  } });
}

const LAUNCH_TIMEOUT_MS = 60_000;
let shared: Awaited<ReturnType<typeof launch>>;
// Startup has its own budget: a slow CI cold start must not consume a render test's timeout.
// Throw from the suite hook once, so launch failure blocks every render without a rejected-promise cascade.
beforeAll(async () => {
  if (!chrome) return;
  try {
    shared = await launch();
  } catch (cause) {
    throw new Error("Dashboard render tests: Chrome startup failed; all renders blocked", { cause });
  }
}, LAUNCH_TIMEOUT_MS + 5_000);
async function launch() {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error(`Chrome did not become ready within ${LAUNCH_TIMEOUT_MS} ms`);
    if (p.exitCode !== null) throw new Error(`Chrome exited before startup (exit ${p.exitCode})`);
    return ms;
  };
  // Short profile name leaves room for Chrome's Linux singleton socket below TMPDIR.
  const dir = mkdtempSync(tmpdir() + "/c-");
  dirs.push(dir);
  const p = Bun.spawn([chrome!, "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-extensions", ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank"], { env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir }, stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  const portFile = join(dir, "DevToolsActivePort");
  while (!existsSync(portFile)) { remaining(); await Bun.sleep(50); }
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  let targets: any[] = [];
  while (!targets.some((t) => t.type === "page")) {
    const signal = AbortSignal.timeout(remaining());
    targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal })
      .then(r => r.json()).catch(() => []);
    if (!targets.some((t) => t.type === "page")) await Bun.sleep(50);
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome CDP connection timed out")), remaining());
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Chrome CDP connection failed")); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error("Chrome CDP closed during startup")); };
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m.result); };
  const send = (method: string, params = {}) => new Promise<any>((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  return { send, evaluate };
}

const MEASURE = `JSON.stringify({
  inner: innerWidth, scroll: document.documentElement.scrollWidth,
  rows: [...document.querySelectorAll('#tools li')].map(li => ({ mark: li.dataset.mark, text: li.innerText })),
  columns: getComputedStyle(document.querySelector('#tools li')).gridTemplateColumns.split(' ').length,
  wide: [...document.querySelectorAll('#all-tools *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1)
    .map(e => e.tagName + '.' + e.className),
  source: document.querySelector('#tools-source').textContent,
  top: document.querySelector('#all-tools').getBoundingClientRect().top,
})`;

for (const [name, snap] of Object.entries(STATES))
  for (const width of [390, 1280])
    test.skipIf(!chrome)(`renders the All tools panel at ${width} px (${name} M4)`, async () => {
      const server = serve(snap);
      const b = shared;
      try {
        await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: width < 600 ? 2 : 1, mobile: width < 600 });
        await b.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
        let m: any;
        for (let i = 0; i < 100; i++) {
          m = JSON.parse((await b.evaluate(`document.querySelectorAll('#tools li').length ? ${MEASURE} : "{}"`)) ?? "{}");
          if (m.rows?.length) break;
          await Bun.sleep(100);
        }
        expect(m.rows.map((r: any) => r.text.split("\n")[0])).toEqual(["Claude · a", "Claude · b", "Codex", "Cursor", "Antigravity", "Kiro"]);
        expect(m.inner).toBe(width);
        expect(m.scroll).toBeLessThanOrEqual(width); // no sideways scroll on a phone
        expect(m.wide).toEqual([]);
        expect(m.columns).toBe(width < 760 ? 1 : 4);
        expect(m.top).toBeLessThan(900); // first thing under the header, on screen without scrolling
        const by = Object.fromEntries(m.rows.map((r: any) => [r.text.split("\n")[0], r]));
        expect(by.Kiro.mark).toBe("UNKNOWN");
        expect(by.Kiro.text).toContain("UNKNOWN");
        expect(by["Claude · a"].text).toMatch(/\d+% of 7d/);
        if (name === "fresh") {
          expect(by.Codex.mark).toBe("OK");
          expect(by.Codex.text).toContain("100% of 7d");
          expect(by.Codex.text).toMatch(/Resets \w{3} \d+ \w{3}, \d\d:\d\d (IST|IDT) \(in 3 h\)/);
          expect(by.Codex.text).toContain("7 d: 948 sessions · 38.9K req · 143.7M tok");
          expect(by.Kiro.text).toContain("7 d: 1 session · 89 req · 9.2 credits");
          expect(by.Cursor.text).toContain("24 h / 7 d use: no data");
        }
        if (name === "asleep") {
          for (const t of ["Codex", "Cursor", "Antigravity"]) {
            expect(by[t].mark).toBe("STALE");
            expect(by[t].text).toContain("M4 asleep; reading 50 min old");
          }
          expect(m.source).toContain("M4 asleep");
        }
        if (name === "missing") for (const t of ["Codex", "Cursor", "Antigravity", "Kiro"]) {
          expect(by[t].mark).toBe("UNKNOWN");
          expect(by[t].text).toContain("M4 usage.json missing");
        }
        if (process.env.D2_SHOTS) {
          const h = await b.evaluate("document.documentElement.scrollHeight");
          await b.send("Emulation.setDeviceMetricsOverride", { width, height: Math.min(h, 6000), deviceScaleFactor: width < 600 ? 2 : 1, mobile: width < 600 });
          await Bun.sleep(300);
          const shot = await b.send("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(process.env.D2_SHOTS, `fixture-${name}-${width}.png`), Buffer.from(shot.data, "base64"));
        }
      } finally {
        await b.send("Page.navigate", { url: "about:blank" });
        server.stop(true);
      }
    }, 30_000);
