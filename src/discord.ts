import { request as httpsRequest } from 'https'
import { log } from './logger.js'
import { getProxyAgent } from './proxy-agent.js'

/** Subset of Discord's embed object we actually use. */
export type DiscordEmbed = {
  title?: string
  description?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

/**
 * Send a message to a Discord webhook. Routes through the gateway's egress proxy.
 * Never throws — webhook failures are logged but never affect client requests.
 * @param webhook - Discord webhook URL
 * @param msg - Plain content string (capped at 1990 chars), or an embed payload
 * @returns Promise that resolves when webhook delivery is complete (success or failure)
 */
export function sendDiscord(
  webhook: string,
  msg: string | { content?: string; embeds?: DiscordEmbed[] },
): Promise<void> {
  return new Promise((done) => {
    let url: URL
    try {
      url = new URL(webhook)
    } catch {
      log('warn', 'discord: invalid webhook URL')
      return done()
    }

    const payload = typeof msg === 'string' ? { content: msg.slice(0, 1990) } : msg
    const body = JSON.stringify({ ...payload, username: 'CC Gateway' })
    const agent = getProxyAgent()
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(agent && { agent }),
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            log('warn', `discord: webhook returned ${res.statusCode}`)
          }
          done()
        })
      },
    )
    req.on('error', (err) => {
      log('warn', `discord: webhook failed: ${err.message}`)
      done()
    })
    req.write(body)
    req.end()
  })
}
