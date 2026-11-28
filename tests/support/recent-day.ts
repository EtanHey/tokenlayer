import { join } from "node:path";

// Synthetic macOS home for path-attribution fixtures; never an operator home.
export const FIXTURE_HOME = join("/", "Users", "example");

// Anchor once per test process so repeated serializations keep identical source bytes.
// Archive/replay fixtures must stay inside the real 30-day TTL and replay cutoff.
const today = new Date().toISOString().slice(0, 10);

export function recentDay(daysAgo = 0): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * 86400000).toISOString().slice(0, 10);
}
