import { request as httpsRequest } from 'https'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createHmac } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { Config } from './config.js'
import { log } from './logger.js'
import { sendDiscord } from './discord.js'
import { getProxyAgent } from './proxy-agent.js'

type Invoice = {
  clientName: string
  mpPreferenceId: string
  mpPaymentId?: string
  checkoutUrl?: string
  amountBrl: number
  createdAt: string
  dueAt: string
  paidAt?: string
  status: 'pending' | 'paid' | 'overdue'
}

type BillingState = {
  invoices: Invoice[]
  lastGenerated: string
}

let state: BillingState = { invoices: [], lastGenerated: '' }
let statePath = ''
let billingConfig: NonNullable<Config['billing']>
let webhookUrl = ''
let discordWebhook = ''
let clientNames: string[] = []

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

function loadState(): void {
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    state = { invoices: [], lastGenerated: '' }
  }
}

function saveState(): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (err) {
    log('error', `billing: could not persist state: ${err}`)
  }
}

function mpRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const agent = getProxyAgent()
    const req = httpsRequest(
      {
        hostname: 'api.mercadopago.com',
        port: 443,
        path,
        method,
        headers: {
          'Authorization': `Bearer ${billingConfig.mp_access_token}`,
          'Content-Type': 'application/json',
          ...(data && { 'Content-Length': String(Buffer.byteLength(data)) }),
        },
        ...(agent && { agent }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`MP ${method} ${path} → ${res.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(text) as T)
          } catch {
            reject(new Error(`MP ${method} ${path}: invalid JSON`))
          }
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function periodLabel(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function createPreference(clientName: string): Promise<{ id: string; init_point: string }> {
  const period = periodLabel()
  const expiry = new Date(Date.now() + (billingConfig.grace_days + 3) * DAY_MS)

  return mpRequest('POST', '/checkout/preferences', {
    items: [{
      title: `CC Gateway — ${clientName} (${period})`,
      quantity: 1,
      unit_price: billingConfig.amount_brl,
      currency_id: 'BRL',
    }],
    external_reference: `ccg-${clientName}-${period}`,
    notification_url: webhookUrl,
    expires: true,
    expiration_date_to: expiry.toISOString(),
  })
}

export async function generateInvoices(): Promise<void> {
  const period = periodLabel()
  const exempt = new Set(billingConfig.exempt ?? [])
  const billable = clientNames.filter((n) => !exempt.has(n))

  const generated: Invoice[] = []

  for (const name of billable) {
    const existing = state.invoices.find(
      (i) => i.clientName === name && i.createdAt.startsWith(period),
    )
    if (existing) {
      log('info', `billing: ${name} already invoiced for ${period}, skipping`)
      continue
    }

    try {
      const pref = await createPreference(name)
      const now = new Date()
      const invoice: Invoice = {
        clientName: name,
        mpPreferenceId: pref.id,
        checkoutUrl: pref.init_point,
        amountBrl: billingConfig.amount_brl,
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() + billingConfig.grace_days * DAY_MS).toISOString(),
        status: 'pending',
      }
      state.invoices.push(invoice)
      generated.push(invoice)
      log('info', `billing: created invoice for ${name} (${period}) → ${pref.init_point}`)
    } catch (err) {
      log('error', `billing: failed to create preference for ${name}: ${err}`)
    }
  }

  state.lastGenerated = new Date().toISOString()
  saveState()

  if (generated.length > 0 && discordWebhook) {
    const lines = generated.map(
      (i) => `• **${i.clientName}** — R$${i.amountBrl} — [Pagar](${i.checkoutUrl})`,
    )
    sendDiscord(discordWebhook, {
      embeds: [{
        title: `💰 Cobranças geradas — ${period}`,
        description: lines.join('\n'),
        color: 0x3498db,
        footer: { text: `Vencimento: ${billingConfig.grace_days} dias` },
      }],
    })
  }
}

function markOverdue(): void {
  const now = Date.now()
  let changed = false
  for (const inv of state.invoices) {
    if (inv.status === 'pending' && now > new Date(inv.dueAt).getTime()) {
      inv.status = 'overdue'
      changed = true
      log('info', `billing: ${inv.clientName} invoice overdue`)
    }
  }
  if (changed) saveState()
}

function latestInvoice(clientName: string): Invoice | undefined {
  for (let i = state.invoices.length - 1; i >= 0; i--) {
    if (state.invoices[i].clientName === clientName) return state.invoices[i]
  }
  return undefined
}

export function isBlocked(clientName: string): boolean {
  const inv = latestInvoice(clientName)
  if (!inv) return false
  return inv.status === 'overdue'
}

export function handleWebhook(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))

      if (body.topic || (req.url && req.url.includes('topic='))) {
        log('info', 'billing: ignoring legacy IPN notification')
        return
      }

      const paymentId = body.data?.id
      if (!paymentId) {
        log('warn', 'billing: webhook without data.id')
        return
      }

      if (billingConfig.mp_webhook_secret) {
        const sig = req.headers['x-signature'] as string | undefined
        const reqId = req.headers['x-request-id'] as string | undefined
        if (!verifySignature(sig, reqId, String(paymentId), billingConfig.mp_webhook_secret)) {
          log('warn', 'billing: webhook signature mismatch — dropping')
          return
        }
      }

      void processPayment(String(paymentId))
    } catch (err) {
      log('error', `billing: webhook parse error: ${err}`)
    }
  })
}

function verifySignature(
  sig: string | undefined,
  requestId: string | undefined,
  dataId: string,
  secret: string,
): boolean {
  if (!sig) return false
  const parts: Record<string, string> = {}
  for (const segment of sig.split(',')) {
    const [k, v] = segment.split('=', 2)
    if (k && v) parts[k.trim()] = v.trim()
  }
  const ts = parts['ts']
  const v1 = parts['v1']
  if (!ts || !v1) return false

  const manifest = `id:${dataId};request-id:${requestId ?? ''};ts:${ts};`
  const expected = createHmac('sha256', secret).update(manifest).digest('hex')
  return expected === v1
}

async function processPayment(paymentId: string): Promise<void> {
  try {
    const payment = await mpRequest<{
      id: number
      status: string
      external_reference?: string
      transaction_amount?: number
    }>('GET', `/v1/payments/${paymentId}`)

    if (payment.status !== 'approved') {
      log('info', `billing: payment ${paymentId} status=${payment.status}, ignoring`)
      return
    }

    const ref = payment.external_reference
    if (!ref || !ref.startsWith('ccg-')) {
      log('info', `billing: payment ${paymentId} external_reference=${ref}, not ours`)
      return
    }

    const clientName = ref.replace(/^ccg-/, '').replace(/-\d{4}-\d{2}$/, '')
    const inv = state.invoices.find(
      (i) => i.clientName === clientName && i.status !== 'paid',
    )
    if (!inv) {
      log('warn', `billing: payment ${paymentId} for ${clientName} but no pending invoice`)
      return
    }

    inv.mpPaymentId = String(payment.id)
    inv.paidAt = new Date().toISOString()
    inv.status = 'paid'
    saveState()

    log('info', `billing: ${clientName} paid (payment ${paymentId})`)

    if (discordWebhook) {
      sendDiscord(discordWebhook, {
        embeds: [{
          title: '✅ Pagamento confirmado',
          description: `**${clientName}** pagou R$${payment.transaction_amount ?? inv.amountBrl}`,
          color: 0x2ecc71,
        }],
      })
    }
  } catch (err) {
    log('error', `billing: failed to process payment ${paymentId}: ${err}`)
  }
}

function shouldGenerate(): boolean {
  if (!state.lastGenerated) return true
  return Date.now() - new Date(state.lastGenerated).getTime() >= 30 * DAY_MS
}

function dailyCheck(): void {
  markOverdue()
  if (shouldGenerate()) {
    log('info', 'billing: 30 days elapsed, generating new invoices')
    void generateInvoices()
  }
}

export function postBillingReport(): void {
  if (!discordWebhook) return
  const exempt = new Set(billingConfig.exempt ?? [])
  const lines = clientNames
    .filter((n) => !exempt.has(n))
    .map((name) => {
      const inv = latestInvoice(name)
      if (!inv) return `• ${name} — sem cobrança`
      const icon = inv.status === 'paid' ? '✅' : inv.status === 'overdue' ? '🚫' : '⏳'
      return `• ${icon} **${name}** — ${inv.status} (R$${inv.amountBrl})`
    })

  sendDiscord(discordWebhook, {
    embeds: [{
      title: '📊 Status de cobrança',
      description: lines.join('\n') || 'Nenhum cliente faturável.',
      color: 0x9b59b6,
    }],
  })
}

export function initBilling(config: Config): void {
  if (!config.billing?.enabled) {
    log('info', 'Billing disabled')
    return
  }

  billingConfig = config.billing
  statePath = resolve(process.cwd(), 'billing-state.json')
  webhookUrl = `https://ccg.pagcoin.org/_billing/webhook`
  discordWebhook = config.notify?.discord_webhook ?? ''
  clientNames = config.auth.tokens.map((t) => t.name)

  loadState()
  dailyCheck()
  setInterval(dailyCheck, 24 * HOUR_MS)

  log('info', `Billing armed: R$${billingConfig.amount_brl}/month, ${billingConfig.grace_days}d grace, ${clientNames.length} clients (${billingConfig.exempt?.length ?? 0} exempt)`)
}
