import type { IncomingMessage } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './logger.js'
import { sendDiscord } from './discord.js'

// Per-sub-user (per client-token) usage metering. Anthropic's rate-limit
// headers are account-wide for the shared OAuth account, so the only place we
// can attribute usage to an individual client is here, by tapping each
// upstream response and reading its `usage` block.
//
// Counters accumulate over the current 7-day account window; usage-notify calls
// resetCounters() when that window rolls over so per-user totals line up with
// the same window as the account's utilization %.

type Counters = {
  requests: number
  errors: number
  errors4xx: number
  errors5xx: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  // Latency tracking (in milliseconds)
  totalLatencyMs: number
  minLatencyMs: number
  maxLatencyMs: number
  // Size tracking
  totalRequestBytes: number
  totalResponseBytes: number
}

const emptyCounters = (): Counters => ({
  requests: 0,
  errors: 0,
  errors4xx: 0,
  errors5xx: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalLatencyMs: 0,
  minLatencyMs: Number.MAX_VALUE,
  maxLatencyMs: 0,
  totalRequestBytes: 0,
  totalResponseBytes: 0,
})

const clients = new Map<string, Counters>()
let since = new Date().toISOString()
let statePath: string | null = null
let webhookUrl: string | null = null
let dirty = false

// Summary text caching with TTL (30 seconds)
let cachedSummary: string | null = null
let cachedSummaryTime = 0
const SUMMARY_CACHE_TTL_MS = 30_000

function get(name: string): Counters {
  let c = clients.get(name)
  if (!c) {
    c = emptyCounters()
    clients.set(name, c)
  }
  return c
}

/**
 * Record an HTTP request for a client, including error count if status >= 400.
 * Tracks error categorization (4xx vs 5xx) for better analytics.
 * @param client - Client name (from auth config)
 * @param status - HTTP response status code
 */
export function recordRequest(client: string, status: number): void {
  const c = get(client)
  c.requests++
  if (status >= 400) {
    c.errors++
    if (status >= 500) {
      c.errors5xx++
    } else {
      c.errors4xx++
    }
  }
  dirty = true
}

/**
 * Record performance metrics for a request (latency and sizes).
 * @param client - Client name
 * @param latencyMs - Request latency in milliseconds
 * @param requestBytes - Request body size in bytes
 * @param responseBytes - Response body size in bytes
 */
export function recordMetrics(
  client: string,
  latencyMs: number,
  requestBytes: number,
  responseBytes: number,
): void {
  const c = get(client)
  c.totalLatencyMs += latencyMs
  c.minLatencyMs = Math.min(c.minLatencyMs, latencyMs)
  c.maxLatencyMs = Math.max(c.maxLatencyMs, latencyMs)
  c.totalRequestBytes += requestBytes
  c.totalResponseBytes += responseBytes
  dirty = true
}

type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type Acc = { input: number; output: number; cacheRead: number; cacheCreate: number }

function applyUsage(acc: Acc, u?: UsageLike): void {
  if (!u) return
  if (typeof u.input_tokens === 'number') acc.input += u.input_tokens
  if (typeof u.output_tokens === 'number') acc.output += u.output_tokens
  if (typeof u.cache_read_input_tokens === 'number') acc.cacheRead += u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === 'number') acc.cacheCreate += u.cache_creation_input_tokens
}

function parseSSE(data: string, acc: Acc, clientDebug?: string): void {
  if (!data || data === '[DONE]') return
  let obj: any
  try {
    obj = JSON.parse(data)
  } catch {
    return
  }
  // message_start carries input+cache tokens; message_delta carries the final
  // (authoritative) totals. Overwrite-on-present means the last one wins.
  if (obj?.type === 'message_start') {
    if (obj.message?.usage) {
      applyUsage(acc, obj.message.usage)
    } else if (clientDebug && obj.message) {
      log('debug', `${clientDebug}: message_start has no usage. Fields: ${Object.keys(obj.message || {}).join(', ')}`)
    }
  } else if (obj?.type === 'message_delta') {
    if (obj.usage) {
      applyUsage(acc, obj.usage)
    } else if (clientDebug) {
      log('debug', `${clientDebug}: message_delta has no usage. Fields: ${Object.keys(obj).join(', ')}`)
    }
  } else if (clientDebug && obj.type) {
    // Log first event of each type we see
    log('debug', `${clientDebug}: Unexpected event type '${obj.type}'. Fields: ${Object.keys(obj).join(', ')}`)
  }
}

/**
 * Tap an upstream response to extract and attribute token usage to a client.
 * Non-destructive: only listens to 'data'/'end' events; doesn't affect pipe() to client.
 * Must be called in the same tick as pipe() to avoid missing data.
 * @param client - Client name for usage attribution
 * @param res - Upstream response stream (already being piped to client)
 * @param status - HTTP response status code (optional, used for logging)
 */
export function attachUsage(client: string, res: IncomingMessage, status?: number): void {
  const ct = String(res.headers['content-type'] || '')
  const isSSE = ct.includes('event-stream')
  const acc: Acc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  let tail = ''
  let jsonBuf = ''
  const MAX_JSON = 2_000_000
  let eventCount = 0

  res.on('data', (chunk: Buffer) => {
    try {
      const s = chunk.toString('utf8')
      if (isSSE) {
        tail += s
        let nl: number
        while ((nl = tail.indexOf('\n')) >= 0) {
          const line = tail.slice(0, nl).trim()
          tail = tail.slice(nl + 1)
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            eventCount++
            parseSSE(data, acc, client)
          }
        }
        // Safety cap: never let an unterminated line grow unbounded.
        if (tail.length > 65536) tail = tail.slice(-4096)
      } else if (jsonBuf.length < MAX_JSON) {
        jsonBuf += s
      }
    } catch {
      // metering must never disrupt the proxied response
    }
  })

  res.on('end', () => {
    try {
      const statusStr = status ? ` [${status}]` : ''
      if (!isSSE && jsonBuf) {
        try {
          const j = JSON.parse(jsonBuf) as { usage?: UsageLike }
          if (j.usage) {
            log('debug', `${client}: Non-SSE response${statusStr} contains usage: in=${j.usage.input_tokens} out=${j.usage.output_tokens}`)
            applyUsage(acc, j.usage)
          } else {
            log('debug', `${client}: Non-SSE response${statusStr} has no usage field. Body keys: ${Object.keys(j).join(', ')}`)
          }
        } catch (parseErr) {
          log('warn', `${client}: Failed to parse non-SSE body: ${parseErr}`)
        }
      } else if (isSSE) {
        if (eventCount === 0) {
          log('warn', `${client}: SSE response${statusStr} received but no events parsed!`)
        } else {
          log('debug', `${client}: SSE response${statusStr} processed ${eventCount} events. Usage: in=${acc.input} out=${acc.output}`)
        }
      }
      // Always record usage values found, even if they're all 0.
      // Upstream API may legitimately return 0 tokens for some requests.
      const c = get(client)
      c.inputTokens += acc.input
      c.outputTokens += acc.output
      c.cacheReadTokens += acc.cacheRead
      c.cacheCreationTokens += acc.cacheCreate
      dirty = true
    } catch (err) {
      log('warn', `${client}: Usage parsing failed: ${err}`)
    }
  })

  res.on('error', () => {})
}

function load(): void {
  if (!statePath) return
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      since?: string
      clients?: Record<string, Partial<Counters>>
    }
    if (s.since) since = s.since
    if (s.clients) {
      for (const [k, v] of Object.entries(s.clients)) {
        clients.set(k, { ...emptyCounters(), ...v })
      }
    }
  } catch {
    // no prior state
  }
}

function persist(): void {
  if (!statePath || !dirty) return
  try {
    const obj = {
      since,
      updated: new Date().toISOString(),
      clients: Object.fromEntries(clients),
    }
    writeFileSync(statePath, JSON.stringify(obj, null, 2), { mode: 0o600 })
    dirty = false
    cachedSummary = null // Invalidate cache when state changes
  } catch (err) {
    log('warn', `usage-meter: persist failed: ${err}`)
  }
}

/**
 * Reset all per-user usage counters. Called when the 7-day account window rolls over.
 * Updates the usage start time and persists state to disk.
 */
export function resetCounters(): void {
  clients.clear()
  since = new Date().toISOString()
  dirty = true
  persist()
  log('info', 'usage-meter: per-user counters reset (new 7-day window)')
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Generate a formatted usage summary for Discord reporting.
 * Lists per-client token usage and error counts, sorted by total tokens used.
 * Results are cached for 30 seconds to avoid recalculation on frequent calls.
 * @returns Formatted markdown string with per-client and total usage
 */
export function summaryText(): string {
  const now = Date.now()
  // Return cached summary if still fresh
  if (cachedSummary && now - cachedSummaryTime < SUMMARY_CACHE_TTL_MS) {
    return cachedSummary
  }

  const allIn = (c: Counters) => c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens
  const rows = [...clients.entries()].sort(
    (a, b) => allIn(b[1]) + b[1].outputTokens - (allIn(a[1]) + a[1].outputTokens),
  )
  const sinceStr = since.slice(0, 16).replace('T', ' ') + ' UTC'
  if (!rows.length) {
    const summary = `📇 **CC Gateway — per-user usage**\nNo requests recorded since ${sinceStr}.`
    cachedSummary = summary
    cachedSummaryTime = now
    return summary
  }
  let tReq = 0
  let tIn = 0
  let tOut = 0
  let tErr = 0
  let tErr4xx = 0
  let tErr5xx = 0
  const lines = rows.map(([name, c]) => {
    const inTok = allIn(c)
    tReq += c.requests
    tIn += inTok
    tOut += c.outputTokens
    tErr += c.errors
    tErr4xx += c.errors4xx
    tErr5xx += c.errors5xx
    const tot = inTok + c.outputTokens
    const errStr = c.errors ? ` (${c.errors4xx}×4xx ${c.errors5xx}×5xx)` : ''
    const avgLatency = c.requests > 0 ? (c.totalLatencyMs / c.requests).toFixed(0) : 0
    const sizeStr = ` [req ${fmt(c.totalRequestBytes)} / res ${fmt(c.totalResponseBytes)}]`
    return `• **${name}** — ${c.requests} req${errStr}, ${fmt(tot)} tok (in ${fmt(inTok)} / out ${fmt(c.outputTokens)}), avg ${avgLatency}ms${sizeStr}`
  })
  const avgLatency = tReq > 0 ? (rows.reduce((sum, [_, c]) => sum + c.totalLatencyMs, 0) / tReq).toFixed(0) : 0
  const summary = [
    `📇 **CC Gateway — per-user usage** (since ${sinceStr})`,
    ...lines,
    `— total: ${tReq} req, ${tErr > 0 ? `${tErr4xx}×4xx ${tErr5xx}×5xx, ` : ''}${fmt(tIn + tOut)} tok (in ${fmt(tIn)} / out ${fmt(tOut)}), avg ${avgLatency}ms`,
  ].join('\n')

  cachedSummary = summary
  cachedSummaryTime = now
  return summary
}

/**
 * Post the usage summary to Discord via webhook.
 * Called by scheduled interval or on-demand (SIGUSR1 signal).
 * @throws Never throws; failures are logged and silently ignored
 */
export async function postReport(): Promise<void> {
  if (!webhookUrl) return
  await sendDiscord(webhookUrl, summaryText())
  log('info', 'usage-meter: posted per-user report to Discord')
}

/**
 * Initialize the usage meter system. Sets up state persistence and Discord reporting.
 * @param opts.webhook - Optional Discord webhook URL for scheduled reports
 * @param opts.statePath - Path to persist usage state (default: usage-meter-state.json in cwd)
 * @param opts.reportIntervalHours - How often to post reports to Discord (0 = disabled)
 */
export function initUsageMeter(opts: {
  webhook?: string
  statePath?: string
  reportIntervalHours?: number
}): void {
  webhookUrl = opts.webhook || null
  statePath = opts.statePath || resolve(process.cwd(), 'usage-meter-state.json')
  load()

  const persistTimer = setInterval(persist, 30_000)
  persistTimer.unref?.()

  const hrs = opts.reportIntervalHours ?? 0
  if (webhookUrl && hrs > 0) {
    const reportTimer = setInterval(() => void postReport(), hrs * 3_600_000)
    reportTimer.unref?.()
    log('info', `Usage meter armed: per-user report every ${hrs}h to Discord`)
  } else {
    log('info', 'Usage meter armed: metering on (no scheduled Discord report)')
  }
}
