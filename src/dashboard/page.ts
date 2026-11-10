export function page(token: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${token}">
<title>Fable · Tokenlayer</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
<small>TOKENLAYER / HOME HUB</small>
<h1>Fable account status</h1>
<p>Fable routing, reset inventory and the usage the hub can see.</p>
<p id="mismatch" role="alert"></p>
<span id="mode">Loading current routing…</span>
</header>
<section>
<h2>Fable split</h2>
<p>Changes apply to hub routing. Catalogs and priorities below are read back from the management API.</p>
<p id="applied">Fable split: UNKNOWN</p>
<p id="applied-reason"></p>
<p id="arrangement"></p>
<form id="switch">
<input type="hidden" name="mode" value="off">
<button id="toggle" type="submit" aria-pressed="false">Turn Fable split ON</button>
<label>Fable account <select name="account" class="account">
</select>
</label>
<details><summary>Advanced</summary>
<label>
<input type="checkbox" name="strict"> Reserve Fable account for Fable
(other models use the other account)</label>
<label>
Cap policy <select name="spillover"><option value="auto">Automatic: wait while resets remain</option>
<option value="false">Always wait</option><option value="true">Always spill</option></select></label>
<label><input type="checkbox" name="allowNonFableOnFableAccount">
Allow non-Fable on the Fable account (override its reserve)</label>
</details>
</form>
</section>

<p role="status" id="notice">
</p>
<aside id="recommendation" aria-label="Reset hint">
</aside>
<section>
<h2>Reset guidance</h2>
<p>
<a href="https://claude.ai/settings/usage" target="_blank" rel="noopener">Open Claude Settings → Usage</a>
</p>
<p>A reset refunds Fable usage only.
Report a press after you do it in Claude.
Recovery clears proxy cooldowns; it does not reset Anthropic entitlement.</p>
<form id="pressed">
<label>Account <select name="account" class="account">
</select>
</label>
<input type="hidden" name="opId">
<button type="button" id="retry" hidden>Retry same op</button>
<p id="reset-facts">Select an account to see its reset facts.</p>
<button>I pressed it — recover proxy and subtract one reset</button>
</form>
<pre id="recovery">
</pre>
<h2>Reset counts</h2>
<form id="counts">
<label>Account <select name="account" class="account">
</select>
</label>
<label>Resets left <input type="number" name="left" min="0" max="3" required>
</label>
<label>
<input type="checkbox" name="confirmed" required> I checked this count in Claude</label>
<button>Save confirmed count</button>
</form>
<pre id="inventory">
</pre>
</section>
<div id="accounts" class="grid"></div>
<section>
<h2>Last 48 hours</h2>
<p id="freshness">
</p>
<div id="chart">
</div>
<p id="errors">
</p>
<small>Each account / model has separate request and token series. Hub telemetry only.</small>
</section>
<section>
<h2>Per-thread consumption</h2>
<label>Window <select id="session-window"><option value="3h">3 hours</option>
<option value="24h">24 hours</option></select></label>
<div id="sessions"></div>
</section>
<section>
<h2>What changed</h2>
<p>Before today, when one account used up its Fable allowance, the proxy wrongly paused that whole account,
 and with your other account already used up, every Claude request on both Macs would have failed.
 Now only Fable pauses on that account; Opus, Sonnet and Haiku keep working.</p>
<p>The old proxy key had been printed into an agent's log, so anyone who could read that log could have used
 your Claude accounts through the proxy; it has now been switched off. It had to wait only until every running
 app had moved to the new key, and the logs showed they all moved within seconds, so there was no need to
 wait for Thursday.</p>
</section>
<section>
<h2>Coverage</h2>
<ul id="coverage">
</ul>
</section>
<section>
<h2>Event log</h2>
<p>Last 50 durable events</p>
<div id="events">
</div>
</section>
<script src="/app.js" defer>
</script>
</body>
</html>`;
}
