#!/usr/bin/env bun
// After the Friday stack merges: every install step on both Macs, in the order the receipts need, for one commit on
// main. Dry run by default: it reads state and prints every step, command, check and rollback, and changes nothing.
//   bun scripts/after-merge-install.ts --commit <full or short hex sha on origin/main> [--apply] [--clickhouse-window]
// --apply runs the steps on the M1 (here) and the M4 (ssh macbook-pro). Each step skips when it is already in place,
// checks itself after it runs, and the first failure stops the run and prints the rollback for every step it changed.
// docs/after-merge-install.md lists where each step and its order come from. R12's repartition is not here: own window.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Mac = 'm1' | 'm4';
/** probe: read-only (the only kind a dry run sends); apply: changes something; verify: read-only check after apply. */
export type Kind = 'probe' | 'apply' | 'verify';
export type Result = { code: number; out: string };
/** id: the step the call belongs to, or 'lock' for the M1 heavy lock. */
export type Exec = (mac: Mac, script: string, kind: Kind, id: string) => Promise<Result>;

export type Step = {
  id: string;
  mac: Mac;
  title: string;
  /** The receipts this step and its place in the order come from. */
  from: string;
  /** Steps that must have run first; the plan is checked against these. */
  after: string[];
  /** Read-only. Exit 0: already in place, so apply is skipped (the check still runs). */
  done?: string;
  /** Read-only. Its output is handed to verify and rollback as $BEFORE (a PID, a run count, the old pin). */
  capture?: string;
  apply: string[];
  /** Read-only. Exit 0: the step is in place. */
  verify: string;
  /** What verify proves, in words, for the dry-run listing. */
  checks: string;
  /** A second read-only check that runs on another Mac (the M4 ship's heartbeat lands in the M1's ClickHouse). */
  health?: { mac: Mac; script: string; checks: string };
  /** Printed, never run. $BEFORE is replaced with what capture read. */
  rollback: string;
};

export type Options = { sha: string; stamp: string; clickhouse: string; clickhouseWindow?: boolean };

const LANE = 'tokenlayer-after-merge';
const job = (name: string) => `com.tokenlayer.${name}`;

const FULL = /^[0-9a-f]{40}$/;
/** The run's values go into bash on both Macs: refuse anything but a full SHA and a plain stamp before a script exists. */
function assertOptions(o: Options) {
  if (!FULL.test(o.sha)) throw Error(`not a full commit SHA: ${JSON.stringify(o.sha)}`);
  if (!/^\d{8}T\d{6}Z$/.test(o.stamp)) throw Error(`bad stamp: ${JSON.stringify(o.stamp)}`);
}

/**
 * --commit as typed (full or short hex only) to the full commit SHA, with git's argv, never a shell. Anything else,
 * a name, an option, a tree or an unknown object, is refused. Runs before any script is built, dry run included.
 */
export function resolveCommit(repo: string, input: string) {
  if (!/^[0-9a-f]{7,40}$/.test(input)) throw Error(`--commit takes a full or short hex SHA, not ${JSON.stringify(input)}`);
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${input}^{commit}`], { encoding: 'utf8' });
  const sha = r.stdout.trim();
  if (r.status !== 0 || !FULL.test(sha)) throw Error(`--commit ${input} is not a commit here (fetch first)`);
  return sha;
}

/** Shared bash for every script on either Mac. Secrets are only ever read inside a subshell, never printed. */
export function prelude(mac: Mac, o: Options) {
  assertOptions(o);
  return [
    'set -euo pipefail',
    'export PATH=/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    `S=${quote(o.sha)}; MAC=${mac}`,
    'REPO=$HOME/Gits/tokenlayer; TL=$HOME/.config/tokenlayer; APP=$TL/app/$S; CUR=$TL/app/current',
    `LA=$HOME/Library/LaunchAgents; D=gui/$(id -u); B=$TL/backups/after-merge-${quote(o.stamp)}; MARK=$TL/after-merge/$S`,
    `CH="$HOME"/${quote(o.clickhouse)}`,
    // Reader (capped) login unless a second env file is named; clickhouse-writer.env sets the writer.
    'chq() { ( set -a; . "$TL/clickhouse.env"; [[ -n ${2:-} ]] && . "$TL/$2"; set +a; "$CH" client --port 19000 --user "$CLICKHOUSE_USER" -q "$1" ); }',
    // One top-level field of a loaded job (pid, runs, state, program, "last exit code"); empty when not loaded.
    'lf() { launchctl print "$D/$1" 2>/dev/null | sed -n "s/^\t$2 = //p" | head -1 || true; }',
    // Wait up to $1 seconds for a condition.
    'within() { local n=$1; shift; for ((i = 0; i < n; i += 5)); do "$@" && return 0; sleep 5; done; "$@"; }',
    // A KeepAlive job came back on another PID than $2.
    'new_pid() { local p; p=$(lf $1 pid); [[ -n $p && $p != "$2" ]]; }',
    // An interval job ran again since $2 runs (kickstart keeps the count) and exited 0.
    'fresh_runs() { [[ $(lf $1 runs) -gt ${2:-0} && $(lf $1 "last exit code") == 0 ]]; }',
    // A reloaded job (bootout + bootstrap resets the count) finished a run with exit 0.
    'ran_ok() { [[ $(lf $1 "last exit code") == 0 ]]; }',
    // The newest ship heartbeat of Mac $1 in the last 2 min is ok.
    "beat_ok() { [[ $(chq \"SELECT argMax(result, ingested_at) FROM tokenlayer.ship_heartbeat WHERE machine = '$1' AND ingested_at > now() - 120\") == ok ]]; }",
    'ping_ok() { curl -fsS -m 5 http://127.0.0.1:8123/ping >/dev/null; }',
  ].join('\n');
}

/** A KeepAlive or interval job: move its plist off the checkout (R10 repoint) or, once moved, restart it on the new pin. */
function launchJob(o: Options, mac: Mac, name: string, extra: Partial<Step> & { from: string; title: string; after: string[] }, interval = false): Step {
  const label = job(name);
  const reload = `bun -e "import { replaceService } from '$APP/scripts/deploy/launchd.ts'; await replaceService('${label}', '$LA/${label}.plist')"`;
  return {
    id: `${mac}-${name}`,
    mac,
    capture: interval ? `echo $(lf ${label} runs)` : `echo $(lf ${label} pid)`,
    apply: [
      'mkdir -m 700 -p "$B"',
      `cp -p "$LA/${label}.plist" "$B/"`,
      `if grep -q "<string>$REPO" "$LA/${label}.plist"; then bun "$APP/scripts/deploy/pin.ts" repoint "$LA/${label}.plist"; plutil -lint "$LA/${label}.plist"; ${reload}; ` +
        (interval ? 'fi' : `else launchctl kickstart -k "$D/${label}"; fi`),
    ],
    verify: [
      `! grep -q "<string>$REPO" "$LA/${label}.plist"`,
      `grep -q "$CUR/" <<<"$(launchctl print "$D/${label}")"`,
      // A KeepAlive job must come back on a new PID and stay up; an interval job has no PID between runs.
      // A rerun that skipped the apply restarted nothing, so it only needs the job running.
      ...(interval ? [] : [
        `{ [[ $APPLIED == 0 ]] || within 30 new_pid ${label} "$BEFORE"; }`,
        'sleep 10',
        `[[ $(lf ${label} state) == running ]]`,
      ]),
    ].join(' && '),
    checks: `plist off the checkout, launchd runs app/current${interval ? '' : ', new PID still running after 10 s'}`,
    rollback: `cp -p "$B/${label}.plist" "$LA/" && launchctl bootout "$D/${label}"; launchctl bootstrap "$D" "$LA/${label}.plist"   # back on the checkout`,
    ...extra,
  };
}

/** Build one bundle from the pinned tree; replace the installed one only when it differs, keeping the old in backups. */
function bundle(o: Options, mac: Mac, name: string, entry: string, extra: { from: string; title: string; after: string[] }): Step {
  const live = `$TL/bin/${name}.js`;
  const label = job(name);
  return {
    id: `${mac}-${name}-bundle`,
    mac,
    capture: `echo $(lf ${label} runs)`,
    apply: [
      'mkdir -m 700 -p "$B"',
      `(cd "$APP" && bun build ${entry} --target=bun --outfile "$TL/bin/.${name}.js.new")`,
      `if cmp -s "$TL/bin/.${name}.js.new" "${live}"; then rm "$TL/bin/.${name}.js.new"; echo "${name}.js unchanged"; ` +
        `else cp -p "${live}" "$B/${name}.js" 2>/dev/null || true; mv "$TL/bin/.${name}.js.new" "${live}"; launchctl kickstart -k "$D/${label}"; fi`,
      `shasum -a 256 "${live}" | cut -c1-16`,
    ],
    // StartInterval 60: a run after the install must exit 0 within 90 s, whether or not the bundle changed.
    verify: `[[ $APPLIED == 0 ]] || within 90 fresh_runs ${label} "$BEFORE"`,
    checks: 'bundle built from the pinned tree is the installed one; a launchd run after it exits 0',
    rollback: `[[ -f "$B/${name}.js" ]] && cp -p "$B/${name}.js" "${live}" && launchctl kickstart -k "$D/${label}"`,
    ...extra,
  };
}

/**
 * setup.sh drift from the pinned tree (a dry run before the pin falls back to this checkout, and says so). Exit 1 with
 * DRIFT lines is drift; any other failure (no tree, a crash) fails too. Outside a ClickHouse window its plist stays on
 * the checkout (R10), so with allowClickhouse that drift, and only that, passes.
 */
export function drift(mac: Mac, allowClickhouse: boolean) {
  return [
    'tree=$APP; [[ -d $tree ]] || { [[ -f $SELF/scripts/deploy/jobs.ts ]] || { echo "no pinned tree yet: drift runs after the pin"; exit 3; }; tree=$SELF; echo "(no pin yet: drift rendered by $SELF)"; }',
    `set +e; out=$("$tree/scripts/deploy/setup.sh" drift ${mac} 2>&1); rc=$?; set -e; echo "$out"`,
    '(( rc == 0 )) && exit 0',
    allowClickhouse
      ? `(( rc == 1 )) && grep -q '^DRIFT clickhouse:' <<<"$out" && [[ $(grep '^DRIFT ' <<<"$out" | grep -vc '^DRIFT clickhouse:' || true) == 0 ]] && echo "only clickhouse drifts: it waits for its window (R10)"`
      : 'exit 1',
  ].join('\n');
}

/** The steps, in the order they run. Every M1 step runs here; every M4 step over ssh macbook-pro. */
export function plan(o: Options): Step[] {
  const steps: Step[] = [
    // ── Preflight: read-only, before anything changes ──
    {
      id: 'm1-commit', mac: 'm1', title: 'the commit is a full SHA on origin/main', from: 'R10 §4 A (pin a main SHA)', after: [],
      apply: [],
      verify: '[[ $S =~ ^[0-9a-f]{40}$ ]] && git -C "$SELF" cat-file -e "$S^{commit}" && git -C "$SELF" merge-base --is-ancestor "$S" origin/main',
      checks: 'full SHA, present here, an ancestor of origin/main (fetch first)', rollback: '',
    },
    {
      id: 'm4-reachable', mac: 'm4', title: 'the M4 answers over ssh', from: 'R2 §2 (same ssh options)', after: [],
      apply: [], verify: 'echo "reachable; booted $(sysctl -n kern.boottime | sed "s/.*} //")"', checks: 'ssh -o BatchMode=yes -o ConnectTimeout=5 exits 0', rollback: '',
    },
    // ── Code on disk: root checkouts at S, then the pinned release (nothing runs it until a job is repointed) ──
    ...(['m1', 'm4'] as const).map((mac): Step => ({
      id: `${mac}-checkout`, mac, title: 'root checkout fast-forwarded to the commit', from: 'Sol brief §5 (pull the root checkout), R10 §4 A', after: [mac === 'm1' ? 'm1-commit' : 'm4-reachable'],
      done: '[[ $(git -C "$REPO" rev-parse HEAD) == "$S" ]]',
      capture: 'git -C "$REPO" rev-parse HEAD',
      apply: [
        'git -C "$REPO" fetch -q origin',
        '[[ $(git -C "$REPO" symbolic-ref --short HEAD) == main ]] || { echo "root checkout is not on main"; exit 1; }',
        'git -C "$REPO" diff --quiet HEAD || { echo "root checkout has local changes"; exit 1; }',
        'git -C "$REPO" merge --ff-only "$S"',
      ],
      verify: '[[ $(git -C "$REPO" rev-parse HEAD) == "$S" ]]', checks: 'HEAD is the commit, on main',
      rollback: 'git -C ~/Gits/tokenlayer reset --keep $BEFORE   # only until the jobs leave the checkout',
    })),
    ...(['m1', 'm4'] as const).map((mac): Step => ({
      id: `${mac}-pin`, mac, title: 'pinned release app/<sha>, current flipped', from: 'R10 §4 A', after: [`${mac}-checkout`],
      done: '[[ $(readlink "$CUR") == "$S" && $(cat "$APP/.tokenlayer-commit") == "$S" ]]',
      capture: 'readlink "$CUR" || echo none',
      apply: ['"$REPO/scripts/deploy/setup.sh" pin "$S"'],
      verify: '[[ $(readlink "$CUR") == "$S" && $(cat "$APP/.tokenlayer-commit") == "$S" ]]', checks: 'current → <sha>, marker matches',
      rollback: '[[ $BEFORE == none ]] || ~/Gits/tokenlayer/scripts/deploy/setup.sh use $BEFORE',
    })),
    // ── ClickHouse (M1): config before views (R5's views fit the cap only with the reader profile), tables before code ──
    {
      id: 'm1-clickhouse-config', mac: 'm1', title: 'clickhouse.xml from the template: reader cap, writer login, window-order read', from: 'R4, R5 §4, R6 (setup.sh config), Sol §5', after: ['m1-pin'],
      done: `[[ -d $APP ]] || exit 3; (cd "$APP" && bun -e "import { clickhouseConfig } from './scripts/deploy/deploy.ts'; import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs'; process.exit(clickhouseConfig() === readFileSync(process.env.HOME + '/.config/tokenlayer/clickhouse.xml', 'utf8') ? 0 : 1)")`,
      capture: 'chq "SELECT uptime()"',
      apply: ['"$APP/scripts/deploy/setup.sh" config'],
      verify: [
        `(cd "$APP" && bun -e "import { clickhouseConfig } from './scripts/deploy/deploy.ts'; import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs'; process.exit(clickhouseConfig() === readFileSync(process.env.HOME + '/.config/tokenlayer/clickhouse.xml', 'utf8') ? 0 : 1)")`,
        '[[ $(chq "SELECT getSetting(\'max_memory_usage\')") == 8589934592 ]]',
        '[[ $(chq "SELECT getSetting(\'optimize_read_in_window_order\')") == true ]]',
        '[[ $(chq "SELECT getSetting(\'max_memory_usage\')" clickhouse-writer.env) == 0 ]]',
        '[[ $(stat -f %Lp "$TL/clickhouse-writer.env") == 600 ]]',
        '(( $(chq "SELECT uptime()") >= ${BEFORE:-0} ))',
      ].join(' && '),
      checks: 'live file = render; tokenlayer capped at 8 GiB with window-order read; writer logs in uncapped; writer env 600; no restart (uptime grew)',
      rollback: 'cp -p "$(ls -t ~/.config/tokenlayer/backups/clickhouse.xml.* | head -1)" ~/.config/tokenlayer/clickhouse.xml && (set -a; . ~/.config/tokenlayer/clickhouse.env; set +a; "$CH" client --port 19000 --user "$CLICKHOUSE_USER" -q "SYSTEM RELOAD CONFIG")',
    },
    {
      id: 'm4-writer-env', mac: 'm4', title: 'the M4 has the writer login env', from: 'R6 §3 M4', after: ['m4-pin', 'm1-clickhouse-config'],
      done: '[[ $(stat -f %Lp "$TL/clickhouse-writer.env") == 600 ]] && grep -qx CLICKHOUSE_USER=tokenlayer_writer "$TL/clickhouse-writer.env"',
      apply: ['"$APP/scripts/deploy/copy-password.sh" m1 clickhouse-writer.env </dev/null'],
      verify: '[[ $(stat -f %Lp "$TL/clickhouse-writer.env") == 600 ]] && grep -qx CLICKHOUSE_USER=tokenlayer_writer "$TL/clickhouse-writer.env"',
      checks: 'clickhouse-writer.env mode 600, user tokenlayer_writer (value of the password never read)', rollback: 'nothing reads it until the M4 ship restarts; leave it',
    },
    {
      id: 'm1-schema', mac: 'm1', title: 'tables 008a and 012, views 006 and 009 (one file each, as tokenlayer)', from: 'J2 (#175 008a), R5 (#181), C1 (#187), R7 (#191), H1 (#200 012), Sol §5', after: ['m1-clickhouse-config'],
      apply: [
        'mkdir -m 700 -p "$B"',
        'chq "SHOW CREATE TABLE tokenlayer.v_session_events_context FORMAT TSVRaw" > "$B/006.sql"',
        'chq "SHOW CREATE TABLE tokenlayer.v_provider_usage_compare FORMAT TSVRaw" > "$B/009.sql"',
        // Single files, not schema:apply: that re-runs every file and migrateSessionSchema (Sol §5).
        'for f in 008a_systemone_calls 006_session_context 009_provider_usage_compare 012_ship_heartbeat; do ( set -a; . "$TL/clickhouse.env"; set +a; "$CH" client --port 19000 --user "$CLICKHOUSE_USER" --queries-file "$APP/schema/$f.sql" ); echo "applied $f"; done',
      ],
      verify: [
        '[[ $(chq "EXISTS TABLE tokenlayer.systemone_calls") == 1 && $(chq "EXISTS TABLE tokenlayer.ship_heartbeat") == 1 ]]',
        'v9=$(chq "SHOW CREATE TABLE tokenlayer.v_provider_usage_compare FORMAT TSVRaw")',
        'grep -q raw_has_created_at <<<"$v9" && grep -q 7d-utilization <<<"$v9" && grep -q typesafe <<<"$v9"',
        'grep -q token_total <<<"$(chq "SHOW CREATE TABLE tokenlayer.v_session_events_context FORMAT TSVRaw")"',
        'chq "SELECT * FROM tokenlayer.v_provider_usage_compare LIMIT 0" && chq "SELECT * FROM tokenlayer.v_session_events_context LIMIT 0"',
      ].join(' && '),
      checks: 'both tables exist; 009 has R7 columns, C1 peaks from proxy_usage and J2 typesafe; 006 reads token_total; both views bind',
      rollback: 'for v in 006 009; do sed "1s/^CREATE VIEW/CREATE OR REPLACE VIEW/" "$B/$v.sql" | (set -a; . ~/.config/tokenlayer/clickhouse.env; set +a; "$CH" client --port 19000 --user "$CLICKHOUSE_USER" --multiquery); done   # 008a/012 stay (new tables; dropping data is Etan\'s call)',
    },
    // ── Ship code on both Macs after the heartbeat table, before the ratchet snapshot (H1's order) ──
    launchJob(o, 'm1', 'ship', {
      title: 'M1 ship on the pinned release (writer login, R8 resume, R9 retry, H1 heartbeat)', from: 'R10 §4 B, R6, R8, R9, H1 deploy steps', after: ['m1-schema'],
      health: { mac: 'm1', script: 'within 120 beat_ok m1', checks: 'an ok ship_heartbeat from m1 within 120 s' },
    }),
    launchJob(o, 'm4', 'ship', {
      title: 'M4 ship on the pinned release (waits for #192/#195; writer login)', from: 'R10 §4 (M4 after #192/#195), R6 §3, R8, R9, H1', after: ['m4-pin', 'm4-writer-env', 'm1-schema'],
      health: { mac: 'm1', script: 'within 120 beat_ok m4', checks: 'an ok ship_heartbeat from m4 within 120 s (read on the M1)' },
    }),
    // ── The other M1 jobs on the checkout ──
    launchJob(o, 'm1', 'drain', { title: 'drain on the pinned release (writer login)', from: 'R10 §4 B, R6', after: ['m1-ship'] }),
    launchJob(o, 'm1', 'fable', {
      title: 'fable daemon restarted on F3/F4 code; switch stays OFF', from: 'F3, F4, R10 §4 B, Sol §5', after: ['m1-pin'],
      health: { mac: 'm1', script: 'grep -q \'"applied":"OFF"\' <<<"$("$CUR/bin/tokenlayer" fable status --json)"', checks: 'fable status --json reads applied OFF (never turned ON here)' },
    }),
    launchJob(o, 'm1', 'dashboard', {
      title: 'dashboard restarted on D1 code; burn reads proxy_usage', from: 'D1, R10 §4 B, Sol §5', after: ['m1-schema'],
      health: {
        mac: 'm1',
        // The allowed login is a site value in the plist; it is sent as the header, never printed.
        script: 'p=$(plutil -extract EnvironmentVariables.TOKENLAYER_DASHBOARD_PORT raw "$LA/com.tokenlayer.dashboard.plist" 2>/dev/null || echo 8448); ' +
          'login=$(plutil -extract EnvironmentVariables.TOKENLAYER_DASHBOARD_LOGINS raw "$LA/com.tokenlayer.dashboard.plist" | cut -d, -f1 | tr -d " "); ' +
          'n=$(curl -fsS -m 15 -H "Tailscale-User-Login: $login" "http://127.0.0.1:$p/api/burn" | bun -e "const r = JSON.parse(await Bun.stdin.text()); console.log(Array.isArray(r) ? r.length : (r.rows ?? []).length)"); echo "burn rows $n"; (( n > 0 ))',
        checks: '/api/burn answers 200 with rows',
      },
    }),
    launchJob(o, 'm1', 'hubupdate', { title: 'hubupdate on the pinned release (no run at load)', from: 'R10 §4 B', after: ['m1-pin'] }, true),
    ...(o.clickhouseWindow ? [launchJob(o, 'm1', 'clickhouse', {
      title: 'ClickHouse server on the pinned release (restarts it: approved window only)', from: 'R10 §4 B (window only)', after: ['m1-dashboard', 'm1-drain', 'm4-ship'],
      health: { mac: 'm1', script: 'within 60 ping_ok && within 120 beat_ok m1', checks: '/ping ok, then heartbeats land again' },
    })] : []),
    // ── Bundles ──
    bundle(o, 'm1', 'jev', 'src/jev/main.ts', { title: 'jev drain bundle (M1)', from: 'J2, Sol §5', after: ['m1-schema'] }),
    bundle(o, 'm4', 'jev', 'src/jev/main.ts', { title: 'jev drain bundle (M4)', from: 'J2, Sol §5', after: ['m4-pin', 'm1-schema'] }),
    {
      ...bundle(o, 'm4', 'usage', 'src/usage/main.ts', { title: 'usage bundle (U2–U4 vendors and counted use)', from: 'U2, U3, U4, Sol §5', after: ['m4-pin'] }),
      verify: '{ [[ $APPLIED == 0 ]] || within 90 fresh_runs com.tokenlayer.usage "$BEFORE"; } && bun -e "import { readFileSync } from \'node:fs\'; const u = JSON.parse(readFileSync(process.env.HOME + \'/.config/tokenlayer/usage.json\', \'utf8\')); const age = (Date.now() - Date.parse(u.generated_at)) / 1000; console.log(\'usage.json age\', age); process.exit(age < 120 && !u.stale && u.vendors ? 0 : 1)"',
      checks: 'a run after the install exits 0; usage.json under 120 s old, not stale, with vendors',
    },
    {
      id: 'm4-usage-plist', mac: 'm4', title: 'usage plist back to its template: /opt/homebrew/bin/bun, not the vite-plus shim', from: 'R9 (after merge), R11 §4.3', after: ['m4-usage-bundle'],
      done: '[[ $(plutil -extract ProgramArguments.0 raw "$LA/com.tokenlayer.usage.plist") == /opt/homebrew/bin/bun ]]',
      capture: 'echo $(lf com.tokenlayer.usage runs)',
      apply: ['mkdir -m 700 -p "$B"', 'cp -p "$LA/com.tokenlayer.usage.plist" "$B/"', '"$APP/scripts/deploy/setup.sh" usage'],
      verify: '[[ $(plutil -extract ProgramArguments.0 raw "$LA/com.tokenlayer.usage.plist") == /opt/homebrew/bin/bun ]] && within 90 ran_ok com.tokenlayer.usage && ! grep -q "^vp:" <<<"$(tail -n 5 "$HOME/Library/Logs/tokenlayer/usage.log")"',
      checks: 'ProgramArguments[0] is Homebrew bun; a run after the reload exits 0; no new vite-plus lines in usage.log',
      rollback: 'cp -p "$B/com.tokenlayer.usage.plist" "$LA/" && launchctl bootout "$D/com.tokenlayer.usage"; launchctl bootstrap "$D" "$LA/com.tokenlayer.usage.plist"',
    },
    // ── The ratchet-live snapshot last: both ships beat first, or the heartbeat rows read MISSING and post a false FAIL ──
    {
      id: 'm1-ratchet-live', mac: 'm1', title: 'ratchet-live snapshot of the commit, plist re-rendered (its run at load posts real state)', from: 'R1 (docs/ratchet.md), R2/R3 snapshots, H1/H2 order, Sol §5', after: ['m1-ship', 'm4-ship', 'm1-schema', 'm1-jev-bundle'],
      done: '[[ -d $APP ]] || exit 3; diff -rq -x node_modules -x .tokenlayer-commit "$APP" "$TL/ratchet-live" >/dev/null',
      capture: 'echo $(lf com.tokenlayer.ratchet-live runs)',
      apply: [
        'mkdir -m 700 -p "$B"',
        'rm -rf "$TL/ratchet-live.new" && mkdir -p "$TL/ratchet-live.new"',
        'git -C "$REPO" archive "$S" | tar -x -C "$TL/ratchet-live.new"',
        'mv "$TL/ratchet-live" "$B/ratchet-live" && mv "$TL/ratchet-live.new" "$TL/ratchet-live"',
        '"$APP/scripts/deploy/setup.sh" ratchet-live',
      ],
      verify: [
        'diff -rq -x node_modules -x .tokenlayer-commit "$APP" "$TL/ratchet-live" >/dev/null',
        'within 300 ran_ok com.tokenlayer.ratchet-live',
        'for r in ship_heartbeat_age_s_m1 ship_heartbeat_age_s_m4; do v=$(cd "$TL/ratchet-live" && bun ratchet/live.ts $r); echo "$r $v"; [[ $v == skip ]] || awk -v v="$v" "BEGIN { exit !(v <= 900) }"; done',
      ].join(' && '),
      checks: 'snapshot = the pinned tree; its run at load exits 0; both heartbeat rows read ≤ 900 s, not MISSING',
      rollback: 'rm -rf ~/.config/tokenlayer/ratchet-live && mv "$B/ratchet-live" ~/.config/tokenlayer/ratchet-live && launchctl kickstart -k "$D/com.tokenlayer.ratchet-live"',
    },
    // ── Drift last, per Mac ──
    {
      id: 'm1-drift-ignore', mac: 'm1', title: 'spendtable (orc script, not in this repo) listed in drift-ignore', from: 'R11 §4.2', after: ['m1-pin'],
      done: 'grep -qx com.tokenlayer.spendtable "$TL/drift-ignore"',
      apply: ['echo com.tokenlayer.spendtable >> "$TL/drift-ignore"'],
      verify: 'grep -qx com.tokenlayer.spendtable "$TL/drift-ignore"', checks: 'the label is in drift-ignore',
      rollback: 'sed -i "" "/^com.tokenlayer.spendtable$/d" ~/.config/tokenlayer/drift-ignore',
    },
    ...(['m1', 'm4'] as const).map((mac): Step => ({
      id: `${mac}-drift`, mac, title: 'setup.sh drift reads 0', from: 'R10 §4, R11 §3–4',
      after: mac === 'm1'
        ? ['m1-ship', 'm1-drain', 'm1-fable', 'm1-dashboard', 'm1-hubupdate', 'm1-jev-bundle', 'm1-ratchet-live', 'm1-drift-ignore', ...(o.clickhouseWindow ? ['m1-clickhouse'] : [])]
        : ['m4-ship', 'm4-jev-bundle', 'm4-usage-plist'],
      apply: [],
      verify: drift(mac, !o.clickhouseWindow && mac === 'm1'),
      checks: mac === 'm1' && !o.clickhouseWindow ? 'exit 0, or drift on clickhouse only (deferred to its window)' : 'exit 0',
      rollback: '',
    })),
  ];
  return steps;
}

/** Every step's dependencies run before it, on the plan's own order. Returns the problems found. */
export function orderProblems(steps: Step[]) {
  const seen = new Set<string>();
  const problems: string[] = [];
  const ids = new Set(steps.map(s => s.id));
  for (const s of steps) {
    for (const dep of s.after) {
      if (!ids.has(dep)) problems.push(`${s.id} depends on unknown ${dep}`);
      else if (!seen.has(dep)) problems.push(`${s.id} runs before ${dep}`);
    }
    if (seen.has(s.id)) problems.push(`${s.id} twice`);
    seen.add(s.id);
  }
  return problems;
}

type Log = (line: string) => void;
type RunOptions = Options & { apply: boolean; exec: Exec; log?: Log; self: string };
type Outcome = { ok: boolean; changed: Step[]; failed?: Step; before: Record<string, string> };

const indent = (text: string, pad = '      ') => text.split('\n').map(l => pad + l).join('\n');
/** A rollback line the operator can paste on that Mac: the run's own values in place of the script variables. */
const paste = (text: string, o: Options, before = '') =>
  text.replaceAll('$BEFORE', before || '<none>').replaceAll('$B/', `$HOME/.config/tokenlayer/backups/after-merge-${o.stamp}/`)
    .replaceAll('$LA/', '$HOME/Library/LaunchAgents/').replaceAll('$TL/', '$HOME/.config/tokenlayer/').replaceAll('"$CH"', `"$HOME/${o.clickhouse}"`)
    .replaceAll('$D/', 'gui/$(id -u)/').replaceAll('"$D"', 'gui/$(id -u)');

/** Run (or, by default, only describe) the plan. Stops at the first failure and prints the rollback for what changed. */
export async function run(o: RunOptions): Promise<Outcome> {
  assertOptions(o);
  const log = o.log ?? console.log;
  const steps = plan(o);
  const problems = orderProblems(steps);
  if (problems.length) throw Error(`plan out of order: ${problems.join('; ')}`);
  const script = (mac: Mac, body: string, before = '', applied = false) =>
    `${prelude(mac, o)}\nSELF=${mac === 'm1' ? quote(o.self) : '$REPO'}; BEFORE=${quote(before)}; APPLIED=${applied ? 1 : 0}\n${body}`;
  const changed: Step[] = [];
  const before: Record<string, string> = {};
  let failed: Step | undefined;
  let locked = false;

  log(`${o.apply ? 'APPLY' : 'DRY RUN (read-only: nothing below is changed)'} for ${o.sha}, ${steps.length} steps`);
  // The M1 heavy-job lock covers pins, bundle builds and restarts on the M1 (orc's rule); the M4 needs none.
  const lock = await o.exec('m1', 'cat ~/.m1-heavy.next 2>/dev/null; [[ -d ~/.m1-heavy.lock ]] && echo held || echo free; df -g / | awk \'NR==2{print "df " $4}\'', 'probe', 'lock');
  log(`M1 heavy lock: ${lock.out.replace(/\n/g, ', ')}`);
  if (o.apply) {
    const take = await o.exec('m1', `next=$(cat ~/.m1-heavy.next 2>/dev/null || true)
if [[ -n $next && $next != *${LANE}* ]]; then echo "reserved for: $next"; exit 3; fi
mkdir ~/.m1-heavy.lock 2>/dev/null || { echo "held by another lane"; exit 4; }
echo "${LANE} took $(date +%H:%M)" >> ~/.m1-heavy.log
[[ -z $next ]] || : > ~/.m1-heavy.next
free=$(df -g / | awk 'NR==2{print $4}')
(( free >= 44 )) || { echo "${LANE} released $(date +%H:%M)" >> ~/.m1-heavy.log; rmdir ~/.m1-heavy.lock; echo "df -g / reads $free, under 44"; exit 5; }`, 'apply', 'lock');
    if (take.code !== 0) { log(`STOP: cannot take the M1 heavy lock (${take.out}). Nothing changed.`); return { ok: false, changed, before }; }
    locked = true;
  }
  try {
    for (const [i, s] of steps.entries()) {
      log(`\n[${i + 1}/${steps.length}] ${s.mac} ${s.id}: ${s.title}\n      from: ${s.from}`);
      const marker = `[[ -f "$MARK/${s.id}" ]]`;
      const isDone = await o.exec(s.mac, script(s.mac, s.done ? `${marker} || { ${s.done}; }` : marker), 'probe', s.id);
      const already = isDone.code === 0;
      if (s.capture) {
        const c = await o.exec(s.mac, script(s.mac, s.capture), 'probe', s.id);
        before[s.id] = c.code === 0 ? c.out.trim() : '';
        log(`      now: ${before[s.id] || '(nothing)'}`);
      }
      if (!o.apply) {
        if (isDone.code === 255) log('      state: UNREACHABLE (ssh exit 255): an apply run would stop here');
        else if (isDone.code === 3) log('      state: known only once an earlier step has run: an apply run decides then');
        else log(`      state: ${already ? 'already in place: apply would be skipped' : s.apply.length ? 'would apply' : 'check only'}`);
        if (s.apply.length) log(`      commands:\n${indent(s.apply.join('\n'), '        $ ')}`);
        log(`      check: ${s.checks}${s.health ? `; ${s.health.mac}: ${s.health.checks}` : ''}`);
        if (s.rollback) log(`      rollback: ${paste(s.rollback, o, before[s.id])}`);
        if (!s.apply.length) {
          const v = await o.exec(s.mac, script(s.mac, s.verify), 'probe', s.id);
          log(`      check now: ${v.code === 0 ? 'PASS' : `FAIL (exit ${v.code}): an apply run would stop here`}${v.out ? `\n${indent(v.out)}` : ''}`);
        }
        continue;
      }
      const applied = !already && s.apply.length > 0;
      if (applied) {
        changed.push(s);
        const a = await o.exec(s.mac, script(s.mac, ['mkdir -m 700 -p "$MARK"', ...s.apply].join('\n'), before[s.id]), 'apply', s.id);
        if (a.out) log(indent(a.out));
        if (a.code !== 0) { failed = s; log(`      FAILED (exit ${a.code})`); break; }
      } else if (already) log('      already in place: skipped');
      const v = await o.exec(s.mac, script(s.mac, s.verify, before[s.id], applied), 'verify', s.id);
      if (v.out) log(indent(v.out));
      if (v.code !== 0) { failed = s; log(`      CHECK FAILED (exit ${v.code}): ${s.checks}`); break; }
      if (s.health) {
        const h = await o.exec(s.health.mac, script(s.health.mac, s.health.script, before[s.id], applied), 'verify', s.id);
        if (h.out) log(indent(h.out));
        if (h.code !== 0) { failed = s; log(`      CHECK FAILED on ${s.health.mac} (exit ${h.code}): ${s.health.checks}`); break; }
      }
      if (s.apply.length) await o.exec(s.mac, script(s.mac, `mkdir -m 700 -p "$MARK" && touch "$MARK/${s.id}"`), 'apply', s.id);
      log(`      ok: ${s.checks}`);
    }
  } finally {
    if (locked) await o.exec('m1', `echo "${LANE} released $(date +%H:%M)" >> ~/.m1-heavy.log; rmdir ~/.m1-heavy.lock`, 'apply', 'lock');
  }
  if (failed) {
    log(`\nSTOPPED at ${failed.mac} ${failed.id}. Nothing after it ran. Rollback for what this run changed, newest first:`);
    if (!changed.length) log('  (nothing was changed)');
    for (const s of [...changed].reverse()) if (s.rollback) log(`  ${s.mac} ${s.id}: ${paste(s.rollback, o, before[s.id])}`);
    log('Steps already in place before this run were not changed and need no rollback. Fix the cause and rerun: finished steps are skipped.');
  } else if (o.apply) log('\nDONE: every step is in place and checked.');
  log(`\nNot part of this run: R12's repartition (own window, receipts/R12.md §5)${o.clickhouseWindow ? '' : '; the ClickHouse job repoint (approved window, --clickhouse-window)'}; dropping credentials_snap and R7's scratch tables (Etan); the bundle-usage-bytes tighten-back PR.`);
  return { ok: !failed, changed, failed, before };
}

/** POSIX single quotes for one ssh argument. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const realExec: Exec = async (mac, script) => {
  const argv = mac === 'm1' ? ['bash', '-c', script] : ['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'macbook-pro', `bash -c ${quote(script)}`];
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: `${out}${err}`.trim() };
};

/** The ClickHouse binary path under $HOME, from setup.sh's CH= line (the one place its version lives). */
export function clickhouseFromSetup(repo: string) {
  const m = /^\s*CH="\$HOME\/([^"]+)"$/m.exec(readFileSync(join(repo, 'scripts/deploy/setup.sh'), 'utf8'));
  if (!m) throw Error('scripts/deploy/setup.sh has no CH= line');
  return m[1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const known = ['--commit', '--apply', '--clickhouse-window'];
  const input = args[args.indexOf('--commit') + 1];
  const usage = 'usage: bun scripts/after-merge-install.ts --commit <full or short hex sha on origin/main> [--apply] [--clickhouse-window]';
  if (!args.includes('--commit') || !input || args.some((a, i) => a.startsWith('--') && !known.includes(a)) || args.filter(a => !a.startsWith('--')).length !== 1) {
    console.error(usage);
    process.exit(2);
  }
  const self = resolve(import.meta.dir, '..');
  // Validated and resolved here, before any script is built or run (the dry run included): it goes into bash on both Macs.
  let sha: string;
  try { sha = resolveCommit(self, input); } catch (err) { console.error(`${(err as Error).message}\n${usage}`); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const outcome = await run({ sha, stamp, apply: args.includes('--apply'), clickhouseWindow: args.includes('--clickhouse-window'), clickhouse: clickhouseFromSetup(self), exec: realExec, self });
  process.exit(outcome.ok ? 0 : 1);
}
