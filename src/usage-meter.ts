import type { IncomingMessage } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './logger.js'
import { sendDiscord, type DiscordEmbed } from './discord.js'

// Per-sub-user (per client-token) usage metering. Anthropic's rate-limit
// headers are account-wide for the shared OAuth account, so the only place we
// can attribute usage to an individual client is here, by tapping each
// upstream response and reading its `usage` block.
//
// Counters accumulate over the current 7-day account window; usage-notify calls
// resetCounters() when that window rolls over so per-user totals line up with
// the same window as the account's utilization %.

type Counters = {
  requests: number
  errors: number
  errors4xx: number
  errors5xx: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  // Latency tracking (in milliseconds)
  totalLatencyMs: number
  minLatencyMs: number
  maxLatencyMs: number
  // Size tracking
  totalRequestBytes: number
  totalResponseBytes: number
  // Requests per model id, per tool name, and per UTC hour (24 buckets)
  models: Record<string, number>
  tools: Record<string, number>
  hours: number[]
  // Equivalent API cost in USD (the gateway itself is a subscription — see PRICES)
  costUsd: number
  // Requests whose model has no price entry, so costUsd under-reports them
  unpricedReqs: number
  // Largest single-request context (input + cache) seen
  maxInputTokens: number
}

const emptyCounters = (): Counters => ({
  requests: 0,
  errors: 0,
  errors4xx: 0,
  errors5xx: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalLatencyMs: 0,
  minLatencyMs: Number.MAX_VALUE,
  maxLatencyMs: 0,
  totalRequestBytes: 0,
  totalResponseBytes: 0,
  models: {},
  tools: {},
  hours: new Array(24).fill(0),
  costUsd: 0,
  unpricedReqs: 0,
  maxInputTokens: 0,
})

// Preço equivalente de API, em US$ por milhão de tokens (a conta do gateway é
// assinatura, não pay-per-token — isto é "quanto custaria via API").
// Cache: escrita 1.25× a entrada (TTL 5min), leitura 0.1×.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-fable': { in: 10, out: 50 },
  'claude-mythos': { in: 10, out: 50 },
  'claude-opus': { in: 5, out: 25 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-haiku': { in: 1, out: 5 },
}
const CACHE_WRITE_MULT = 1.25
const CACHE_READ_MULT = 0.1

/** Preço do modelo, ou null se ele não estiver na tabela — nunca chuta valor. */
function priceOf(model: string): { in: number; out: number } | null {
  for (const [prefix, p] of Object.entries(PRICES)) {
    if (model.startsWith(prefix)) return p
  }
  return null
}

const allIn = (c: Counters) => c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens
const total = (c: Counters) => allIn(c) + c.outputTokens

// Foto do placar na virada da janela de 7 dias, pra comparar temporadas.
type Snapshot = { until: string; clients: Record<string, number> }
let previous: Snapshot | null = null

const clients = new Map<string, Counters>()
let since = new Date().toISOString()
let statePath: string | null = null
let webhookUrl: string | null = null
let dirty = false

// Embed caching with TTL (30 seconds)
let cachedSummary: DiscordEmbed | null = null
let cachedSummaryTime = 0
const SUMMARY_CACHE_TTL_MS = 30_000

function get(name: string): Counters {
  let c = clients.get(name)
  if (!c) {
    c = emptyCounters()
    clients.set(name, c)
  }
  return c
}

/**
 * Record an HTTP request for a client, including error count if status >= 400.
 * Tracks error categorization (4xx vs 5xx) for better analytics.
 * @param client - Client name (from auth config)
 * @param status - HTTP response status code
 */
export function recordRequest(client: string, status: number): void {
  const c = get(client)
  c.requests++
  c.hours[new Date().getUTCHours()]++
  if (status >= 400) {
    c.errors++
    if (status >= 500) {
      c.errors5xx++
    } else {
      c.errors4xx++
    }
  }
  dirty = true
}

/**
 * Record performance metrics for a request (latency and sizes).
 * @param client - Client name
 * @param latencyMs - Request latency in milliseconds
 * @param requestBytes - Request body size in bytes
 * @param responseBytes - Response body size in bytes
 */
export function recordMetrics(
  client: string,
  latencyMs: number,
  requestBytes: number,
  responseBytes: number,
): void {
  const c = get(client)
  c.totalLatencyMs += latencyMs
  c.minLatencyMs = Math.min(c.minLatencyMs, latencyMs)
  c.maxLatencyMs = Math.max(c.maxLatencyMs, latencyMs)
  c.totalRequestBytes += requestBytes
  c.totalResponseBytes += responseBytes
  dirty = true
}

type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type Acc = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  // Modelo que de fato atendeu (vem do próprio stream) e ferramentas chamadas.
  model?: string
  tools: Record<string, number>
}

function applyUsage(acc: Acc, u?: UsageLike): void {
  if (!u) return
  if (typeof u.input_tokens === 'number') acc.input += u.input_tokens
  if (typeof u.output_tokens === 'number') acc.output += u.output_tokens
  if (typeof u.cache_read_input_tokens === 'number') acc.cacheRead += u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === 'number') acc.cacheCreate += u.cache_creation_input_tokens
}

function parseSSE(data: string, acc: Acc, clientDebug?: string): void {
  if (!data || data === '[DONE]') return
  let obj: any
  try {
    obj = JSON.parse(data)
  } catch {
    return
  }
  // message_start carries input+cache tokens; message_delta carries the final
  // (authoritative) totals. Overwrite-on-present means the last one wins.
  if (obj?.type === 'content_block_start') {
    // tool_use / server_tool_use carregam o nome da ferramenta chamada.
    const name = obj.content_block?.name
    if (typeof name === 'string' && String(obj.content_block?.type || '').endsWith('tool_use')) {
      // Teto de segurança: nomes de ferramenta são finitos na prática.
      if (Object.keys(acc.tools).length < 50) acc.tools[name] = (acc.tools[name] || 0) + 1
    }
    return
  }
  if (obj?.type === 'message_start') {
    if (typeof obj.message?.model === 'string') acc.model = obj.message.model
    if (obj.message?.usage) {
      applyUsage(acc, obj.message.usage)
    } else if (clientDebug && obj.message) {
      log('debug', `${clientDebug}: message_start has no usage. Fields: ${Object.keys(obj.message || {}).join(', ')}`)
    }
  } else if (obj?.type === 'message_delta') {
    if (obj.usage) {
      applyUsage(acc, obj.usage)
    } else if (clientDebug) {
      log('debug', `${clientDebug}: message_delta has no usage. Fields: ${Object.keys(obj).join(', ')}`)
    }
  } else if (clientDebug && obj.type) {
    // Log first event of each type we see
    log('debug', `${clientDebug}: Unexpected event type '${obj.type}'. Fields: ${Object.keys(obj).join(', ')}`)
  }
}

/**
 * Tap an upstream response to extract and attribute token usage to a client.
 * Non-destructive: only listens to 'data'/'end' events; doesn't affect pipe() to client.
 * Must be called in the same tick as pipe() to avoid missing data.
 * @param client - Client name for usage attribution
 * @param res - Upstream response stream (already being piped to client)
 * @param status - HTTP response status code (optional, used for logging)
 */
export function attachUsage(client: string, res: IncomingMessage, status?: number): void {
  const ct = String(res.headers['content-type'] || '')
  const isSSE = ct.includes('event-stream')
  const acc: Acc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, tools: {} }
  let tail = ''
  let jsonBuf = ''
  const MAX_JSON = 2_000_000
  let eventCount = 0

  res.on('data', (chunk: Buffer) => {
    try {
      const s = chunk.toString('utf8')
      if (isSSE) {
        tail += s
        let nl: number
        while ((nl = tail.indexOf('\n')) >= 0) {
          const line = tail.slice(0, nl).trim()
          tail = tail.slice(nl + 1)
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            eventCount++
            parseSSE(data, acc, client)
          }
        }
        // Safety cap: never let an unterminated line grow unbounded.
        if (tail.length > 65536) tail = tail.slice(-4096)
      } else if (jsonBuf.length < MAX_JSON) {
        jsonBuf += s
      }
    } catch {
      // metering must never disrupt the proxied response
    }
  })

  res.on('end', () => {
    try {
      const statusStr = status ? ` [${status}]` : ''
      if (!isSSE && jsonBuf) {
        try {
          const j = JSON.parse(jsonBuf) as { usage?: UsageLike; model?: string }
          if (typeof j.model === 'string') acc.model = j.model
          if (j.usage) {
            log('debug', `${client}: Non-SSE response${statusStr} contains usage: in=${j.usage.input_tokens} out=${j.usage.output_tokens}`)
            applyUsage(acc, j.usage)
          } else {
            log('debug', `${client}: Non-SSE response${statusStr} has no usage field. Body keys: ${Object.keys(j).join(', ')}`)
          }
        } catch (parseErr) {
          log('warn', `${client}: Failed to parse non-SSE body: ${parseErr}`)
        }
      } else if (isSSE) {
        if (eventCount === 0) {
          log('warn', `${client}: SSE response${statusStr} received but no events parsed!`)
        } else {
          log('debug', `${client}: SSE response${statusStr} processed ${eventCount} events. Usage: in=${acc.input} out=${acc.output}`)
        }
      }
      // Always record usage values found, even if they're all 0.
      // Upstream API may legitimately return 0 tokens for some requests.
      const c = get(client)
      c.inputTokens += acc.input
      c.outputTokens += acc.output
      c.cacheReadTokens += acc.cacheRead
      c.cacheCreationTokens += acc.cacheCreate
      c.maxInputTokens = Math.max(c.maxInputTokens, acc.input + acc.cacheRead + acc.cacheCreate)
      for (const [name, n] of Object.entries(acc.tools)) c.tools[name] = (c.tools[name] || 0) + n
      if (acc.model) {
        c.models[acc.model] = (c.models[acc.model] || 0) + 1
        const p = priceOf(acc.model)
        if (p) {
          c.costUsd +=
            (acc.input * p.in +
              acc.cacheCreate * p.in * CACHE_WRITE_MULT +
              acc.cacheRead * p.in * CACHE_READ_MULT +
              acc.output * p.out) /
            1_000_000
        } else {
          // Sem preço conhecido: conta o furo em vez de inventar um valor.
          c.unpricedReqs++
        }
      }
      dirty = true
    } catch (err) {
      log('warn', `${client}: Usage parsing failed: ${err}`)
    }
  })

  res.on('error', () => {})
}

function load(): void {
  if (!statePath) return
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      since?: string
      previous?: Snapshot
      clients?: Record<string, Partial<Counters>>
    }
    if (s.since) since = s.since
    if (s.previous?.clients) previous = s.previous
    if (s.clients) {
      for (const [k, v] of Object.entries(s.clients)) {
        clients.set(k, { ...emptyCounters(), ...v })
      }
    }
  } catch {
    // no prior state
  }
}

function persist(): void {
  if (!statePath || !dirty) return
  try {
    const obj = {
      since,
      updated: new Date().toISOString(),
      previous,
      clients: Object.fromEntries(clients),
    }
    writeFileSync(statePath, JSON.stringify(obj, null, 2), { mode: 0o600 })
    dirty = false
    cachedSummary = null // Invalidate cache when state changes
  } catch (err) {
    log('warn', `usage-meter: persist failed: ${err}`)
  }
}

/**
 * Reset all per-user usage counters. Called when the 7-day account window rolls over.
 * Updates the usage start time and persists state to disk.
 */
export function resetCounters(): void {
  if (clients.size) {
    previous = {
      until: new Date().toISOString(),
      clients: Object.fromEntries([...clients].map(([n, c]) => [n, total(c)])),
    }
  }
  clients.clear()
  since = new Date().toISOString()
  dirty = true
  persist()
  log('info', 'usage-meter: per-user counters reset (new 7-day window)')
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// Eighth-block partials so short bars still show something.
const EIGHTHS = '▏▎▍▌▋▊▉█'

/**
 * Render a horizontal bar for Discord. Monospace only — callers must wrap it in
 * a code block (or backticks) or Discord's proportional font will misalign it.
 * @param frac - 0..1 fill ratio (clamped)
 * @param width - bar width in characters
 */
export function bar(frac: number, width = 18): string {
  const units = Math.max(0, Math.min(1, frac || 0)) * width * 8
  const full = Math.floor(units / 8)
  const rest = Math.round(units % 8)
  return ('█'.repeat(full) + (rest ? EIGHTHS[rest - 1] : '')).padEnd(width, '·')
}

// Dourado do trono.
const GOLD = 0xf1c40f

const SPARK = '▁▂▃▄▅▆▇█'
// Fuso do reino: America/Sao_Paulo (sem horário de verão desde 2019).
const TZ_OFFSET = -3

/** Buckets UTC → buckets locais, index 0 = 00h local. */
function toLocalHours(utc: number[]): number[] {
  return Array.from({ length: 24 }, (_, h) => utc[(h - TZ_OFFSET + 24) % 24] || 0)
}

/** Sparkline de 24 caracteres — monospace, precisa ir dentro de crase. */
function sparkline(buckets: number[]): string {
  const max = Math.max(...buckets, 1)
  return buckets.map((n) => (n ? SPARK[Math.min(7, Math.floor((n / max) * 7.999))] : '·')).join('')
}

/** ms → "4m47s" / "38s". */
function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** ms → "16h20" / "45min". */
function hrs(ms: number): string {
  const min = Math.round(ms / 60000)
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}min`
}

/** Top-N entradas de um contador {chave: quantidade}. */
function topN(counts: Record<string, number>, n: number): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

// Tema medieval: coroa pro trono, insígnias pra corte, enxada pro resto.
const RANK = ['👑', '🗡️', '🛡️', '🏹']
const PEASANT = '🌾'

/**
 * Build the per-user usage leaderboard as a Discord embed: a ranked bar chart of
 * token burn (crown for the top spender) plus joke awards, all derived from the
 * existing counters. The board goes in a code block — Discord's proportional
 * font would otherwise shred the alignment.
 * Results are cached for 30 seconds to avoid recalculation on frequent calls.
 * @returns Discord embed with per-client and total usage
 */
export function summaryEmbed(): DiscordEmbed {
  const now = Date.now()
  // Return cached summary if still fresh
  if (cachedSummary && now - cachedSummaryTime < SUMMARY_CACHE_TTL_MS) {
    return cachedSummary
  }

  const rows = [...clients.entries()].sort((a, b) => total(b[1]) - total(a[1]))
  const sinceStr = since.slice(0, 16).replace('T', ' ') + ' UTC'
  const cache = (e: DiscordEmbed): DiscordEmbed => {
    cachedSummary = {
      ...e,
      title: '⚔️ Game of Tokens',
      color: GOLD,
      timestamp: new Date(now).toISOString(),
    }
    cachedSummaryTime = now
    return cachedSummary
  }
  if (!rows.length) {
    return cache({
      description: `O trono está vazio: nenhum lorde queimou um token desde ${sinceStr}. Suspeito.`,
    })
  }

  const sum = (f: (c: Counters) => number) => rows.reduce((s, [, c]) => s + f(c), 0)
  const grand = sum(total)
  const top = total(rows[0][1]) || 1
  const nameW = Math.max(...rows.map(([n]) => Math.min(12, n.length)))
  const tReq = sum((c) => c.requests)
  const tErr4xx = sum((c) => c.errors4xx)
  const tErr5xx = sum((c) => c.errors5xx)

  const board = rows.map(([name, c], i) =>
    [
      RANK[i] || PEASANT,
      name.slice(0, nameW).padEnd(nameW),
      bar(total(c) / top),
      fmt(total(c)).padStart(6),
      `${((total(c) / (grand || 1)) * 100).toFixed(0).padStart(3)}%`,
      c.errors ? `💥${c.errors}` : '',
    ]
      .join(' ')
      .trimEnd(),
  )

  // Joke awards — same counters, no extra bookkeeping.
  const best = (score: (c: Counters) => number) =>
    rows.reduce((a, b) => (score(b[1]) > score(a[1]) ? b : a))
  const [chatty, chattyC] = best((c) => c.outputTokens)
  const [crasher, crasherC] = best((c) => c.errors)
  const [slow, slowC] = best((c) => c.maxLatencyMs)
  const awards: NonNullable<DiscordEmbed['fields']> = []
  if (chattyC.outputTokens) {
    awards.push({
      name: '📤 Mais tokens gerados',
      value: `${chatty}\n${fmt(chattyC.outputTokens)} tokens`,
      inline: true,
    })
  }
  if (crasherC.errors) {
    awards.push({
      name: '💥 Mais erros',
      value: `${crasher}\n${crasherC.errors} reqs`,
      inline: true,
    })
  }
  if (slowC.maxLatencyMs) {
    awards.push({
      name: '⏳ Requisição mais demorada',
      value: `${slow}\n${dur(slowC.maxLatencyMs)}`,
      inline: true,
    })
  }

  // Custo por cliente: diverge do placar de tokens quando os modelos diferem.
  const [priciest, priciestC] = best((c) => c.costUsd)
  if (priciestC.costUsd > 0) {
    awards.push({
      name: '💸 Mais caro',
      value: `${priciest}\nUS$ ${priciestC.costUsd.toFixed(2)}`,
      inline: true,
    })
  }

  // Contexto: maior requisição única já vista no reino.
  const [ctxLord, ctxLordC] = best((c) => c.maxInputTokens)
  if (ctxLordC.maxInputTokens) {
    awards.push({
      name: '📚 Maior contexto',
      value: `${ctxLord}\n${fmt(ctxLordC.maxInputTokens)} tokens`,
      inline: true,
    })
  }

  // Horas de Claude Code: latência somada = tempo de modelo rodando pra esse lorde.
  const [busiest, busiestC] = best((c) => c.totalLatencyMs)
  if (busiestC.totalLatencyMs) {
    awards.push({
      name: '🕯️ Mais horas de Claude Code',
      value: `${busiest}\n${hrs(busiestC.totalLatencyMs)}`,
      inline: true,
    })
  }

  // Temporada anterior: variação por lorde e do reino (só existe após o 1º reset).
  const pct = (now: number, before: number) => ((now - before) / before) * 100
  const arrow = (d: number) => `${d >= 0 ? '▲' : '▼'}${Math.abs(d).toFixed(0)}%`
  const deltaLine = previous
    ? rows
        .map(([name, c]) => {
          const before = previous!.clients[name]
          return before ? `${name} ${arrow(pct(total(c), before))}` : `${name} 🆕`
        })
        .join(' · ')
    : ''
  const prevGrand = previous
    ? Object.values(previous.clients).reduce((a, b) => a + b, 0)
    : 0

  // Agregados do reino: custo, modelos, ferramentas, ritmo por hora.
  const merge = (pick: (c: Counters) => Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const [, c] of rows) {
      for (const [k, n] of Object.entries(pick(c) || {})) out[k] = (out[k] || 0) + n
    }
    return out
  }
  // Agrupa por família (claude-opus-4-8 → opus); ninguém quer ler o id inteiro.
  const family = (m: string) => m.replace(/^claude-/, '').split('-')[0]
  const models = merge((c) => c.models)
  const modelReqs = Object.values(models).reduce((s, n) => s + n, 0)
  const byFamily: Record<string, number> = {}
  for (const [m, n] of Object.entries(models)) byFamily[family(m)] = (byFamily[family(m)] || 0) + n
  const modelLine = topN(byFamily, 4)
    .map(([f, n]) => `${f} ${((n / (modelReqs || 1)) * 100).toFixed(0)}%`)
    .join(' · ')

  const tools = merge((c) => c.tools)
  const toolLine = topN(tools, 5)
    .map(([t, n]) => `${t} ${fmt(n)}`)
    .join(' · ')

  const kingdomIn = sum(allIn)
  const cost = sum((c) => c.costUsd)
  const unpriced = sum((c) => c.unpricedReqs)
  const kingdomHours = toLocalHours(
    Array.from({ length: 24 }, (_, h) => sum((c) => c.hours?.[h] || 0)),
  )
  const peak = kingdomHours.indexOf(Math.max(...kingdomHours))

  return cache({
    description: [
      `👑 **${rows[0][0]}** reina com **${fmt(top)}** tokens queimados.`,
      '```',
      ...board,
      '```',
    ].join('\n'),
    fields: [
      {
        name: '🏰 O reino inteiro',
        value: [
          `**${fmt(grand)} tokens** em ${tReq} reqs` +
            (tErr4xx + tErr5xx ? ` · ${tErr4xx}×4xx ${tErr5xx}×5xx` : '') +
            ` · ${(sum((c) => c.totalLatencyMs) / (tReq || 1) / 1000).toFixed(1)}s de média`,
          [
            cost || unpriced
              ? `💰 US$ ${cost.toFixed(2)}` + (unpriced ? ` (${unpriced} reqs sem preço)` : '')
              : null,
            // Média do reino, ponderada por token — não é a média das médias.
            kingdomIn ? `🧠 ${((sum((c) => c.cacheReadTokens) / kingdomIn) * 100).toFixed(0)}% de cache` : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
          [`🕯️ ${hrs(sum((c) => c.totalLatencyMs))} de Claude Code`, modelLine ? `🤖 ${modelLine}` : null]
            .filter(Boolean)
            .join(' · '),
          prevGrand ? `📈 ${arrow(pct(grand, prevGrand))} vs a janela anterior` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      // Só aparecem quando já há dado — placar recém-zerado não mostra campo vazio.
      ...(kingdomHours.some(Boolean)
        ? [
            {
              name: '🕰️ Ritmo do reino (hora local)',
              value: `\`00h ${sparkline(kingdomHours)} 23h\`\npico às ${String(peak).padStart(2, '0')}h`,
            },
          ]
        : []),
      ...(toolLine ? [{ name: '🔧 Ferramentas mais empunhadas', value: toolLine }] : []),
      ...(deltaLine
        ? [
            {
              name: `📈 Contra a janela anterior (até ${previous!.until.slice(5, 10).split('-').reverse().join('/')})`,
              value: deltaLine,
            },
          ]
        : []),
      ...awards,
    ],
    footer: { text: `desde ${sinceStr}` },
  })
}

/**
 * Post the usage summary to Discord via webhook.
 * Called by scheduled interval or on-demand (SIGUSR1 signal).
 * @throws Never throws; failures are logged and silently ignored
 */
export async function postReport(): Promise<void> {
  if (!webhookUrl) return
  await sendDiscord(webhookUrl, { embeds: [summaryEmbed()] })
  log('info', 'usage-meter: posted per-user report to Discord')
}

/**
 * Initialize the usage meter system. Sets up state persistence and Discord reporting.
 * @param opts.webhook - Optional Discord webhook URL for scheduled reports
 * @param opts.statePath - Path to persist usage state (default: usage-meter-state.json in cwd)
 * @param opts.reportIntervalHours - How often to post reports to Discord (0 = disabled)
 */
export function initUsageMeter(opts: {
  webhook?: string
  statePath?: string
  reportIntervalHours?: number
}): void {
  webhookUrl = opts.webhook || null
  statePath = opts.statePath || resolve(process.cwd(), 'usage-meter-state.json')
  load()

  const persistTimer = setInterval(persist, 30_000)
  persistTimer.unref?.()

  const hrs = opts.reportIntervalHours ?? 0
  if (webhookUrl && hrs > 0) {
    const reportTimer = setInterval(() => void postReport(), hrs * 3_600_000)
    reportTimer.unref?.()
    log('info', `Usage meter armed: per-user report every ${hrs}h to Discord`)
  } else {
    log('info', 'Usage meter armed: metering on (no scheduled Discord report)')
  }
}
