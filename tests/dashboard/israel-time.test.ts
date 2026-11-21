// Orc ruling (2026-11-20 00:28): every dashboard time stays in Israel time and shows its zone beside it, so a phone
// abroad is not misled. The abbreviation comes from Asia/Jerusalem's offset on that date: IST in winter, IDT in summer.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { arrangement } from "../../src/dashboard/advice";
import { recommend } from "../../src/dashboard/server";
import { israelZone } from "../../src/dashboard/israel-time";

const WINTER = "2026-01-16T19:00:00Z"; // Fri 21:00 in Israel, UTC+2
const SUMMER = "2026-07-17T18:00:00Z"; // Fri 21:00 in Israel, UTC+3

/** The browser's own time()/when() from app.js, run in a vm (no DOM needed for these two). */
function browserClock() {
  const src = readFileSync("src/dashboard/app.js", "utf8");
  const fn = (name: string) => {
    const m = src.match(new RegExp("^function " + name + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m"));
    if (!m) throw Error("app.js has no top-level function " + name);
    return m[0];
  };
  const ctx: any = createContext({});
  runInContext([fn("israelZone"), fn("time"), fn("when")].join("\n") +
    "\nthis.time = time; this.when = when; this.israelZone = israelZone;", ctx);
  return ctx as { time(v: unknown): string; when(v: unknown): string; israelZone(d: Date): string };
}

const SEASONS = [
  { season: "winter", at: WINTER, zone: "IST", stamp: "16/01/2026, 21:00:00 IST", day: /^Fri 16 Jan(,| at) 21:00 IST \(/ },
  { season: "summer", at: SUMMER, zone: "IDT", stamp: "17/07/2026, 21:00:00 IDT", day: /^Fri 17 Jul(,| at) 21:00 IDT \(/ },
];
for (const { season, at, zone, stamp, day } of SEASONS) {
  test(`app.js time() labels a ${season} time ${zone}`, () => {
    expect(browserClock().time(at)).toBe(stamp);
  });
  test(`app.js when() labels a ${season} reset ${zone}`, () => {
    expect(browserClock().when(at)).toMatch(day); // Chrome joins with ",", Bun's ICU with " at"
  });
  test(`arrangement() reason names the ${season} reset as Fri 21:00 ${zone}`, () => {
    const meter = (u: number) => ({ utilization: u, stale: false, reset: at });
    const c = (email: string, u: number) => ({ email, status: "active", weekly: meter(u), fable: meter(u), resets: { left: 2 } });
    expect(arrangement([c("h", 1), c("e", .4)], Date.parse(at) - 86400_000).reason).toContain(`resets Fri 21:00 ${zone},`);
  });
  test(`recommend() reason names the ${season} weekly reset as Fri 21:00 ${zone}`, () => {
    const r = recommend({ email: "a", weekly: { utilization: 1, stale: false, reset: at }, fable: { utilization: .5, stale: false } },
      {}, Date.parse(at) - 86400_000);
    expect(r.reason).toContain(`(resets Fri 21:00 ${zone})`);
  });
}

test("browser and server agree on the zone every 6 h through 2026, both DST changes included", () => {
  const browser = browserClock();
  const seen = new Set<string>();
  for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2027-01-01T00:00:00Z"); t += 6 * 3600_000) {
    const d = new Date(t);
    expect(browser.israelZone(d)).toBe(israelZone(d));
    seen.add(israelZone(d));
  }
  expect([...seen].sort()).toEqual(["IDT", "IST"]);
});
