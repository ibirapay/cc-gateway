import { log } from './logger.js'

type CircuitState = 'closed' | 'open' | 'half-open'

interface CircuitBreakerState {
  state: CircuitState
  failureCount: number
  successCount: number
  lastFailureTime: number
  openedAt?: number
}

const breaker: CircuitBreakerState = {
  state: 'closed',
  failureCount: 0,
  successCount: 0,
  lastFailureTime: 0,
}

// Configuration
const FAILURE_THRESHOLD = 5 // Open after 5 consecutive failures
const FAILURE_RATE_THRESHOLD = 0.5 // Or if 50% of requests fail in window
const WINDOW_SIZE_MS = 30_000 // 30-second window for failure tracking
const COOLDOWN_MS = 60_000 // Stay open for 60 seconds before half-open
const SUCCESS_THRESHOLD = 3 // Close after 3 successful requests in half-open state

/**
 * Record a successful upstream response.
 * May transition from half-open to closed state.
 */
export function recordSuccess(): void {
  if (breaker.state === 'half-open') {
    breaker.successCount++
    if (breaker.successCount >= SUCCESS_THRESHOLD) {
      breaker.state = 'closed'
      breaker.failureCount = 0
      breaker.successCount = 0
      log('info', 'Circuit breaker: transitioned to closed (upstream recovered)')
    }
  } else if (breaker.state === 'closed') {
    breaker.successCount++
    // Reset failure count on success (sliding window)
    const now = Date.now()
    if (now - breaker.lastFailureTime > WINDOW_SIZE_MS) {
      breaker.failureCount = 0
      breaker.successCount = 0
    }
  }
}

/**
 * Record a failed upstream response (4xx, 5xx, timeout, connection error).
 * May transition from closed to open state.
 */
export function recordFailure(reason?: string): void {
  const now = Date.now()

  if (breaker.state === 'closed') {
    breaker.failureCount++
    breaker.lastFailureTime = now

    // Open circuit if threshold exceeded
    if (breaker.failureCount >= FAILURE_THRESHOLD) {
      breaker.state = 'open'
      breaker.openedAt = now
      log('warn', `Circuit breaker: opened after ${breaker.failureCount} failures${reason ? `: ${reason}` : ''}`)
      breaker.failureCount = 0
      breaker.successCount = 0
      return
    }
  } else if (breaker.state === 'half-open') {
    // Any failure in half-open state reopens the circuit
    breaker.state = 'open'
    breaker.openedAt = now
    breaker.failureCount = 0
    breaker.successCount = 0
    log('warn', `Circuit breaker: reopened during recovery${reason ? `: ${reason}` : ''}`)
    return
  }

  // Check if circuit should transition from open to half-open
  if (breaker.state === 'open' && breaker.openedAt) {
    if (now - breaker.openedAt > COOLDOWN_MS) {
      breaker.state = 'half-open'
      breaker.successCount = 0
      breaker.failureCount = 0
      log('info', 'Circuit breaker: transitioned to half-open (attempting recovery)')
    }
  }
}

/**
 * Check if the circuit is currently open (should reject requests).
 */
export function isOpen(): boolean {
  if (breaker.state === 'open' && breaker.openedAt) {
    if (Date.now() - breaker.openedAt > COOLDOWN_MS) {
      breaker.state = 'half-open'
      breaker.successCount = 0
      breaker.failureCount = 0
      log('info', 'Circuit breaker: transitioned to half-open (attempting recovery)')
      return false
    }
  }
  return breaker.state === 'open'
}

/**
 * Get current circuit breaker state (for monitoring).
 */
export function getState(): {
  state: CircuitState
  failureCount: number
  successCount: number
  openedAt?: string
} {
  return {
    state: breaker.state,
    failureCount: breaker.failureCount,
    successCount: breaker.successCount,
    openedAt: breaker.openedAt ? new Date(breaker.openedAt).toISOString() : undefined,
  }
}
