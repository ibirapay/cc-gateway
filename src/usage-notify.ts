import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './logger.js'
import { sendDiscord } from './discord.js'
import { bar, resetCounters } from './usage-meter.js'

// Fire a Discord notification each time the shared account's 7-day usage
// crosses a new BAND_STEP% band (5, 10, 15, … 100). Anthropic returns the
// current utilization on every upstream response, so we just watch the headers.
//
// The 7-day unified window is a rolling window: it can wiggle downward a little
// as old usage ages out. So we only re-notify on UPWARD band crossings, and
// treat a large drop (window reset) as a reset — never spam on small dithers.

// Notification granularity, in percentage points.
const BAND_STEP = 5
// A downward move of at least this many points means the window rolled over.
const RESET_DROP = 20

const GREEN = 0x2ecc71
const ORANGE = 0xe67e22
const RED = 0xe74c3c
const BLUE = 0x3498db

const TZ_OFFSET = -3

function toBRT(iso: string): string {
  const d = new Date(iso)
  d.setUTCHours(d.getUTCHours() + TZ_OFFSET)
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' BRT'
}

const H_7D_UTIL = 'anthropic-ratelimit-unified-7d-utilization'
const H_7D_STATUS = 'anthropic-ratelimit-unified-7d-status'
const H_7D_RESET = 'anthropic-ratelimit-unified-7d-reset'
const H_5H_UTIL = 'anthropic-ratelimit-unified-5h-utilization'

const WARN_BEFORE_MS = 5 * 60 * 1000

let webhookUrl: string | null = null
let statePath: string | null = null
// Highest band we've already notified for. Initialize to 0 to avoid spurious notifications for 0% utilization.
let lastBand = 0
// Reset epoch (seconds) we already sent the 5-min warning for.
let warnedResetEpoch = 0

type State = { band: number; util: number; ts: string }

function loadState(): void {
  if (!statePath) return
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf-8')) as State
    if (typeof s.band === 'number') lastBand = s.band
  } catch {
    // no state yet — start fresh
  }
}

function saveState(util: number): void {
  if (!statePath) return
  try {
    const s: State = { band: lastBand, util, ts: new Date().toISOString() }
    writeFileSync(statePath, JSON.stringify(s), { mode: 0o600 })
  } catch (err) {
    log('warn', `usage-notify: could not persist state: ${err}`)
  }
}

/**
 * Initialize the Discord usage notifier.
 * @param webhook - Discord webhook URL (optional; disables notifier if not provided)
 * @param path - Path to persist notification state (default: usage-notify-state.json)
 * @throws Error if webhook is provided but is not a valid Discord webhook URL
 */
export function initUsageNotify(webhook?: string, path?: string): void {
  webhookUrl = webhook || null
  statePath = path || resolve(process.cwd(), 'usage-notify-state.json')
  if (!webhookUrl) {
    log('info', 'Usage notifier disabled (no notify.discord_webhook in config)')
    return
  }

  // Validate Discord webhook URL format
  try {
    const url = new URL(webhookUrl)
    if (!url.hostname.includes('discord')) {
      throw new Error('hostname is not discord.com')
    }
    if (!url.pathname.includes('/webhooks/')) {
      throw new Error('URL path does not contain /webhooks/')
    }
  } catch (err) {
    throw new Error(`Invalid Discord webhook URL: ${err instanceof Error ? err.message : err}`)
  }

  loadState()
  log('info', `Usage notifier armed (last notified band: ${lastBand >= 0 ? lastBand + '%' : 'none'})`)
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Inspect an upstream response's rate-limit headers and notify Discord if the
 * 7-day usage has crossed into a new 10% band. Safe to call on every response —
 * never throws, and only sends when a band boundary is actually crossed.
 */
export function maybeNotifyUsage(
  headers: Record<string, string | string[] | undefined>,
): void {
  if (!webhookUrl) return

  const raw = header(headers, H_7D_UTIL)
  if (raw === undefined) return
  const util = Number(raw)
  if (!Number.isFinite(util)) return

  const pct = Math.max(0, Math.min(100, util * 100))
  const band = Math.floor(pct / BAND_STEP) * BAND_STEP // 0,5,10,…,100

  // 5-minute warning before window reset — fires once per reset epoch.
  const resetRawEarly = header(headers, H_7D_RESET)
  if (resetRawEarly) {
    const resetEpoch = Number(resetRawEarly)
    const resetMs = resetEpoch * 1000
    const remaining = resetMs - Date.now()
    if (remaining > 0 && remaining <= WARN_BEFORE_MS && warnedResetEpoch !== resetEpoch) {
      warnedResetEpoch = resetEpoch
      const mins = Math.ceil(remaining / 60_000)
      void sendDiscord(webhookUrl!, {
        embeds: [{
          title: '⏰ Janela de 7 dias reseta em ~' + mins + ' min',
          description:
            'Finalize conversas abertas — o uso acumulado zera em breve.\n' +
            `\`${bar(pct / 100, 20)}\` **${pct.toFixed(1)}%** usado nesta janela`,
          color: ORANGE,
          footer: { text: 'aviso automático · 5 min antes do reset' },
          timestamp: new Date().toISOString(),
        }],
      })
      log('info', `usage-notify: sent 5-min reset warning (resets at ${new Date(resetMs).toISOString()})`)
    }
  }

  // Rolling-window reset: a big drop means the window rolled over. Re-arm so
  // future climbs notify again, and send a reset note.
  if (band <= lastBand - RESET_DROP) {
    lastBand = band
    warnedResetEpoch = 0
    saveState(util)
    resetCounters() // re-baseline per-user metering to the new 7-day window
    if (webhookUrl) {
      void sendDiscord(webhookUrl, {
        embeds: [
          {
            title: '🔄 Nova janela de 7 dias',
            description:
              'Janela de 7 dias reiniciada. Contadores zerados.\n' +
              `\`${bar(pct / 100, 20)}\` **${pct.toFixed(1)}%**`,
            color: BLUE,
            footer: {
              text: 'janela de 7 dias da conta compartilhada',
            },
            timestamp: new Date().toISOString(),
          },
        ],
      })
    }
    return
  }

  if (band <= lastBand) return // still inside an already-notified band

  // Crossed one or more upward bands — notify for the new (highest) band.
  lastBand = band // update in-memory first so concurrent requests don't double-fire
  saveState(util)

  const status = header(headers, H_7D_STATUS) || 'unknown'
  const fiveH = header(headers, H_5H_UTIL)
  const resetRaw = header(headers, H_7D_RESET)
  const resetStr = resetRaw
    ? toBRT(new Date(Number(resetRaw) * 1000).toISOString())
    : 'unknown'
  const color = band >= 90 ? RED : band >= 75 ? ORANGE : GREEN
  const herald =
    band >= 90
      ? `🚨 Uso alto — ${band}% consumido`
      : band >= 75
        ? `⚠️ Atenção — ${band}% consumido`
        : `📊 Uso — ${band}% consumido`

  const embed = {
    title: herald,
    description: [
      `\`7d ${bar(pct / 100, 20)}\` **${pct.toFixed(1)}%**`,
      fiveH !== undefined ? `\`5h ${bar(Number(fiveH), 20)}\` ${(Number(fiveH) * 100).toFixed(1)}%` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    color,
    fields: [
      { name: 'status', value: `\`${status}\``, inline: true },
      { name: '⏳ janela reseta em', value: resetStr, inline: true },
    ],
    footer: {
      text: '7d/5h = uso da conta compartilhada nas janelas de 7 dias e 5 horas · detalhes no relatório de uso',
    },
    timestamp: new Date().toISOString(),
  }

  if (webhookUrl) {
    void sendDiscord(webhookUrl, { embeds: [embed] })
    log('info', `usage-notify: sent Discord alert (band ${band}%)`)
  }
}
