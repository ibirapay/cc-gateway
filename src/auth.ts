import type { IncomingMessage } from 'http'
import type { Config, TokenEntry } from './config.js'

type Slot = { entry: TokenEntry; expiresAt?: number }

const tokenMap = new Map<string, Slot>()

/**
 * Build the in-memory token lookup. A rotated client's previous token is
 * registered too, until its grace period (previous_expires_at) ends.
 */
export function initAuth(config: Config) {
  tokenMap.clear()
  for (const entry of config.auth.tokens) {
    tokenMap.set(entry.token, { entry })
    if (entry.previous_token && (entry.previous_expires_at ?? 0) > Date.now()) {
      tokenMap.set(entry.previous_token, { entry, expiresAt: entry.previous_expires_at })
    }
  }
}

function lookup(token: string): Slot | null {
  const slot = tokenMap.get(token)
  if (!slot) return null
  if (slot.expiresAt !== undefined && Date.now() >= slot.expiresAt) return null
  return slot
}

/** First valid slot from x-api-key, then a Bearer token in Authorization/Proxy-Authorization. */
function match(req: IncomingMessage): Slot | null {
  const apiKey = req.headers['x-api-key']
  if (apiKey && typeof apiKey === 'string') {
    const slot = lookup(apiKey)
    if (slot) return slot
  }
  const authHeader = req.headers['proxy-authorization'] || req.headers['authorization']
  if (!authHeader || typeof authHeader !== 'string') return null
  const bearer = authHeader.match(/^bearer\s+(.+)$/i)
  return bearer ? lookup(bearer[1]) : null
}

/** Returns the client name (for audit logging) or null if unauthorized. */
export function authenticate(req: IncomingMessage): string | null {
  return match(req)?.entry.name ?? null
}

/**
 * Admin routes need an admin client's CURRENT token: a grace-period token may be
 * the leaked one being rotated away, so it must not be able to rotate anything.
 */
export function isAdminRequest(req: IncomingMessage): boolean {
  const slot = match(req)
  return !!slot && slot.expiresAt === undefined && slot.entry.admin === true
}
