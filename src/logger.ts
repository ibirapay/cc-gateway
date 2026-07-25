type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel) {
  currentLevel = level
}

/**
 * Sanitize a string to remove sensitive credentials and tokens.
 * Masks Authorization headers, x-api-key, and OAuth tokens.
 */
export function sanitize(input: string): string {
  if (!input) return input

  return input
    // Mask Authorization: Bearer tokens (show only last 4 chars)
    .replace(/Authorization:\s*Bearer\s+[\w-]+/gi, (match) => {
      const token = match.split(/\s+/)[2] || ''
      const masked = token.length > 4 ? `...${token.slice(-4)}` : '...'
      return `Authorization: Bearer ${masked}`
    })
    // Mask x-api-key values
    .replace(/x-api-key:\s*[\w-]+/gi, (match) => {
      const token = match.split(':')[1]?.trim() || ''
      const masked = token.length > 4 ? `...${token.slice(-4)}` : '...'
      return `x-api-key: ${masked}`
    })
    // Mask sk-ant-* tokens in text
    .replace(/sk-ant-[\w-]{20,}/g, (match) => {
      const masked = match.length > 4 ? `sk-ant-...${match.slice(-4)}` : 'sk-ant-...'
      return masked
    })
    // Mask oat01- tokens
    .replace(/oat01-[\w-]{20,}/g, (match) => {
      const masked = match.length > 4 ? `oat01-...${match.slice(-4)}` : 'oat01-...'
      return masked
    })
}

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return

  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`
  const sanitizedMsg = sanitize(message)

  if (extra) {
    const sanitizedExtra = sanitize(JSON.stringify(extra))
    console.log(`${prefix} ${sanitizedMsg}`, sanitizedExtra)
  } else {
    console.log(`${prefix} ${sanitizedMsg}`)
  }
}

export function audit(clientName: string, method: string, path: string, status: number) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [AUDIT] client=${clientName} ${method} ${path} → ${status}`)
}
