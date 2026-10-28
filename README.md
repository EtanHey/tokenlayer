# tokenlayer

Sidecars around a self-hosted [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub, following
[Theo's hub guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af):

- **steer** — soonest-reset-first routing without forking the proxy: reads each credential's captured
  rate-limit reset times from the management API and moves the account that resets soonest to the top priority tier.
- **drain** — persists the proxy's per-request usage records (tokens, cache reads/writes, account, latency) to ClickHouse.
- **ship** — ships Claude Code, Codex and T3 Code session JSONL from every machine into the same ClickHouse.

No secrets live in this repo. See `config/cliproxyapi.conf.template`.
