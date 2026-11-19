# Jev call tracking (`systemone_calls`)

Jev is Typesafe `/v1/systemone`. Callers reach it directly at `api.typesafe.ai`, not through the hub, so
`proxy_usage` never sees it. The only record is the `usage.jsonl` ledger that golems
`packages/shared/src/lib/jev.py` writes in each Jev state folder:

- a **reservation** row before the request (64k input tokens, the maximum cost), and
- a negative **reconciliation** row after a valid response. The two rows sum to the real cost.

A failed or crashed call leaves its reservation unreconciled. The ledger holds no keys, state or answers.

## What runs

`src/jev/main.ts` makes one pass on each Mac:

1. It finds every `usage.jsonl` up to 4 directories below each root in `TOKENLAYER_JEV_ROOTS`. The default
   roots are `~/.local/state/jev` (jev.py's default), `~/.t3/scratch` and `~/Gits/golems/docs.local`. Set
   `TOKENLAYER_JEV_ROOTS` (the full list) in `~/.config/tokenlayer/jev.env` (mode 600, never committed) to add private
   research folders. Files without Jev-shaped lines are ignored.
2. It folds the ledgers into one row per `reservation_id` and inserts only rows whose content changed
   since ClickHouse last confirmed them (`~/.config/tokenlayer/jev-state.json`).

The table is a `ReplacingMergeTree(ingested_at)` ordered by `reservation_id`, so count with `FINAL`.
A lost state file re-sends the same batch with the same deduplication token, so no rows are added.
`accounting_quality` is `measured`, `reserved_max` (jev.py booked the 64k maximum because the API
returned no usage), `unreconciled` or `orphan_reconciliation`.

`v_provider_usage_compare` has a `typesafe` provider: reconciled input tokens, plus `cost_usd` (the ledger
net, which keeps the held maximum for unreconciled calls).

## Install (per Mac)

```sh
bun build src/jev/main.ts --target bun --outfile ~/.config/tokenlayer/bin/jev.js
scripts/deploy/setup.sh jev   # renders the template, lints it and reloads the job
```

It reads `TOKENLAYER_MACHINE` and the ClickHouse client settings from `~/.config/tokenlayer/{ship,clickhouse}.env`,
and optional roots from `jev.env`.
Run `bun ~/.config/tokenlayer/bin/jev.js --dry-run` to print the counts without inserting.

Proof that the table matches the ledgers: rows `FINAL` = distinct reservation ids, and
`countIf(reserved_at IS NOT NULL) + countIf(reconciled_at IS NOT NULL)` = ledger lines minus duplicate lines in copied ledgers.

## Not in the ledger yet

`endpoint`, `mode`, `source`, `status_code`, `fail_code`, `latency_ms`, `question_ids`, `answer`, `confidence`,
`session_id`, `parent_session_id`, `thread_id` and `state_sha256` stay NULL (or empty) until jev.py writes them
(golems lane 3). Never store the raw state, only its SHA-256.

## Alert: unreconciled calls

jev.py writes no reconciliation when a call fails (transport error, invalid response) or crashes, so its
reservation stays alone. Ratchet row `jev_unreconciled_24h` (M1, `bun ratchet/live.ts jev_unreconciled_24h`)
counts reservations still unreconciled 15 minutes after they were made, over the last 24 hours. Its ceiling is 0.
The window keeps old research failures (three from September) from holding it red forever.
Query: `src/jev/unreconciled.ts`.
