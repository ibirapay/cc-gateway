<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
    <img alt="CC Gateway" src=".github/logo-light.svg" width="440">
  </picture>

  <p>Centralized OAuth, per-user token metering, and conversation logging for Claude Code</p>
</div>

<div align="center">

[![License: MIT][license-shield]][license-url]
[![Version][version-shield]][version-url]
[![Tests][tests-shield]][tests-url]

</div>

<div align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#add-clients">Add Clients</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#deployment">Deployment</a> &middot;
  <a href="#changelog">Changelog</a>
</div>

---

> **Alpha** — This project is under active development. Test with a non-primary account first.

> **Disclaimer** — See [full disclaimer](#disclaimer) below.

## Why

If you share a Claude Code subscription across a team, you have no visibility into who's spending tokens, no per-user usage breakdown, and no conversation history for compliance. If your OAuth token dies, everyone stops. If you hit the rate limit, there's no way to tell who caused it.

CC Gateway is a reverse proxy that sits between Claude Code clients and the Anthropic API. It gives you **per-user token metering**, **conversation logging**, **centralized OAuth management**, and **multi-instance isolation** — turning one shared account into a managed, auditable service.

## Features

- **Per-user token metering** — input, output, cache read/creation tokens tracked per client. Discord reports on schedule or on-demand (`kill -USR1`)
- **Conversation history** — full request/response bodies logged as gzipped JSONL per day, per user, with configurable retention. Built for regulatory compliance
- **Centralized OAuth** — the gateway manages token refresh internally; client machines never contact `platform.claude.com`. Rotating refresh tokens are persisted back to config automatically
- **Remote OAuth swap** — `/_oauth` POST endpoint lets authenticated clients replace the refresh token without SSH access to the server. Test-refreshes before committing — failed swaps don't touch the live token
- **Multi-instance** — `spawn-instance.sh` creates isolated gateway instances (own port, OAuth, config, history). Use for budget isolation: 1 account = 1 user, never run out of tokens on both
- **Zero-login client setup** — clients receive a single launcher script. No browser OAuth, no `~/.zshrc` changes, no config files
- **Usage alerting** — Discord notifications when the shared account's 7-day utilization crosses each 5% band
- **Circuit breaker** — opens after consecutive upstream failures, auto-recovers. Protects clients from cascading errors
- **Rate limiting** — shared global sliding-window limiter to prevent runaway clients from burning the account
- **Egress proxy tiers** — automatic failover across proxy tiers (residential → Tailscale → datacenter) with hot-reload via SIGHUP
- **Instant startup** — uses existing access token on launch. No network call until the token actually expires

## Quick Start

One command. Requires Node.js 22+ and an existing Claude Code login on this machine.

```bash
git clone https://github.com/pagcoinbr/cc-gateway.git
cd cc-gateway
npm install
bash scripts/quick-setup.sh
```

This will:
1. Extract your OAuth credentials from macOS Keychain (access token + refresh token)
2. Generate a client token
3. Write `config.yaml`
4. Generate a client launcher at `./clients/cc-<hostname>`
5. Start the gateway on `http://localhost:8443`

### Use it

In another terminal:

```bash
./clients/cc-<hostname>
```

That's it. Claude Code launches, traffic routes through the gateway. No env vars to set, no files to edit.

### Behind a proxy?

```bash
HTTPS_PROXY=http://127.0.0.1:7890 bash scripts/quick-setup.sh
```

The gateway will route all outbound traffic (API calls + token refresh) through your proxy.

## Add Clients

Each person gets their own launcher script with a unique token. The admin generates it:

```bash
bash scripts/add-client.sh alice
bash scripts/add-client.sh bob
```

This creates `./clients/cc-alice` and `./clients/cc-bob`. Send each file to the respective person.

### Client setup (what you tell them)

```bash
chmod +x cc-alice
./cc-alice install        # installs as 'ccg' command
ccg                       # start Claude Code through gateway
```

That's it. All Claude arguments work: `ccg --print "hello"`, `ccg --resume`, etc.

### All commands

```
ccg                       Start Claude Code through gateway
ccg install               Install as 'ccg' system command
ccg uninstall             Remove 'ccg' and clean up
ccg hijack                Make 'claude' also go through gateway
ccg release               Restore 'claude' to native
ccg swap-oauth            Replace gateway OAuth (extracts from local login)
ccg swap-oauth TOKEN      Replace gateway OAuth with specific token
ccg native [args]         Run native claude once (bypass gateway)
ccg status                Show gateway connection status
ccg help                  Show help
```

### Multi-instance (budget isolation)

Spawn a separate gateway instance with its own OAuth account:

```bash
# Extract refresh token from a second account:
cat ~/.claude/.credentials.json | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])"

# Spawn the instance:
bash scripts/spawn-instance.sh backup <refresh-token> 8444 username

# Tear down:
bash scripts/spawn-instance.sh --destroy backup
```

Each instance gets its own systemd unit, config, conversation history, and client launcher. All instances share the same compiled code.

## Deployment

### Local (development)

```bash
npm run dev    # tsx watch, auto-reload
```

### Production (systemd)

```bash
npm run build
# Copy cc-gateway.service to /etc/systemd/system/
systemctl enable cc-gateway --now
```

### Docker

```bash
bash scripts/admin-setup.sh
```

### Multi-machine deployment

```
Mac-A ──┐
Mac-B ──┼──→ gateway-server:8443 ──→ api.anthropic.com
Mac-C ──┘
```

For remote deployment, generate TLS certificates or use Tailscale (zero config networking — no TLS needed, no public IP needed).

```bash
bash scripts/add-client.sh alice "" <gateway-ip>:8443 https
```

## Architecture

```
Client machines                        CC Gateway                    Anthropic
┌────────────┐                    ┌──────────────────┐
│ ./cc-alice  │── ANTHROPIC_ ────│  Auth: x-api-key  │
│  (launcher) │   BASE_URL       │  OAuth: auto-     │
│  + env vars │                  │    refresh        │──── single ────▶ api.anthropic.com
│             │                  │  Meter: per-user  │     OAuth
│             │                  │    tokens         │     account
└────────────┘                    │  Log: full        │
                                  │    conversations  │
                                  │  Stream: SSE      │
                                  │    passthrough    │
                                  └──────────────────┘
                                         │
                                   platform.claude.com
                                   (token refresh only)
```

**Request flow:**

| Step | What happens |
|------|-------------|
| 1. Auth | Client's `x-api-key` matched to a named user |
| 2. Rate limit | Sliding-window check (shared pool) |
| 3. Circuit breaker | Upstream health gate |
| 4. OAuth inject | Client token swapped for shared OAuth token |
| 5. Forward | Request body forwarded unchanged to `api.anthropic.com` |
| 6. Stream back | SSE response piped to client |
| 7. Tap | Usage metering + conversation logging (non-destructive) |

## OAuth Lifecycle

The gateway manages the full OAuth token lifecycle:

1. **Startup** — uses the existing access token from config. Zero network calls.
2. **Auto-refresh** — 5 minutes before expiry, the gateway silently refreshes via `platform.claude.com`.
3. **Continuous** — refresh tokens rotate automatically. The gateway persists new tokens back to `config.yaml`.
4. **Failure recovery** — exponential backoff retry (30s → 60s → 120s → 300s max).
5. **Remote swap** — if the refresh token dies, any authenticated client can replace it via `ccg swap-oauth` without server access.

## Caveats

- **MCP servers** — `mcp-proxy.anthropic.com` is hardcoded and does not follow `ANTHROPIC_BASE_URL`. Those requests bypass the gateway.
- **CC updates** — New Claude Code versions may change API behavior. Monitor gateway logs after upgrades.
- **Token lifecycle** — The gateway auto-refreshes the OAuth access token. If the underlying refresh token expires (rare), use `ccg swap-oauth` or re-run `extract-token.sh`.

## Changelog

### v0.3.0 (2026-07-27)

**Conversation history logging**
- Full request/response body capture as gzipped JSONL per day, attributed to each client
- Configurable retention (default 365 days), auto-rotation, auto-pruning
- Built for regulatory compliance — every conversation through the gateway is recorded

**Remote OAuth swap**
- New `/_oauth` POST endpoint — authenticated clients can replace the refresh token remotely
- Test-refreshes with Anthropic before committing; failed attempts don't touch the live token
- Client-side: `ccg swap-oauth` extracts from local `~/.claude/.credentials.json`

**Multi-instance support**
- `scripts/spawn-instance.sh` creates isolated gateway instances with own port, OAuth, config, and history
- Budget isolation: 1 account per user, never exhaust tokens on all accounts simultaneously
- Tear down with `--destroy`

### v0.2.0 (2026-04-02)

**OAuth-swap passthrough**
- Removed identity/environment rewriter — gateway is now a pure OAuth-swap passthrough
- Request and response bodies forwarded unchanged

**Per-user token metering**
- Per-client tracking of input, output, cache read/creation tokens, latency, and byte sizes
- Scheduled Discord reports + on-demand via `SIGUSR1`
- Account-wide utilization alerts at each 5% band

**Zero-login client setup**
- `add-client.sh` generates self-contained launcher scripts
- Clients run one file — no browser login, no config files

**Reliability**
- Circuit breaker (5 consecutive 5xx → open, 60s cooldown)
- Rate limiter (shared global sliding-window)
- Egress proxy tiers with automatic failover and hot-reload via SIGHUP

### v0.1.0 (2026-04-01)

Initial release. Identity rewriting, environment normalization, centralized OAuth, SSE passthrough.

## References

- Fork of [motiful/cc-gateway](https://github.com/motiful/cc-gateway) — original privacy-focused reverse proxy for Claude Code

## Disclaimer

This project is for educational and research purposes only.

- Do NOT use this to share accounts or violate Anthropic's Terms of Service
- Do NOT use this for commercial purposes
- The author is not responsible for any consequences of using this software
- Use at your own risk

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>Crafted with <a href="https://github.com/anthropics/claude-code">Claude Code</a></sub>
</div>

<!-- Badge references -->
[license-shield]: https://img.shields.io/github/license/pagcoinbr/cc-gateway
[license-url]: https://github.com/pagcoinbr/cc-gateway/blob/main/LICENSE
[version-shield]: https://img.shields.io/badge/version-0.3.0--alpha-blue
[version-url]: https://github.com/pagcoinbr/cc-gateway/releases
[tests-shield]: https://img.shields.io/badge/tests-16%20passed-brightgreen
[tests-url]: https://github.com/pagcoinbr/cc-gateway/blob/main/tests
