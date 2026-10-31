5. **models** - Role→model: `standards/model-roles.json`; routing: `/agent-routing` (SSOT).
   Every fresh boot carries the default pin (the current top role from model-roles.json);
   the pin is never removed. A prior session's model never persists into the next.
   A non-default model is used only by explicit per-invocation selection.
   Every non-Cursor Agent/Workflow/Task spawn pins its model explicitly.
   Claude concurrency: at most 5 parallel Claude lead tracks fleet-wide, normally 3-4; a slot is an actually
   running turn (idle, snoozed or waiting threads don't count). Claude workers (role ids in model-roles.json): <=2 `claude.judgment` (inside the shared
   7-slot `claude.judgment` ceiling with leads), <=2 `claude.subagent.cheap`, <=4 `claude.subagent.mechanical`;
   all Claude workers together <=20% of the rolling 5h (an accounting interval, not a provider limit window).
   Brake on tokenlayer `usage.json`, per serving account and per limit window that account actually has
   (a window absent from its rate-limit headers, e.g. no 5h window, has no brake):
   a window is SLOW when used% x window-minutes / elapsed-minutes > 100 (after the first 10% of the window):
   no new Claude workers and <=2 active leads;
   a window is STOP at >=95% used: no Claude workers and <=1 essential lead turn.
   An account takes its tightest window; the fleet takes its best serving account (the hub fails over).
   Stale, unknown or rejected telemetry counts as NO headroom for that account.
   (Etan, 2026-10-31, via orc: "That means we can never finish the 5 hour limit window."; Anthropic removed the 5h window on his long-standing "Ultra" account.)
   (provisional until the first fresh-session window shows a non-zero 1h-cache write share; then re-derive)
   (Etan, 2026-10-28, via fleet control: "3 is too low", "~20 too wide", "even 10 might not kill it as long as they're leads".)
   (Etan, 2026-10-28, via fleet control: "maybe 3-5 leads parallel at a time might have to be the max? since they also use claudes for review and implementations?")
   Usage is managed by pinning and dispatch-counting.
