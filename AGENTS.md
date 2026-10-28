# AGENTS.md — tokenlayer

Sidecars for the CLIProxyAPI hub on the M1 Pro home server (`locals-macbook-pro`, user `happycampr`).
Plan: `~/Gits/orchestrator/docs.local/plans/2026-10-28-cliproxy-telemetry/PLAN.md`.

- `src/steer/` — soonest-reset-first: poll `GET /v8/management/credentials`, set per-credential `priority`.
- `src/drain/` — drain `/observability/usage/queue` into ClickHouse `proxy_usage`.
- `src/ship/` — tail Claude/Codex/T3 session JSONL on each Mac into ClickHouse `session_events`.

Rules:
- Never print, log, commit or paste access keys, the management key, OAuth auth files, or ClickHouse passwords.
  Secrets live in 1Password and in `~/.config/tokenlayer/*.env` (mode 600) on the machine — never in this repo.
- Claude subscriptions are used only by Claude Code. Never enable CLIProxyAPI cloak/fingerprint modes.
- The hub is tailnet-only (`tailscale serve`), never `tailscale funnel`.
- Failing test first. Bun + TypeScript, `bun test`. Small PRs (XS/S), `/pr-loop`.
