import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, existsSync, type WriteStream } from 'fs'
import { createGzip, type Gzip } from 'zlib'
import { resolve, join } from 'path'
import { log } from './logger.js'

// Append-only gzipped JSONL conversation log for regulatory retention.
// Each line is a self-contained JSON record with full request + response bodies,
// client attribution, token usage, and timing metadata.

type ConversationRecord = {
  ts: string
  requestId: string
  client: string
  method: string
  path: string
  status: number
  latencyMs: number
  requestBytes: number
  responseBytes: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
  request: unknown
  response: string
}

type LogOpts = {
  dir: string
  retentionDays: number
}

let opts: LogOpts | null = null
let currentDay = ''
let gzStream: Gzip | null = null
let fileStream: WriteStream | null = null
let pendingWrites = 0

// In-flight request/response collectors keyed by requestId
const inflight = new Map<string, {
  client: string
  method: string
  path: string
  requestBody: Buffer
  responseChunks: Buffer[]
  startTime: number
  requestId: string
}>()

function dayTag(): string {
  return new Date().toISOString().slice(0, 10)
}

function rotateIfNeeded(): void {
  const day = dayTag()
  if (day === currentDay && gzStream && fileStream) return

  // Close previous streams
  if (gzStream) {
    gzStream.end()
    gzStream = null
    fileStream = null
  }

  currentDay = day
  const filePath = join(opts!.dir, `conversations-${day}.jsonl.gz`)
  fileStream = createWriteStream(filePath, { flags: 'a', mode: 0o600 })
  gzStream = createGzip({ flush: 1 }) // Z_SYNC_FLUSH after each write for crash safety
  gzStream.pipe(fileStream)

  fileStream.on('error', (err) => {
    log('warn', `conversation-log: write error: ${err.message}`)
  })

  log('info', `conversation-log: writing to ${filePath}`)
}

function pruneOldFiles(): void {
  if (!opts) return
  const cutoff = Date.now() - opts.retentionDays * 86_400_000
  try {
    for (const f of readdirSync(opts.dir)) {
      if (!f.startsWith('conversations-') || !f.endsWith('.jsonl.gz')) continue
      const fullPath = join(opts.dir, f)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs < cutoff) {
          unlinkSync(fullPath)
          log('info', `conversation-log: pruned ${f} (older than ${opts.retentionDays}d)`)
        }
      } catch { /* skip files we can't stat */ }
    }
  } catch { /* dir read failed, skip */ }
}

export function initConversationLog(config: { dir?: string; retentionDays?: number }): void {
  const dir = config.dir || resolve(process.cwd(), 'conversation-history')
  const retentionDays = config.retentionDays ?? 365

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  opts = { dir, retentionDays }

  rotateIfNeeded()
  pruneOldFiles()

  // Prune daily
  const pruneTimer = setInterval(pruneOldFiles, 86_400_000)
  pruneTimer.unref?.()

  log('info', `conversation-log: armed (dir=${dir}, retention=${retentionDays}d)`)
}

/**
 * Begin tracking a request. Call before forwarding upstream.
 * Stores the request body for later pairing with the response.
 */
export function logRequestStart(
  requestId: string,
  client: string,
  method: string,
  path: string,
  body: Buffer,
  startTime: number,
): void {
  if (!opts) return
  inflight.set(requestId, {
    client,
    method,
    path,
    requestBody: body,
    responseChunks: [],
    startTime,
    requestId,
  })
}

/**
 * Attach to the upstream response stream to capture the response body.
 * Non-destructive — listens to data/end events alongside pipe().
 * Must be called in the same tick as pipe() to avoid missing chunks.
 */
export function logResponseAttach(
  requestId: string,
  proxyRes: import('http').IncomingMessage,
  status: number,
): void {
  if (!opts) return
  const entry = inflight.get(requestId)
  if (!entry) return

  proxyRes.on('data', (chunk: Buffer) => {
    try {
      entry.responseChunks.push(
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      )
    } catch { /* never disrupt the proxied response */ }
  })

  proxyRes.on('end', () => {
    try {
      inflight.delete(requestId)
      const responseBody = Buffer.concat(entry.responseChunks)

      let requestParsed: unknown
      try {
        requestParsed = JSON.parse(entry.requestBody.toString('utf8'))
      } catch {
        requestParsed = entry.requestBody.toString('utf8')
      }

      // Extract usage from SSE response if possible
      const usage = extractUsageFromResponse(responseBody)

      const record: ConversationRecord = {
        ts: new Date().toISOString(),
        requestId,
        client: entry.client,
        method: entry.method,
        path: entry.path,
        status,
        latencyMs: Date.now() - entry.startTime,
        requestBytes: entry.requestBody.length,
        responseBytes: responseBody.length,
        usage,
        request: requestParsed,
        response: responseBody.toString('utf8'),
      }

      writeRecord(record)
    } catch (err) {
      log('warn', `conversation-log: failed to finalize ${requestId}: ${err}`)
      inflight.delete(requestId)
    }
  })

  proxyRes.on('error', () => {
    inflight.delete(requestId)
  })
}

/**
 * Clean up an inflight entry when the upstream request fails (no response).
 */
export function logRequestError(requestId: string): void {
  inflight.delete(requestId)
}

function extractUsageFromResponse(body: Buffer): ConversationRecord['usage'] {
  const result = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  try {
    const text = body.toString('utf8')
    // Try SSE format first (most common for Claude Code)
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const obj = JSON.parse(data)
        if (obj?.type === 'message_start' && obj.message?.usage) {
          const u = obj.message.usage
          result.inputTokens += u.input_tokens || 0
          result.cacheReadTokens += u.cache_read_input_tokens || 0
          result.cacheCreationTokens += u.cache_creation_input_tokens || 0
        } else if (obj?.type === 'message_delta' && obj.usage) {
          result.outputTokens += obj.usage.output_tokens || 0
        }
      } catch { /* skip unparseable lines */ }
    }
    // Fall back to plain JSON
    if (result.inputTokens === 0 && result.outputTokens === 0) {
      try {
        const j = JSON.parse(text)
        if (j.usage) {
          result.inputTokens = j.usage.input_tokens || 0
          result.outputTokens = j.usage.output_tokens || 0
          result.cacheReadTokens = j.usage.cache_read_input_tokens || 0
          result.cacheCreationTokens = j.usage.cache_creation_input_tokens || 0
        }
      } catch { /* not JSON */ }
    }
  } catch { /* body parse failed */ }
  return result
}

function writeRecord(record: ConversationRecord): void {
  if (!gzStream || !opts) return
  try {
    rotateIfNeeded()
    const line = JSON.stringify(record) + '\n'
    pendingWrites++
    gzStream.write(line, () => {
      pendingWrites--
    })
  } catch (err) {
    log('warn', `conversation-log: write failed: ${err}`)
  }
}

/**
 * Flush and close the current log file. Call on graceful shutdown.
 */
export function closeConversationLog(): Promise<void> {
  return new Promise((resolve) => {
    if (!gzStream) { resolve(); return }
    gzStream.end(() => {
      gzStream = null
      fileStream = null
      resolve()
    })
  })
}
