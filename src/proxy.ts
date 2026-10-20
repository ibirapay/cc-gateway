import { createServer as createHttpsServer, type ServerOptions } from 'https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import { randomUUID } from 'crypto'
import type { Config } from './config.js'
import { authenticate, initAuth, isAdmin } from './auth.js'
import { endGrace, rotateClientToken, RotateError } from './rotate.js'
import { resolve } from 'path'
import { getAccessToken, swapOAuth } from './oauth.js'
import { audit, log } from './logger.js'
import { getProxyAgent } from './proxy-agent.js'
import { maybeNotifyUsage } from './usage-notify.js'
import { attachUsage, recordRequest, recordMetrics } from './usage-meter.js'
import { logRequestStart, logResponseAttach, logRequestError } from './conversation-log.js'
import { initRateLimiter, checkRateLimit, logRateLimitHit } from './rate-limiter.js'
import { isOpen, recordSuccess, recordFailure } from './circuit-breaker.js'

// Headers that must NOT be forwarded upstream: hop-by-hop framing headers and
// the client's own auth (the gateway injects the real OAuth token below).
// Everything else passes through unchanged — this gateway is an OAuth-swap
// passthrough, no identity/env/path masking.
const STRIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'content-length',
  'authorization',
  'x-api-key',
  // Prevent compressed responses so attachUsage can parse SSE for token metering
  'accept-encoding',
])

/**
 * Copy client request headers through unchanged, dropping only hop-by-hop
 * framing headers and the client's auth. No User-Agent / identity rewriting.
 */
function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (STRIP_HEADERS.has(key.toLowerCase())) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

export function startProxy(config: Config, configPath?: string) {
  const cfgPath = configPath || resolve(process.cwd(), 'config.yaml')
  initAuth(config)

  // Initialize rate limiter with global limit applied to all clients equally
  // All clients share the same limit since they pay equally for the shared account
  const globalLimit = config.rate_limiting?.rps ?? 0 // 0 = unlimited
  const rateLimits = new Map<string, number>()
  for (const token of config.auth.tokens) {
    rateLimits.set(token.name, globalLimit)
  }
  initRateLimiter(rateLimits)
  if (globalLimit > 0) {
    log('info', `Global rate limit: ${globalLimit} req/sec per client (shared account)`)
  }

  const upstream = new URL(config.upstream.url)
  const useTls = config.server.tls?.cert && config.server.tls?.key

  // Client aborts (Ctrl+C, timeout, disconnect) surface as an 'error' event
  // on req/res or a rejection from handleRequest (e.g. the `for await` body
  // read throwing "aborted"). Left unhandled, either one crashes the whole
  // process and drops every other client's in-flight requests. Log and move
  // on instead.
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    req.on('error', (err) => {
      log('warn', `Client request error: ${err.message}`)
    })
    res.on('error', (err) => {
      log('warn', `Client response error: ${err.message}`)
    })

    handleRequest(req, res, config, upstream, cfgPath).catch((err) => {
      log('error', `Unhandled error in handleRequest: ${err instanceof Error ? err.message : err}`)
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal gateway error' }))
        } catch {
          // response socket is already gone; nothing to do
        }
      }
    })
  }

  let server
  if (useTls) {
    const tlsOptions: ServerOptions = {
      cert: readFileSync(config.server.tls.cert),
      key: readFileSync(config.server.tls.key),
    }
    server = createHttpsServer(tlsOptions, handler)
  } else {
    server = createHttpServer(handler)
    log('warn', 'Running without TLS - only use for local development')
  }

  server.listen(config.server.port, () => {
    log('info', `CC Gateway listening on ${useTls ? 'https' : 'http'}://0.0.0.0:${config.server.port}`)
    log('info', `Upstream: ${config.upstream.url}`)
    log('info', `Mode: OAuth-swap passthrough (no identity/env masking)`)
    log('info', `Authorized clients: ${config.auth.tokens.map(t => t.name).join(', ')}`)
  })

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
  configPath: string,
) {
  const method = req.method || 'GET'
  const path = req.url || '/'
  const clientIp = req.socket.remoteAddress || 'unknown'
  const requestId = randomUUID()
  const startTime = Date.now()

  log('info', `[${requestId}] ← ${method} ${path} from ${clientIp}`)

  // Health check - no auth required
  if (path === '/_health') {
    const oauthOk = !!getAccessToken()
    const status = oauthOk ? 200 : 503
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: oauthOk ? 'ok' : 'degraded',
      oauth: oauthOk ? 'valid' : 'expired/refreshing',
      mode: 'oauth-swap-passthrough',
      upstream: config.upstream.url,
      clients: config.auth.tokens.map(t => t.name),
    }))
    return
  }

  // Dry-run verification - shows gateway behavior (auth required)
  if (path === '/_verify') {
    const clientName = authenticate(req)
    if (!clientName) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const sample = buildVerificationPayload(config)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(sample, null, 2))
    return
  }

  // Authenticate client (proxy-level auth)
  const clientName = authenticate(req)
  if (!clientName) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized - provide client token via x-api-key header' }))
    log('warn', `Unauthorized request: ${method} ${path}`)
    return
  }

  log('info', `[${requestId}] Client "${clientName}" → ${method} ${path}`)

  // Admin: rotate a client's token (old one valid 24h unless grace=false), or end a grace period now
  if ((path === '/_admin/rotate' || path === '/_admin/end-grace') && method === 'POST') {
    if (!isAdmin(config, clientName)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Admin only' }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    let status = 200
    let payload: unknown
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const name = body?.name
      if (!name || typeof name !== 'string') throw new RotateError(400, 'Missing client name')
      if (path === '/_admin/end-grace') {
        endGrace(config, configPath, name)
        log('info', `[${requestId}] Client "${clientName}" ended the grace period of "${name}"`)
        payload = { status: 'ok', name }
      } else {
        const r = rotateClientToken(config, configPath, name, Date.now(), body?.grace !== false)
        const until = r.previousValidUntil === null ? 'killed now' : `valid until ${new Date(r.previousValidUntil).toISOString()}`
        log('info', `[${requestId}] Client "${clientName}" rotated the token of "${name}" (old token ${until})`)
        payload = {
          status: 'ok',
          name: r.name,
          token: r.token,
          previous_valid_until: r.previousValidUntil,
          self: r.name === clientName,
          launcher: r.launcher,
        }
      }
    } catch (err) {
      status = err instanceof RotateError ? err.status : err instanceof SyntaxError ? 400 : 500
      payload = { error: err instanceof Error ? err.message : String(err) }
      log('error', `[${requestId}] Token rotation failed: ${(payload as { error: string }).error}`)
    }
    if (config.logging.audit) audit(clientName, method, path, status)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }

  // OAuth swap endpoint — authenticated client can replace the refresh token
  if (path === '/_oauth' && method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const refreshToken = body?.refresh_token
      if (!refreshToken || typeof refreshToken !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing refresh_token in request body' }))
        return
      }
      if (!refreshToken.startsWith('sk-ant-ort01-')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid refresh token format (expected sk-ant-ort01-...)' }))
        return
      }
      log('info', `[${requestId}] Client "${clientName}" requesting OAuth swap`)
      const result = await swapOAuth(refreshToken)
      if (config.logging.audit) {
        audit(clientName, method, path, 200)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        message: 'OAuth token swapped successfully',
        expires_at: result.expiresAt,
        expires_in_minutes: Math.round((result.expiresAt - Date.now()) / 60_000),
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', `[${requestId}] OAuth swap failed: ${msg}`)
      if (config.logging.audit) {
        audit(clientName, method, path, 502)
      }
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: 'OAuth swap failed — the new refresh token could not be exchanged',
        detail: msg,
      }))
    }
    return
  }

  // Check rate limit
  if (!checkRateLimit(clientName)) {
    logRateLimitHit(clientName)
    res.writeHead(429, { 'Content-Type': 'application/json', 'x-request-id': requestId })
    res.end(JSON.stringify({ error: 'Rate limit exceeded', clientName }))
    return
  }

  // Check circuit breaker
  if (isOpen()) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'x-request-id': requestId })
    res.end(JSON.stringify({ error: 'Gateway circuit breaker is open - upstream service unavailable' }))
    return
  }

  // Get the real OAuth token (managed by gateway)
  const oauthToken = getAccessToken()
  if (!oauthToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'OAuth token not available - gateway is refreshing' }))
    log('error', 'No valid OAuth token available')
    return
  }

  // Collect request body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const body = Buffer.concat(chunks)
  const requestBytes = body.length

  logRequestStart(requestId, clientName, method, path, body, startTime)

  // OAuth-swap passthrough: forward the body unchanged (no identity/env masking).
  // Only strip hop-by-hop + client-auth headers; everything else passes through.
  const forwardHeaders = sanitizeHeaders(
    req.headers as Record<string, string | string[] | undefined>,
  )

  // OAuth tokens (sk-ant-oat01-) need Authorization: Bearer; API keys (sk-ant-api03-) use x-api-key
  if (oauthToken.startsWith("sk-ant-oat01-")) {
    delete forwardHeaders["x-api-key"]
    forwardHeaders["authorization"] = "Bearer " + oauthToken
  } else {
    forwardHeaders["x-api-key"] = oauthToken
  }

  // Add request ID for tracing
  forwardHeaders["x-request-id"] = requestId

  // Forward to upstream
  const upstreamUrl = new URL(path, upstream)

  const agent = getProxyAgent()
  const proxyReq = httpsRequest(
    upstreamUrl,
    {
      method,
      headers: {
        ...forwardHeaders,
        host: upstream.host,
        'content-length': String(body.length),
      },
      ...(agent && { agent }),
    },
    (proxyRes) => {
      const status = proxyRes.statusCode || 502

      const responseHeaders = { ...proxyRes.headers }
      delete responseHeaders['transfer-encoding']

      res.writeHead(status, responseHeaders)

      // Track response size as it streams from upstream
      let responseBytes = 0
      const trackingRes = proxyRes.on('data', (chunk) => {
        if (typeof chunk === 'string') {
          responseBytes += Buffer.byteLength(chunk)
        } else {
          responseBytes += chunk.length
        }
      })

      // Log upstream error bodies so we know WHY Anthropic rejected a request.
      if (status === 401 || status === 403) {
        const errChunks: Buffer[] = []
        proxyRes.on('data', (c: Buffer) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString('utf8').slice(0, 500)
          log('warn', `[${requestId}] upstream ${status} for ${clientName}: ${body}`)
        })
      }

      // Stream response directly (SSE for Claude responses)
      proxyRes.pipe(res)

      // Attribute this response's token usage to the client (non-destructive
      // tap — must be attached right after pipe() so no chunks are missed).
      attachUsage(clientName, proxyRes, status)
      logResponseAttach(requestId, proxyRes, status)
      recordRequest(clientName, status)

      // Record metrics (latency and sizes) when response ends
      res.on('finish', () => {
        const latencyMs = Date.now() - startTime
        recordMetrics(clientName, latencyMs, requestBytes, responseBytes)
      })

      // Record circuit breaker state based on response
      if (status >= 500) {
        recordFailure(`upstream returned ${status}`)
      } else if (status >= 400 && status < 500) {
        // Client errors (4xx) don't trip circuit breaker
        recordSuccess()
      } else {
        recordSuccess()
      }

      // Watch the shared account's usage headers and ping Discord on 5% bands.
      maybeNotifyUsage(proxyRes.headers)

      if (config.logging.audit) {
        audit(clientName, method, path, status)
      }
    },
  )

  proxyReq.on('error', (err) => {
    log('error', `[${requestId}] Upstream error: ${err.message}`)
    logRequestError(requestId)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'x-request-id': requestId })
      res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message }))
    }
    recordRequest(clientName, 502)
    recordFailure(`connection error: ${err.message}`)
    if (config.logging.audit) {
      audit(clientName, method, path, 502)
    }
  })

  proxyReq.write(body)
  proxyReq.end()
}

/**
 * Describe gateway behavior for the /_verify endpoint.
 * The gateway is an OAuth-swap passthrough: request bodies and headers are
 * forwarded unchanged; only the client token is swapped for the shared OAuth
 * token and hop-by-hop/auth headers are stripped.
 */
function buildVerificationPayload(config: Config) {
  return {
    _info: 'OAuth-swap passthrough gateway',
    behavior: {
      body: 'forwarded unchanged (no identity/env/path masking)',
      headers_stripped: Array.from(STRIP_HEADERS),
      auth: 'client token swapped for shared OAuth token (Authorization: Bearer)',
    },
    upstream: config.upstream.url,
    clients: config.auth.tokens.map(t => t.name),
  }
}
