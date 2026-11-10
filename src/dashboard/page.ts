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
<span id="mode">Loading current routing…</span>
</header>
<p role="status" id="notice">
</p>
<div id="accounts" class="grid">
</div>
<section id="recommendation" aria-label="Reset recommendation">
</section>
<section>
<h2>The switch</h2>
<p>Changes apply to hub routing. Current exclusions below are read back from OAuth metadata.</p>
<form id="switch">
<label>Mode <select name="mode">
<option value="off">Off</option>
<option value="manual">Manual</option>
<option disabled>Auto · next week</option>
</select>
</label>
<label>Fable account <select name="account" class="account">
</select>
</label>
<label>
<input type="checkbox" name="strict" checked> Reserve Fable account for Fable
(other models use the other account)</label>
<label>
<input type="checkbox" name="spillover"> Allow spillover at cap (the second account may serve Fable)</label>
<button>Apply routing</button>
</form>
</section>
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
<label>Operation id <input name="opId" readonly hidden>
<button type="button" id="retry" hidden>Retry same op</button>
</label>
<button>Clear proxy cooldowns and subtract one reset</button>
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
