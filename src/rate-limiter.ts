import { log } from './logger.js'

// Sliding window counter for rate limiting
type ClientRateLimit = {
  windowStart: number
  requestCount: number
  lastReset: number
}

const clientLimits = new Map<string, ClientRateLimit>()
let rpsLimits = new Map<string, number>() // client -> max requests per second

const WINDOW_SIZE_MS = 1000 // 1 second window

/**
 * Initialize rate limiting with per-client limits (requests per second).
 * @param limits - Map of client name to max requests per second (0 = unlimited)
 */
export function initRateLimiter(limits: Map<string, number>): void {
  rpsLimits = limits
  log('info', `Rate limiter initialized with ${limits.size} client limits`)
}

/**
 * Check if a client has exceeded their rate limit.
 * Uses sliding window counter algorithm.
 * @param clientName - Client name
 * @returns true if request is allowed, false if rate limit exceeded
 */
export function checkRateLimit(clientName: string): boolean {
  const limit = rpsLimits.get(clientName) ?? 0
  if (limit === 0) return true // 0 = unlimited

  const now = Date.now()
  let clientLimit = clientLimits.get(clientName)

  // Initialize or reset expired window
  if (!clientLimit || now - clientLimit.windowStart > WINDOW_SIZE_MS) {
    clientLimits.set(clientName, {
      windowStart: now,
      requestCount: 1,
      lastReset: now,
    })
    return true
  }

  // Check if still within limit
  if (clientLimit.requestCount < limit) {
    clientLimit.requestCount++
    return true
  }

  // Rate limit exceeded
  return false
}

/**
 * Get current usage for a client (for monitoring).
 * @param clientName - Client name
 * @returns Object with current request count and limit, or null if not tracked
 */
export function getClientUsage(clientName: string): { current: number; limit: number } | null {
  const limit = rpsLimits.get(clientName)
  if (limit === undefined) return null

  const clientLimit = clientLimits.get(clientName)
  const current = clientLimit?.requestCount ?? 0

  return { current, limit }
}

/**
 * Log rate limit hit for monitoring.
 */
export function logRateLimitHit(clientName: string): void {
  const limit = rpsLimits.get(clientName) ?? 0
  log('warn', `Rate limit exceeded for client "${clientName}" (limit: ${limit} req/s)`)
}
