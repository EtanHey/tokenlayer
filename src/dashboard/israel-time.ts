// Every dashboard time is Israel time with its zone beside it ("Fri 21:00 IST"), so a phone abroad is not misled.
// The abbreviation follows Asia/Jerusalem's offset on that date (ICU only offers "GMT+2"/"GMT+3" for the zone).
// app.js carries the same israelZone() for the browser; tests/dashboard/israel-time.test.ts pins both.
const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", timeZoneName: "shortOffset" });
export function israelZone(d: Date) {
  const off = offset.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return off === "GMT+2" ? "IST" : off === "GMT+3" ? "IDT" : off;
}
/** "Fri 21:00 IST": weekday and clock in Israel, then the zone in force at that instant. */
export function israelClock(d: Date) {
  return d.toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit" }) +
    " " + israelZone(d);
}
