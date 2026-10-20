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

function lookup(token: string): TokenEntry | null {
  const slot = tokenMap.get(token)
  if (!slot) return null
  if (slot.expiresAt !== undefined && Date.now() >= slot.expiresAt) return null
  return slot.entry
}

/**
 * Authenticate by x-api-key, or a Bearer token in Authorization/Proxy-Authorization.
 * Returns the client name (for audit logging) or null if unauthorized.
 */
export function authenticate(req: IncomingMessage): string | null {
  const apiKey = req.headers['x-api-key']
  if (apiKey && typeof apiKey === 'string') {
    const entry = lookup(apiKey)
    if (entry) return entry.name
  }
  const authHeader = req.headers['proxy-authorization'] || req.headers['authorization']
  if (!authHeader || typeof authHeader !== 'string') return null
  const match = authHeader.match(/^bearer\s+(.+)$/i)
  if (!match) return null
  return lookup(match[1])?.name ?? null
}

export function isAdmin(config: Config, name: string): boolean {
  return config.auth.tokens.some((t) => t.name === name && t.admin === true)
}
