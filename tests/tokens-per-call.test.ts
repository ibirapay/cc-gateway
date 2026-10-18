/**
 * Métrica "tokens por chamada" do relatório de uso.
 *
 * O que está sendo protegido: o DENOMINADOR. `recordRequest` conta toda request
 * proxiada, inclusive /v1/messages/count_tokens, que responde sem bloco `usage`.
 * Dividir por `requests` faria quem chama mais count_tokens parecer mais leve
 * por chamada — invertendo exatamente a pergunta que a métrica existe pra
 * responder. O denominador certo é o nº de respostas que trouxeram um modelo.
 *
 * Roda com: npx tsx tests/tokens-per-call.test.ts
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

const dir = mkdtempSync(resolve(tmpdir(), 'ccg-tpc-'))
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

/** Uma chamada de inferência de verdade: traz `model` + `usage`. */
const infer = (client: string, tokens: number) => {
  recordRequest(client, 200)
  return feed(client, {
    model: 'claude-opus-5',
    usage: { input_tokens: tokens / 2, output_tokens: tokens / 2 },
  })
}

/** Um /v1/messages/count_tokens: sem `model`, sem `usage`. Grátis. */
const countTokens = (client: string) => {
  recordRequest(client, 200)
  return feed(client, { input_tokens: 4321 })
}

// ⚠️ allEmbeds() cacheia por 30s e só invalida no persist() do timer. Toda
// leitura aqui tem que vir logo depois de um resetCounters() (que persiste e
// zera o cache) e do cenário reconstruído — senão se lê o embed anterior.
const board = () => JSON.stringify(summaryEmbed())

// ── 1. count_tokens não entra no denominador ────────────────────────────────
// alfa: 2 chamadas reais de 1000 tokens + 8 count_tokens.
// Certo: 2000/2 = 1.0k por chamada.  Errado (÷ requests): 2000/10 = 200.
for (let i = 0; i < 2; i++) await infer('alfa', 1000)
for (let i = 0; i < 8; i++) await countTokens('alfa')

let out = board()
// Total geral (usa grand/tInf)…
assert.match(out, /1\.0k\*\* tokens por chamada/, 'esperava 1.0k/chamada (÷ chamadas de inferência)')
assert.match(out, /8 sem tokens/, 'não reportou quantas requests não geraram token')
// …e a coluna do board (usa perReq). Precisa das DUAS: elas têm denominadores
// calculados em lugares diferentes, e só uma delas quebrar já é o bug.
const alfaRow: string = JSON.parse(out)
  .description.split('\n')
  .find((l: string) => /^\d+\.\s/.test(l) && l.includes('alfa')) // a linha do board, não o "lidera com"
assert.match(alfaRow, /\s1\.0k$/, `coluna por-chamada do board dividiu errado: ${alfaRow}`)

// ── 2a. média com poucas chamadas não leva o destaque ───────────────────────
resetCounters()
await infer('beta', 999_999) // 1 chamada monstruosa
out = board()
assert.doesNotMatch(out, /Mais pesado por chamada/, '1 chamada não pode ganhar o destaque de média')

// ── 2b. com amostra suficiente o destaque aparece — e vai pro cliente certo ──
resetCounters()
await infer('beta', 999_999) // continua sendo a maior média, mas com 1 só chamada
for (let i = 0; i < 20; i++) await infer('alfa', 500)
out = board()
assert.match(out, /Mais pesado por chamada/, 'com 20 chamadas o destaque tem que aparecer')
const heavy = JSON.parse(out).fields.find((f: { name: string }) => f.name.includes('Mais pesado'))
assert.match(heavy.value, /^alfa\n/, `destaque foi pro cliente com amostra insuficiente: ${heavy.value}`)

// ── 3. cliente sem inferência nenhuma não vira NaN/Infinity ─────────────────
resetCounters()
for (let i = 0; i < 5; i++) await countTokens('gama')
out = board()
assert.doesNotMatch(out, /NaN|Infinity/, 'divisão por zero vazou pro relatório')
assert.match(out, /—/, 'esperava — (sem inferência medida), não um número inventado')

rmSync(dir, { recursive: true, force: true })
console.log('ok — tokens por chamada: denominador, guarda de amostra e divisão por zero')
