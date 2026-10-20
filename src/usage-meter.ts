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
  // Maior banda de contexto já alertada neste cliente (0 = nenhuma). Só sobe,
  // pra não repetir o alerta enquanto o cliente ficar parado na mesma banda.
  ctxBandAlerted: number
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
  ctxBandAlerted: 0,
})

// Alerta de contexto por request. O custo de uma conversa cresce com o QUADRADO
// dos turnos, porque todo turno reenvia o histórico inteiro — medido em 192
// sessões: uma de 2747 turnos custou 1,85B tokens de entrada, e a mesma conversa
// reiniciada a cada 300 turnos custaria 205M.
//
// O gateway não vê sessão (a API é stateless, não há session_id na request), mas
// vê o SINTOMA com exatidão: o tamanho do contexto desta request. Ele não pode
// consertar — recusar não divide a sessão, entijola ela — então isto avisa e não
// bloqueia. O remédio (/clear) só existe do lado do cliente.
const CTX_BANDS = [500_000, 700_000, 900_000]
const CTX_RED = 900_000

/** Avisa quando UMA request cruza uma banda de contexto nova. Nunca bloqueia. */
function maybeAlertContext(name: string, c: Counters, ctx: number): void {
  if (!webhookUrl) return
  // Maior banda cruzada; só alerta se for acima da última já alertada, senão um
  // cliente parado em 900k dispararia o alerta em toda request.
  let band = 0
  for (const b of CTX_BANDS) if (ctx >= b) band = b
  if (!band || band <= c.ctxBandAlerted) return
  c.ctxBandAlerted = band
  dirty = true
  void sendDiscord(webhookUrl, {
    embeds: [
      {
        title: band >= CTX_RED ? '🚨 Contexto quase na janela' : '📈 Contexto grande numa request',
        description:
          `**${name}** mandou uma request de **${fmt(ctx)} tokens** de entrada.\n` +
          'Todo turno reenvia o histórico inteiro, então o custo cresce com o ' +
          '**quadrado dos turnos**. Se for tarefa nova, `/clear` antes do próximo ' +
          'pedido; se for o mesmo trabalho, ignore.',
        color: band >= CTX_RED ? 0xe74c3c : 0xe67e22,
        footer: { text: `banda de ${fmt(band)} · o gateway avisa, não bloqueia` },
        timestamp: new Date().toISOString(),
      },
    ],
  })
  log('info', `usage-meter: alerted ${name} at context band ${band}`)
}

// Preço equivalente de API, em US$ por milhão de tokens (a conta do gateway é
// assinatura, não pay-per-token — isto é "quanto custaria via API").
// Fonte: platform.claude.com/docs/en/about-claude/pricing, conferida 2026-10-18
// contra o `costUSD` que o próprio Claude Code calcula (tests/pricing.test.ts).
// `read` = multiplicador do cache lido sobre `in`: muda por modelo (0.1× padrão,
// 0.05× Opus/Sonnet 5.5, 0.025× Fable/Mythos 5.1). Escrita de cache é igual em
// todo modelo: 1.25× com TTL 5min, 2× com TTL 1h.
// ⚠️ Ordem importa: o primeiro prefixo que casa vence, então o mais específico
// vem antes ('claude-opus-5-5' antes de 'claude-opus-5').
type Price = {
  in: number
  out: number
  read: number
  fast?: { in: number; out: number } // usage.speed === 'fast'
  over100k?: { in: number; out: number } // prompt (in + cache) > 100k tokens
}
const PRICES: [string, Price][] = [
  ['claude-fable-5-1', { in: 10, out: 50, read: 0.025 }],
  ['claude-mythos-5-1', { in: 10, out: 50, read: 0.025 }],
  ['claude-fable-5', { in: 10, out: 50, read: 0.1 }],
  ['claude-mythos-5', { in: 10, out: 50, read: 0.1 }],
  ['claude-opus-5-5', { in: 4, out: 20, read: 0.05, fast: { in: 8, out: 40 } }],
  ['claude-opus-5', { in: 5, out: 25, read: 0.1, fast: { in: 10, out: 50 } }],
  ['claude-opus-4-8', { in: 5, out: 25, read: 0.1, fast: { in: 10, out: 50 } }],
  ['claude-opus-4-7', { in: 5, out: 25, read: 0.1 }],
  ['claude-opus-4-6', { in: 5, out: 25, read: 0.1 }],
  ['claude-opus-4-5', { in: 5, out: 25, read: 0.1 }],
  ['claude-opus-4', { in: 15, out: 75, read: 0.1 }], // 4 e 4.1
  ['claude-sonnet-5-5', { in: 2, out: 10, read: 0.05 }],
  ['claude-sonnet-5', { in: 2, out: 10, read: 0.1 }],
  ['claude-sonnet-4', { in: 3, out: 15, read: 0.1 }], // 4, 4.5, 4.6
  ['claude-haiku-5-5', { in: 0.1, out: 0.5, read: 0.1, over100k: { in: 0.5, out: 2.5 } }],
  ['claude-haiku-4-5', { in: 1, out: 5, read: 0.1 }],
]
const CACHE_WRITE_5M_MULT = 1.25
const CACHE_WRITE_1H_MULT = 2

/** Preço do modelo, ou null se ele não estiver na tabela — nunca chuta valor. */
function priceOf(model: string): Price | null {
  for (const [prefix, p] of PRICES) {
    if (model.startsWith(prefix)) return p
  }
  return null
}

/**
 * Custo em US$ de UMA resposta, ou null se o modelo não tem preço.
 * ponytail: ignora inference_geo "us" (1.1×) e server tools (web search) —
 * o Claude Code via gateway manda geo global e não usa web search pago aqui.
 */
export function costOf(acc: {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cacheCreate1h: number
  speed?: string
}): number | null {
  const p = acc.model ? priceOf(acc.model) : null
  if (!p) return null
  const prompt = acc.input + acc.cacheRead + acc.cacheCreate
  const base =
    acc.speed === 'fast' && p.fast ? p.fast : prompt > 100_000 && p.over100k ? p.over100k : p
  // Sem o detalhamento por TTL, a escrita conta como 5min — o padrão da API.
  const w1h = Math.min(acc.cacheCreate1h, acc.cacheCreate)
  const w5m = acc.cacheCreate - w1h
  return (
    (acc.input * base.in +
      w5m * base.in * CACHE_WRITE_5M_MULT +
      w1h * base.in * CACHE_WRITE_1H_MULT +
      acc.cacheRead * base.in * p.read +
      acc.output * base.out) /
    1_000_000
  )
}

const allIn = (c: Counters) => c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens
const total = (c: Counters) => allIn(c) + c.outputTokens

// Tokens por chamada. Separa "faço mais chamadas" de "cada chamada minha é mais
// pesada" — sem isso o total sozinho não diz qual dos dois é o consumo alto.
// Derivado dos contadores que já existem: nada novo pra persistir.
//
// ⚠️ O denominador NÃO é `c.requests`. Aquilo conta toda request proxiada,
// inclusive /v1/messages/count_tokens — que o Claude Code chama direto e que
// responde sem bloco `usage`. Cada uma soma +1 chamada e 0 token, então dividir
// por `requests` faz quem chama mais count_tokens parecer MAIS leve por chamada.
// `models` só é incrementado quando a resposta trouxe um modelo, o que só
// acontece em inferência de verdade — é esse o denominador honesto.
const inferenceReqs = (c: Counters) => Object.values(c.models || {}).reduce((s, n) => s + n, 0)

/** Média por chamada, ou null quando não há inferência medida (nunca chuta). */
const per = (n: number, c: Counters) => {
  const reqs = inferenceReqs(c)
  return reqs ? n / reqs : null
}
const perReq = (c: Counters) => per(total(c), c)

// Média com pouquíssimas chamadas é ruído — um cliente com 1 request levaria o
// destaque de "mais pesado". Abaixo disso ele não concorre.
const MIN_REQS_FOR_RATE = 20

// Snapshot na virada da janela de 7 dias, pra comparar com a anterior.
type Snapshot = { until: string; clients: Record<string, number> }
let previous: Snapshot | null = null

const clients = new Map<string, Counters>()
let since = new Date().toISOString()
let statePath: string | null = null
let webhookUrl: string | null = null
let dirty = false

// Embed caching with TTL (30 seconds)
let cachedEmbeds: DiscordEmbed[] | null = null
let cachedEmbedsTime = 0
const SUMMARY_CACHE_TTL_MS = 30_000

const ACCENT = 0x3498db

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
  // Mesma escrita, separada por TTL — a de 1h custa 2× a entrada, a de 5min 1.25×.
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

type Acc = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cacheCreate1h: number
  speed?: string
  // Modelo que de fato atendeu (vem do próprio stream) e ferramentas chamadas.
  model?: string
  tools: Record<string, number>
}

function applyUsage(acc: Acc, u?: UsageLike): void {
  if (!u) return
  // Assign, not add — message_delta carries authoritative totals that supersede message_start.
  if (typeof u.input_tokens === 'number') acc.input = u.input_tokens
  if (typeof u.output_tokens === 'number') acc.output = u.output_tokens
  if (typeof u.cache_read_input_tokens === 'number') acc.cacheRead = u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === 'number') acc.cacheCreate = u.cache_creation_input_tokens
  if (typeof u.cache_creation?.ephemeral_1h_input_tokens === 'number')
    acc.cacheCreate1h = u.cache_creation.ephemeral_1h_input_tokens
  if (typeof u.speed === 'string') acc.speed = u.speed
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
  const acc: Acc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, tools: {} }
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
      const ctx = acc.input + acc.cacheRead + acc.cacheCreate
      c.maxInputTokens = Math.max(c.maxInputTokens, ctx)
      maybeAlertContext(client, c, ctx)
      for (const [name, n] of Object.entries(acc.tools)) c.tools[name] = (c.tools[name] || 0) + n
      if (acc.model) {
        c.models[acc.model] = (c.models[acc.model] || 0) + 1
        const usd = costOf(acc)
        if (usd !== null) {
          c.costUsd += usd
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
    cachedEmbeds = null
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
  return String(Math.round(n))
}

/** Média por chamada; `—` quando não há inferência medida — nunca inventa 0. */
function fmtPer(n: number | null): string {
  return n === null ? '—' : fmt(n)
}

// Custo por chamada. Vale mais que tok/chamada pra "quem queima a cota": o
// costUsd já aplica os multiplicadores de cache por modelo e TTL (ver costOf),
// então 1M de tokens relidos de cache NÃO pesa o mesmo que 1M de tokens novos.
function usdPer(c: Counters): string {
  const u = per(c.costUsd, c)
  if (u === null || !c.costUsd) return 'US$ —'
  return `US$ ${u < 0.01 ? u.toFixed(4) : u.toFixed(3)}`
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

const SPARK = '▁▂▃▄▅▆▇█'
const TZ_OFFSET = -3

function toBRT(iso: string): string {
  const d = new Date(iso)
  d.setUTCHours(d.getUTCHours() + TZ_OFFSET)
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' BRT'
}

/** Buckets UTC → buckets locais, index 0 = 00h local. */
function toLocalHours(utc: number[]): number[] {
  return Array.from({ length: 24 }, (_, h) => utc[(h - TZ_OFFSET + 24) % 24] || 0)
}

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

// Agrupa por família (claude-opus-4-8 → opus); ninguém quer ler o id inteiro.
const family = (m: string) => m.replace(/^claude-/, '').split('-')[0]

function modelSummary(models: Record<string, number>): string {
  const modelReqs = Object.values(models).reduce((s, n) => s + n, 0)
  if (!modelReqs) return ''
  const byFamily: Record<string, number> = {}
  for (const [m, n] of Object.entries(models)) byFamily[family(m)] = (byFamily[family(m)] || 0) + n
  return topN(byFamily, 4)
    .map(([f, n]) => `${f} ${((n / modelReqs) * 100).toFixed(0)}%`)
    .join(' · ')
}

/** Per-user detail embed. */
function userEmbed(name: string, c: Counters, rank: number): DiscordEmbed {
  const localHours = toLocalHours(c.hours || new Array(24).fill(0))
  const peak = localHours.indexOf(Math.max(...localHours))
  const avgLatency = c.requests ? (c.totalLatencyMs / c.requests / 1000).toFixed(1) : '—'
  const cacheRate = allIn(c) ? ((c.cacheReadTokens / allIn(c)) * 100).toFixed(0) : '0'

  const fields: NonNullable<DiscordEmbed['fields']> = []

  // Tokens
  fields.push({
    name: '🔢 Tokens',
    value: [
      `**${fmt(total(c))}** total (${fmt(c.requests)} reqs, ${fmt(inferenceReqs(c))} de inferência)`,
      `⚖️ por chamada: **${fmtPer(perReq(c))}** tok · ${usdPer(c)}`,
      `   ↳ entrada nova ${fmtPer(per(c.inputTokens, c))} · cache lido ${fmtPer(per(c.cacheReadTokens, c))} · saída ${fmtPer(per(c.outputTokens, c))}`,
      `📥 entrada: ${fmt(c.inputTokens)} · 📤 saída: ${fmt(c.outputTokens)}`,
      `📖 cache lido: ${fmt(c.cacheReadTokens)} · ✏️ cache criado: ${fmt(c.cacheCreationTokens)}`,
      `🧠 ${cacheRate}% cache · 📚 maior contexto: ${fmt(c.maxInputTokens)}`,
    ].join('\n'),
  })

  // Models
  const ml = modelSummary(c.models)
  if (ml) {
    fields.push({ name: '🤖 Modelos', value: ml, inline: true })
  }

  // Cost
  if (c.costUsd > 0) {
    fields.push({
      name: '💰 Custo equivalente',
      value: `US$ ${c.costUsd.toFixed(2)}` + (c.unpricedReqs ? ` (${c.unpricedReqs} sem preço)` : ''),
      inline: true,
    })
  }

  // Latency
  if (c.requests) {
    fields.push({
      name: '⏱️ Latência',
      value: `média ${avgLatency}s · mín ${dur(c.minLatencyMs === Number.MAX_VALUE ? 0 : c.minLatencyMs)} · máx ${dur(c.maxLatencyMs)}`,
      inline: true,
    })
  }

  // Time on Claude Code
  if (c.totalLatencyMs) {
    fields.push({
      name: '⏱️ Tempo de Claude Code',
      value: hrs(c.totalLatencyMs),
      inline: true,
    })
  }

  // Errors
  if (c.errors) {
    fields.push({
      name: '💥 Erros',
      value: `${c.errors} total · ${c.errors4xx}×4xx ${c.errors5xx}×5xx`,
      inline: true,
    })
  }

  // Activity sparkline
  if (localHours.some(Boolean)) {
    fields.push({
      name: '📊 Atividade por hora (BRT -03)',
      value: `\`00h ${sparkline(localHours)} 23h\`\npico às ${String(peak).padStart(2, '0')}h`,
    })
  }

  // Top tools
  const tl = topN(c.tools, 5)
  if (tl.length) {
    fields.push({
      name: '🔧 Ferramentas mais usadas',
      value: tl.map(([t, n]) => `${t} ${fmt(n)}`).join(' · '),
    })
  }

  return {
    title: `${rank}. ${name}`,
    color: ACCENT,
    fields,
  }
}

/**
 * Build the group summary embed + per-user embeds.
 */
export function summaryEmbed(): DiscordEmbed {
  const embeds = allEmbeds()
  return embeds[0]
}

function allEmbeds(): DiscordEmbed[] {
  const now = Date.now()
  if (cachedEmbeds && now - cachedEmbedsTime < SUMMARY_CACHE_TTL_MS) {
    return cachedEmbeds
  }

  const rows = [...clients.entries()].sort((a, b) => total(b[1]) - total(a[1]))
  const sinceStr = toBRT(since)

  const cache = (embeds: DiscordEmbed[]): DiscordEmbed[] => {
    cachedEmbeds = embeds
    cachedEmbedsTime = now
    return cachedEmbeds
  }

  if (!rows.length) {
    return cache([{
      title: '📊 Relatório de uso',
      description: `Nenhum uso registrado desde ${sinceStr}.`,
      color: ACCENT,
      timestamp: new Date(now).toISOString(),
    }])
  }

  const sum = (f: (c: Counters) => number) => rows.reduce((s, [, c]) => s + f(c), 0)
  const grand = sum(total)
  const top = total(rows[0][1]) || 1
  const nameW = Math.max(...rows.map(([n]) => Math.min(12, n.length)))
  const tReq = sum((c) => c.requests)
  const tInf = sum(inferenceReqs)
  const tErr4xx = sum((c) => c.errors4xx)
  const tErr5xx = sum((c) => c.errors5xx)

  const board = rows.map(([name, c], i) =>
    [
      `${i + 1}.`,
      name.slice(0, nameW).padEnd(nameW),
      // Barra encolhida de 18 pra 12: abre espaço pra coluna nova sem alongar a
      // linha, que quebra feio no code block do Discord mobile.
      bar(total(c) / top, 12),
      fmt(total(c)).padStart(6),
      `${((total(c) / (grand || 1)) * 100).toFixed(0).padStart(3)}%`,
      fmtPer(perReq(c)).padStart(6),
      c.errors ? `💥${c.errors}` : '',
    ]
      .join(' ')
      .trimEnd(),
  )

  // Destaques — mesmos contadores, sem bookkeeping extra.
  const best = (score: (c: Counters) => number) =>
    rows.reduce((a, b) => (score(b[1]) > score(a[1]) ? b : a))
  const [chatty, chattyC] = best((c) => c.outputTokens)
  const [crasher, crasherC] = best((c) => c.errors)
  const [slow, slowC] = best((c) => c.maxLatencyMs)
  const highlights: NonNullable<DiscordEmbed['fields']> = []
  if (chattyC.outputTokens) {
    highlights.push({
      name: '📤 Mais tokens gerados',
      value: `${chatty}\n${fmt(chattyC.outputTokens)} tokens`,
      inline: true,
    })
  }
  if (crasherC.errors) {
    highlights.push({
      name: '💥 Mais erros',
      value: `${crasher}\n${crasherC.errors} reqs`,
      inline: true,
    })
  }
  if (slowC.maxLatencyMs) {
    highlights.push({
      name: '⏳ Requisição mais lenta',
      value: `${slow}\n${dur(slowC.maxLatencyMs)}`,
      inline: true,
    })
  }

  const [priciest, priciestC] = best((c) => c.costUsd)
  if (priciestC.costUsd > 0) {
    highlights.push({
      name: '💸 Mais caro',
      value: `${priciest}\nUS$ ${priciestC.costUsd.toFixed(2)}`,
      inline: true,
    })
  }

  const [ctxUser, ctxUserC] = best((c) => c.maxInputTokens)
  if (ctxUserC.maxInputTokens) {
    highlights.push({
      name: '📚 Maior contexto',
      value: `${ctxUser}\n${fmt(ctxUserC.maxInputTokens)} tokens`,
      inline: true,
    })
  }

  // Não dá pra reusar best(): ele varre TODAS as linhas, e uma média sobre
  // poucas chamadas é ruído — quem fez 1 request levaria o destaque.
  const rated = rows.filter(([, c]) => inferenceReqs(c) >= MIN_REQS_FOR_RATE)
  if (rated.length) {
    const [heavy, heavyC] = rated.reduce((a, b) => ((perReq(b[1]) ?? 0) > (perReq(a[1]) ?? 0) ? b : a))
    highlights.push({
      name: '⚖️ Mais pesado por chamada',
      value: `${heavy}\n${fmtPer(perReq(heavyC))} tok · ${usdPer(heavyC)}`,
      inline: true,
    })
  }

  const [busiest, busiestC] = best((c) => c.totalLatencyMs)
  if (busiestC.totalLatencyMs) {
    highlights.push({
      name: '⏱️ Mais tempo de Claude Code',
      value: `${busiest}\n${hrs(busiestC.totalLatencyMs)}`,
      inline: true,
    })
  }

  // Janela anterior: variação por usuário.
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

  // Agregados globais: custo, modelos, ferramentas, ritmo por hora.
  const merge = (pick: (c: Counters) => Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const [, c] of rows) {
      for (const [k, n] of Object.entries(pick(c) || {})) out[k] = (out[k] || 0) + n
    }
    return out
  }
  const models = merge((c) => c.models)
  const modelLine = modelSummary(models)

  const tools = merge((c) => c.tools)
  const toolLine = topN(tools, 5)
    .map(([t, n]) => `${t} ${fmt(n)}`)
    .join(' · ')

  const totalIn = sum(allIn)
  const cost = sum((c) => c.costUsd)
  const unpriced = sum((c) => c.unpricedReqs)
  const globalHours = toLocalHours(
    Array.from({ length: 24 }, (_, h) => sum((c) => c.hours?.[h] || 0)),
  )
  const peak = globalHours.indexOf(Math.max(...globalHours))

  const groupEmbed: DiscordEmbed = {
    title: '📊 Relatório de uso',
    color: ACCENT,
    timestamp: new Date(now).toISOString(),
    description: [
      `**${rows[0][0]}** lidera com **${fmt(top)}** tokens.`,
      '```',
      ...board,
      '```',
    ].join('\n'),
    fields: [
      {
        name: '📊 Total geral',
        value: [
          `**${fmt(grand)} tokens** em ${tReq} reqs` +
            (tErr4xx + tErr5xx ? ` · ${tErr4xx}×4xx ${tErr5xx}×5xx` : '') +
            ` · ${(sum((c) => c.totalLatencyMs) / (tReq || 1) / 1000).toFixed(1)}s média`,
          tInf
            ? `⚖️ **${fmt(grand / tInf)}** tokens por chamada · ${tInf} chamadas de inferência` +
              ` (${tReq - tInf} sem tokens, ex. count_tokens)`
            : null,
          [
            cost || unpriced
              ? `💰 US$ ${cost.toFixed(2)}` + (unpriced ? ` (${unpriced} reqs sem preço)` : '')
              : null,
            totalIn ? `🧠 ${((sum((c) => c.cacheReadTokens) / totalIn) * 100).toFixed(0)}% cache` : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
          [`⏱️ ${hrs(sum((c) => c.totalLatencyMs))} de Claude Code`, modelLine ? `🤖 ${modelLine}` : null]
            .filter(Boolean)
            .join(' · '),
          prevGrand ? `📈 ${arrow(pct(grand, prevGrand))} vs. janela anterior` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      ...(globalHours.some(Boolean)
        ? [
            {
              name: '📊 Atividade por hora (BRT -03)',
              value: `\`00h ${sparkline(globalHours)} 23h\`\npico às ${String(peak).padStart(2, '0')}h`,
            },
          ]
        : []),
      ...(toolLine ? [{ name: '🔧 Ferramentas mais usadas', value: toolLine }] : []),
      ...(deltaLine
        ? [
            {
              name: `📈 vs. janela anterior (até ${previous!.until.slice(5, 10).split('-').reverse().join('/')})`,
              value: deltaLine,
            },
          ]
        : []),
      ...highlights,
    ],
    // Legenda no rodapé em vez de cabeçalho dentro do code block: alinhar
    // cabeçalho com padEnd é frágil e quebra assim que um nome muda de tamanho.
    footer: { text: `desde ${sinceStr} · colunas: total · % · tokens por chamada` },
  }

  // Per-user detail embeds
  const userEmbeds = rows.map(([name, c], i) => userEmbed(name, c, i + 1))

  return cache([groupEmbed, ...userEmbeds])
}

/**
 * Post the usage summary to Discord via webhook.
 * Called by scheduled interval or on-demand (SIGUSR1 signal).
 * Discord allows max 10 embeds per message.
 */
export async function postReport(): Promise<void> {
  if (!webhookUrl) return
  const embeds = allEmbeds()
  // Discord limit: 10 embeds per message
  for (let i = 0; i < embeds.length; i += 10) {
    await sendDiscord(webhookUrl, { embeds: embeds.slice(i, i + 10) })
  }
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
