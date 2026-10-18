/**
 * Custo equivalente de API por resposta.
 *
 * O que está sendo protegido: o US$ do relatório bate com o `costUSD` que o
 * próprio Claude Code calcula. Os três casos abaixo são requests REAIS feitas
 * pelo ccg em 2026-10-18 (claude-opus-5-5); o valor esperado é o `costUSD` do
 * `claude -p --output-format json` de cada uma. A tabela antiga (opus $5/$25,
 * leitura 0.1×, toda escrita 1.25×) dava 0.0192 / 0.2286 / 0.3613.
 *
 * Roda com: npx tsx tests/pricing.test.ts
 */

import assert from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  costOf,
  initUsageMeter,
  recordRequest,
  attachUsage,
  resetCounters,
  summaryEmbed,
} from '../src/usage-meter.js'

const near = (got: number | null, want: number, what: string) =>
  assert.ok(got !== null && Math.abs(got - want) < 1e-9, `${what}: esperava ${want}, deu ${got}`)

const opus55 = { model: 'claude-opus-5-5', input: 2, cacheCreate1h: 0 }

// ── 1. requests reais vs costUSD do Claude Code ─────────────────────────────
near(costOf({ ...opus55, output: 4, cacheRead: 38171, cacheCreate: 0 }), 0.0077222, 'só leitura de cache')
near(costOf({ ...opus55, output: 24, cacheRead: 23245, cacheCreate: 34621 }), 0.178242, 'escrita TTL 5min')
near(
  costOf({ ...opus55, output: 24, cacheRead: 0, cacheCreate: 57744, cacheCreate1h: 57744 }),
  0.46244,
  'escrita TTL 1h (2×)',
)

// ── 2. regras da tabela que as requests reais não exercitam ─────────────────
const unit = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 }
near(costOf({ ...unit, model: 'claude-opus-5-5', speed: 'fast' }), 8, 'fast mode Opus 5.5 = $8')
near(costOf({ ...unit, model: 'claude-sonnet-5', speed: 'fast' }), 2, 'fast num modelo sem fast = preço base')
near(costOf({ ...unit, model: 'claude-opus-5' }), 5, "'claude-opus-5' não pode cair no preço do 5-5")
near(costOf({ ...unit, model: 'claude-opus-4-20250514' }), 15, 'Opus 4 (id com data)')
near(costOf({ ...unit, model: 'claude-haiku-5-5', input: 100_000 }), 0.01, 'Haiku 5.5 até 100k = $0.10')
near(costOf({ ...unit, model: 'claude-haiku-5-5', input: 100_001 }), 0.0500005, 'Haiku 5.5 acima de 100k = $0.50')
near(
  costOf({ ...unit, input: 0, model: 'claude-fable-5-1', cacheRead: 1_000_000 }),
  0.25,
  'leitura Fable 5.1 = 0.025×',
)
assert.equal(costOf({ ...unit, model: 'gpt-4o' }), null, 'modelo sem preço tem que ser null, nunca chute')
assert.equal(costOf({ ...unit }), null, 'sem modelo = null')

// ── 3. o caminho SSE de verdade leva o TTL 1h até o relatório ───────────────
// Sem o parse de usage.cache_creation, a escrita de 1h sai como 5min: US$ 0.29.
const dir = mkdtempSync(resolve(tmpdir(), 'ccg-price-'))
initUsageMeter({ statePath: resolve(dir, 'state.json') })
resetCounters()

const res = new PassThrough() as PassThrough & { headers: Record<string, string> }
res.headers = { 'content-type': 'text/event-stream' }
recordRequest('beta', 200)
attachUsage('beta', res as never, 200)
const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`
await new Promise<void>((done) => {
  res.on('end', () => setImmediate(done))
  res.write(
    ev({
      type: 'message_start',
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 57744,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 57744 },
          output_tokens: 1,
          speed: 'standard',
        },
      },
    }),
  )
  res.end(ev({ type: 'message_delta', usage: { output_tokens: 24 } }))
})
// 1ª leitura do embed neste processo: o cache de 30s ainda está vazio.
const board = JSON.stringify(summaryEmbed())
rmSync(dir, { recursive: true, force: true })
assert.ok(board.includes('US$ 0.46'), `esperava US$ 0.46 no relatório (0.29 = 1h cobrada como 5min): ${board.match(/US\$ [\d.]+/g)}`)

console.log('pricing: ok')
