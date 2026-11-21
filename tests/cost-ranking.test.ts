/**
 * Ordem do relatório de uso: US$ gastos, não quantidade de tokens.
 *
 * O que está sendo protegido: o RANKING. Modelos custam por token diferente
 * (haiku-4-5 é 10× mais barato que fable), e cache lido vale 0.025–0.1× do token
 * novo. Ordenar por tokens põe o cliente barato de cache na frente do cliente
 * caro — o erro exato que esta ordenação existe pra não cometer.
 *
 * Roda com: npx tsx tests/cost-ranking.test.ts
 */

import assert from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  initUsageMeter,
  recordRequest,
  attachUsage,
  resetCounters,
  summaryEmbed,
} from '../src/usage-meter.js'

const dir = mkdtempSync(resolve(tmpdir(), 'ccg-cost-'))
initUsageMeter({ statePath: resolve(dir, 'state.json') })

/** Simula uma resposta upstream não-SSE e espera o metering terminar. */
function feed(client: string, body: unknown): Promise<void> {
  const res = new PassThrough() as PassThrough & { headers: Record<string, string> }
  res.headers = { 'content-type': 'application/json' }
  attachUsage(client, res as never, 200)
  return new Promise((done) => {
    res.on('end', () => setImmediate(done)) // depois do handler do attachUsage
    res.end(JSON.stringify(body))
  })
}

const infer = (client: string, model: string, usage: Record<string, number>) => {
  recordRequest(client, 200)
  return feed(client, { model, usage })
}

const out = () => JSON.stringify(summaryEmbed())
const rowWith = (j: string, name: string): string =>
  JSON.parse(j).description
    .split('\n')
    .find((l: string) => /^\d+\.\s/.test(l) && l.includes(name)) ?? ''

// barato: 4M tokens, quase todos cache lido de haiku-4-5 → US$ ~0.41
//         (in $1/M, read 0.1× → 20 × (500 + 200k×0.1)/1e6)
// caro:   30k tokens de fable (in $10/M, out $50/M)      → US$  0.70
// Por tokens, barato lideraria com folga. Por custo, quem lidera é o caro.
resetCounters()
for (let i = 0; i < 20; i++)
  await infer('barato', 'claude-haiku-4-5', {
    input_tokens: 500,
    output_tokens: 0,
    cache_read_input_tokens: 200_000,
  })
for (let i = 0; i < 10; i++)
  await infer('caro', 'claude-fable-5', { input_tokens: 2000, output_tokens: 1000 })
let j = out()

const caroRow = rowWith(j, 'caro')
const baratoRow = rowWith(j, 'barato')
assert.match(caroRow, /^1\.\s/, `caro (US$ 0.70 em 30k tokens) não ficou em 1º: ${caroRow}`)
assert.match(baratoRow, /^2\.\s/, `barato (US$ 0.41 em 4M tokens) não ficou em 2º: ${baratoRow}`)
assert.match(caroRow, /\s0\.70\s/, `coluna US$ não mostrou o custo do líder: ${caroRow}`)
assert.match(j, /lidera com \*\*US\$ 0\.70\*\* em custo de API/, 'linha "lidera" não veio em US$')

// ── cliente sem preço na tabela não some do ranking: vai pro fundo, por tokens ──
resetCounters()
for (let i = 0; i < 10; i++)
  await infer('caro', 'claude-fable-5', { input_tokens: 2000, output_tokens: 1000 })
for (let i = 0; i < 3; i++)
  await infer('sem-preco', 'claude-quark-9', { input_tokens: 3_000_000, output_tokens: 0 })
j = out()
const semPrecoRow = rowWith(j, 'sem-preco')
assert.match(semPrecoRow, /^2\.\s/, `sem preço (9M tokens) não caiu pro fundo: ${semPrecoRow}`)
assert.match(semPrecoRow, /\s—\s/, 'cliente sem preço deveria mostrar — na coluna US$')

rmSync(dir, { recursive: true, force: true })
console.log('ok — ranking do relatório: por US$, não por tokens; sem preço vai pro fundo')
