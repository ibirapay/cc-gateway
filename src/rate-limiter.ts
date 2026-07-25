import { log } from './logger.js'

// Shared global rate limit window
type GlobalWindow = {
  windowStart: number
  totalRequests: number
}

// Per-client tracking (for monitoring/fairness)
type ClientRateLimit = {
  requestsInWindow: number
}

const clientLimits = new Map<string, ClientRateLimit>()
let globalWindow: GlobalWindow | null = null
let globalLimit = 0 // Total req/sec for ALL clients combined
let clientCount = 0 // Number of active clients

const WINDOW_SIZE_MS = 1000 // 1 second window

/**
 * Initialize rate limiting with a SHARED global limit divided equally among all clients.
 * All clients together share the same limit. If limit is 100 req/sec and there are
 * 4 clients, each client can use ~25 req/sec on average.
 * @param limits - Map of client name to max requests per second (all should have same value, applied globally)
 */
export function initRateLimiter(limits: Map<string, number>): void {
  clientCount = limits.size
  globalLimit = limits.size > 0 ? Array.from(limits.values())[0] : 0

  if (globalLimit > 0) {
    const perClient = Math.floor(globalLimit / clientCount)
    log('info', `Rate limiter initialized (SHARED GLOBAL)`)
    log('info', `  Total limit: ${globalLimit} req/sec (all ${clientCount} clients combined)`)
    log('info', `  Per client: ~${perClient} req/sec (equal share)`)
  } else {
    log('info', `Rate limiter initialized: unlimited (no rate limit configured)`)
  }
}

/**
 * Check if a client has exceeded their share of the global rate limit.
 * Uses sliding window counter algorithm with shared global pool.
 * @param clientName - Client name
 * @returns true if request is allowed, false if rate limit exceeded
 */
export function checkRateLimit(clientName: string): boolean {
  if (globalLimit === 0) return true // 0 = unlimited

  const now = Date.now()

  // Initialize or reset expired global window
  if (!globalWindow || now - globalWindow.windowStart > WINDOW_SIZE_MS) {
    globalWindow = {
      windowStart: now,
      totalRequests: 1,
    }
    clientLimits.clear()
    clientLimits.set(clientName, { requestsInWindow: 1 })
    return true
  }

  // Check if GLOBAL limit exceeded
  if (globalWindow.totalRequests < globalLimit) {
    globalWindow.totalRequests++
    let client = clientLimits.get(clientName)
    if (!client) {
      client = { requestsInWindow: 0 }
      clientLimits.set(clientName, client)
    }
    client.requestsInWindow++
    return true
  }

  // Global rate limit exceeded
  return false
}

/**
 * Get current usage for a client and global pool (for monitoring).
 * @param clientName - Client name
 * @returns Object with client requests, global requests, and limits, or null if not tracked
 */
export function getClientUsage(clientName: string): {
  clientCurrent: number
  globalCurrent: number
  globalLimit: number
  perClientQuota: number
} | null {
  if (globalLimit === 0) return null

  const clientData = clientLimits.get(clientName)
  const clientCurrent = clientData?.requestsInWindow ?? 0
  const globalCurrent = globalWindow?.totalRequests ?? 0
  const perClientQuota = Math.floor(globalLimit / clientCount)

  return { clientCurrent, globalCurrent, globalLimit, perClientQuota }
}

/**
 * Log rate limit hit for monitoring.
 */
export function logRateLimitHit(clientName: string): void {
  const perClientQuota = Math.floor(globalLimit / clientCount)
  log('warn', `Global rate limit exceeded for client "${clientName}" (shared pool: ${globalLimit} req/s, your share: ~${perClientQuota} req/s)`)
}
