import type { IncomingMessage } from 'http'
import type { Config, TokenEntry } from './config.js'

const tokenMap = new Map<string, TokenEntry>()

/**
 * Initialize the authentication system with configured client tokens.
 * Builds an in-memory lookup map for fast token validation on each request.
 * @param config - Gateway configuration containing auth.tokens array
 */
export function initAuth(config: Config) {
  tokenMap.clear()
  for (const entry of config.auth.tokens) {
    tokenMap.set(entry.token, entry)
  }
}

/**
 * Authenticate incoming request by API key or Bearer token.
 * Supports both x-api-key header and Bearer token in Authorization/Proxy-Authorization headers.
 * Returns the token entry name (for audit logging) or null if unauthorized.
 * @param req - Incoming HTTP request
 * @returns Client name if authenticated, null otherwise
 */
export function authenticate(req: IncomingMessage): string | null {
  // CC with ANTHROPIC_API_KEY sends x-api-key header
  const apiKey = req.headers['x-api-key']
  if (apiKey && typeof apiKey === 'string') {
    const entry = tokenMap.get(apiKey)
    if (entry) return entry.name
  }

  // Fallback: Bearer token in Authorization or Proxy-Authorization (case-insensitive)
  const authHeader = req.headers['proxy-authorization'] || req.headers['authorization']
  if (!authHeader || typeof authHeader !== 'string') return null

  // Match Bearer token with case-insensitive prefix (handles Bearer, bearer, BEARER)
  const match = authHeader.match(/^bearer\s+(.+)$/i)
  if (!match) return null

  const entry = tokenMap.get(match[1])
  return entry?.name ?? null
}
