import { readFileSync, existsSync } from 'fs'
import { parse } from 'yaml'
import { resolve } from 'path'

export type TokenEntry = {
  name: string
  token: string
}

export type Config = {
  server: {
    port: number
    tls: {
      cert: string
      key: string
    }
  }
  upstream: {
    url: string
  }
  auth: {
    tokens: TokenEntry[]
  }
  oauth: {
    access_token?: string
    refresh_token: string
    expires_at?: number
    // Optional: OAuth client ID (defaults to built-in Claude Code client)
    client_id?: string
    // Optional: OAuth scopes (defaults to Claude Code scopes)
    scopes?: string[]
  }
  // DEPRECATED: identity, env, and prompt_env fields below are no longer used since the rewriter was removed.
  // The gateway is now a pure OAuth-swap passthrough with no identity masking.
  // These fields are kept for backwards compatibility but can be omitted from new configs.
  identity?: {
    device_id?: string
    email?: string
  }
  env?: Record<string, string | boolean | number>
  // DEPRECATED: System prompt environment masking - no longer used since rewriter removed
  prompt_env?: {
    platform?: string        // "darwin" — must match env.platform
    shell?: string           // "zsh"
    os_version?: string      // "Darwin 24.4.0" — uname -sr output
    working_dir?: string     // canonical home path prefix (unused since rewriter removed)
  }
  process: {
    constrained_memory: number
    rss_range: [number, number]
    heap_total_range: [number, number]
    heap_used_range: [number, number]
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
    audit: boolean
  }
  // Rate limiting: global limit (requests per second) applied equally to all clients
  // All clients share the same limit since they pay equally for the shared account
  rate_limiting?: {
    rps?: number  // Requests per second (0 or omitted = unlimited)
  }
  // Optional: Discord webhook to ping when shared-account usage crosses a band,
  // plus the interval for the scheduled per-user usage report.
  notify?: {
    discord_webhook?: string
    usage_report_interval_hours?: number
  }
  // Conversation history logging for regulatory retention.
  // Stores full request/response bodies as gzipped JSONL per day.
  history?: {
    enabled?: boolean
    dir?: string              // default: ./conversation-history
    retention_days?: number   // default: 365
  }
}

function validateConfig(config: Config): void {
  // Server validation
  if (!config.server?.port) {
    throw new Error('config: server.port is required')
  }
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`config: server.port must be between 1 and 65535, got ${config.server.port}`)
  }

  // TLS validation
  if (config.server.tls?.cert || config.server.tls?.key) {
    if (!config.server.tls.cert || !config.server.tls.key) {
      throw new Error('config: server.tls requires both cert and key to be set')
    }
    if (!existsSync(config.server.tls.cert)) {
      throw new Error(`config: server.tls.cert file not found: ${config.server.tls.cert}`)
    }
    if (!existsSync(config.server.tls.key)) {
      throw new Error(`config: server.tls.key file not found: ${config.server.tls.key}`)
    }
  }

  // Upstream validation
  if (!config.upstream?.url) {
    throw new Error('config: upstream.url is required')
  }
  try {
    new URL(config.upstream.url)
  } catch {
    throw new Error(`config: upstream.url is not a valid URL: ${config.upstream.url}`)
  }

  // Auth validation
  if (!config.auth?.tokens?.length) {
    throw new Error('config: auth.tokens must have at least one entry')
  }
  for (const token of config.auth.tokens) {
    if (!token.name) {
      throw new Error('config: auth.tokens entries must have a name')
    }
    if (!token.token) {
      throw new Error(`config: auth.tokens[${token.name}] token is empty`)
    }
    if (token.token.length < 16) {
      throw new Error(`config: auth.tokens[${token.name}] token is suspiciously short (${token.token.length} chars)`)
    }
  }

  // OAuth validation
  if (!config.oauth?.refresh_token) {
    throw new Error('config: oauth.refresh_token is required. Do a browser OAuth login on the admin machine, then copy the refresh token from ~/.claude/.credentials.json')
  }

  // Discord webhook validation (optional but validate if provided)
  if (config.notify?.discord_webhook) {
    try {
      const url = new URL(config.notify.discord_webhook)
      if (!url.hostname.includes('discord')) {
        throw new Error('not a discord URL')
      }
      if (!url.pathname.includes('/webhooks/')) {
        throw new Error('not a webhook URL')
      }
    } catch (err) {
      throw new Error(`config: notify.discord_webhook is not a valid Discord webhook URL: ${err instanceof Error ? err.message : err}`)
    }
  }


  // Logging validation
  if (config.logging?.level && !['debug', 'info', 'warn', 'error'].includes(config.logging.level)) {
    throw new Error(`config: logging.level must be one of: debug, info, warn, error (got ${config.logging.level})`)
  }
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || resolve(process.cwd(), 'config.yaml')
  const raw = readFileSync(filePath, 'utf-8')
  const config = parse(raw) as Config

  validateConfig(config)

  return config
}
