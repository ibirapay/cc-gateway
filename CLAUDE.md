# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm run build          # tsc → dist/
npm run dev            # tsx watch (live reload)
npm run start          # node dist/index.js
npm test               # just runs build (no test runner)
```

Utility scripts:
```bash
npm run generate-token     # random 32-byte hex client token
npm run generate-identity  # random 32-byte hex device ID
```

Production service: `systemctl restart cc-gateway` (systemd unit, logs to journald).

## Architecture

CC Gateway is a **stateless OAuth-swap reverse proxy** between Claude Code clients and `api.anthropic.com`. Each client authenticates with a unique token; the gateway swaps it for a shared OAuth token before forwarding upstream. Request and response bodies pass through **unchanged** — there is no rewriting.

> **Note:** The README describes identity/env rewriting features that were **removed**. The `identity`, `env`, and `prompt_env` config fields are deprecated stubs. The gateway is a pure passthrough now.

### Request lifecycle (proxy.ts)

```
Client → auth (x-api-key lookup) → rate limit → circuit breaker
→ OAuth token injection → forward to api.anthropic.com → pipe SSE response back
                                                       ↳ tap: usage metering
                                                       ↳ tap: conversation log
```

The request body is fully buffered (`Buffer.concat`) before forwarding. Response is streamed via `pipe()` with non-destructive taps attached in the same tick.

### Key modules

| Module | Role |
|---|---|
| `proxy.ts` | HTTP handler, upstream forwarding, header sanitization |
| `auth.ts` | In-memory token→client map, supports `x-api-key` and `Bearer` |
| `oauth.ts` | Token refresh lifecycle with exponential backoff, persists rotated tokens back to `config.yaml` |
| `usage-meter.ts` | Per-client token counting by parsing SSE `message_start`/`message_delta` events; state persisted to JSON every 30s |
| `usage-notify.ts` | Watches Anthropic `anthropic-ratelimit-unified-*` headers; Discord alerts on 5% utilization bands |
| `conversation-log.ts` | Full request+response body capture as gzipped JSONL per day (regulatory retention) |
| `rate-limiter.ts` | Shared global sliding-window RPS limiter |
| `circuit-breaker.ts` | Opens after 5 consecutive 5xx; 60s cooldown; 4xx does NOT trip |
| `proxy-agent.ts` | Egress proxy selection, hot-reloadable via SIGHUP |

### Persistence (all file-based, no database)

- `config.yaml` — auth tokens, OAuth credentials, all settings (gitignored; `config.example.yaml` is tracked)
- `usage-meter-state.json` — per-client counters, persisted every 30s, reset on 7-day window rollover
- `usage-notify-state.json` — last notified utilization band
- `conversation-history/*.jsonl.gz` — daily gzipped JSONL with full bodies, 365-day retention
- `active-proxy.txt` — current egress proxy URL (written by `cc-health.sh`, read on SIGHUP)

### Signal handling

- **SIGHUP** — hot-reload egress proxy from `active-proxy.txt` (used by `cc-health.sh` for tier failover without dropping connections)
- **SIGUSR1** — post per-user usage report to Discord immediately

### Egress proxy tiers (managed by `scripts/cc-health.sh`, runs every 2min via systemd timer)

1. **PRIMARY** — residential egress via reverse SSH tunnel (`127.0.0.1:8889`)
2. **FALLBACK** — residential egress via Tailscale
3. **LAST_RESORT** — VPS-local datacenter proxy (`127.0.0.1:8888`)

Tier switches are done by writing `active-proxy.txt` and sending SIGHUP — no restart needed.

## Code conventions

- TypeScript strict mode, ES2022 target, ESM (`"type": "module"`, `.js` extensions in imports)
- Two runtime dependencies only: `https-proxy-agent`, `yaml`
- Metering/logging taps must **never** disrupt the proxied response — wrap in try/catch, fail silently
- `logger.ts:sanitize()` masks all token patterns (`sk-ant-*`, `oat01-*`, Bearer, x-api-key) — any new logging that might contain credentials should go through `log()` or `sanitize()`
- Config changes (like OAuth token rotation) are persisted back to `config.yaml` via line-anchored regex replacement, not full YAML rewrite
