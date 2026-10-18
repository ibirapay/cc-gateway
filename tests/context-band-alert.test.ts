/**
 * Alerta de banda de contexto por request.
 *
 * O que está sendo protegido: o alerta é um PING no Discord de 5 pessoas. Se ele
 * disparar em toda request de um cliente parado em 900k, vira ruído e alguém
 * desliga o webhook — e aí o gateway perde também o relatório de 6h. A guarda
 * que importa é "só sobe de banda, nunca repete".
 *
 * Sem rede: o webhook aponta pra um domínio .invalid (RFC 2606, nunca resolve).
 * sendDiscord engole o erro de DNS; a asserção é no log('info'), que acontece
 * ANTES da tentativa de rede e portanto é determinístico.
 *
 * Roda com: npx tsx tests/context-band-alert.test.ts
 */

import assert from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { initUsageMeter, attachUsage, resetCounters } from '../src/usage-meter.js'

const dir = mkdtempSync(resolve(tmpdir(), 'ccg-band-'))

const logged: string[] = []
const realLog = console.log
console.log = (...a: unknown[]) => { logged.push(a.join(' ')) }

initUsageMeter({
  webhook: 'http://ts.invalid/claudinho',
  statePath: resolve(dir, 'state.json'),
})

/** Uma resposta upstream com um contexto de `ctx` tokens de entrada. */
function req(client: string, ctx: number): Promise<void> {
  const res = new PassThrough() as PassThrough & { headers: Record<string, string> }
  res.headers = { 'content-type': 'application/json' }
  attachUsage(client, res as never, 200)
  return new Promise((done) => {
    res.on('end', () => setImmediate(done))
    res.end(JSON.stringify({
      model: 'claude-opus-5',
      // O contexto é entrada + cache; mando pelo cache_read porque é assim que
      // ele chega numa conversa real (95% do contexto vem de cache).
      usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, output_tokens: 5 },
    }))
  })
}

const alerts = () => logged.filter((l) => l.includes('alerted'))
const since = (n: number) => alerts().slice(n)

try {
  // ── 1. abaixo da primeira banda: silêncio ─────────────────────────────────
  await req('alfa', 300_000)
  assert.strictEqual(alerts().length, 0, `alertou com 300k: ${alerts().join('|')}`)

  // ── 2. cruzou 500k: alerta uma vez ────────────────────────────────────────
  let n = alerts().length
  await req('alfa', 520_000)
  assert.strictEqual(since(n).length, 1, 'devia alertar ao cruzar 500k')
  assert.match(since(n)[0], /alfa.*500000/, `alerta sem cliente/banda: ${since(n)[0]}`)

  // ── 3. mesma banda de novo: NÃO repete (a guarda que importa) ─────────────
  n = alerts().length
  for (let i = 0; i < 5; i++) await req('alfa', 610_000)
  assert.strictEqual(since(n).length, 0, `repetiu na mesma banda ${since(n).length}x — viraria ruído`)

  // ── 4. banda maior: volta a alertar ───────────────────────────────────────
  n = alerts().length
  await req('alfa', 950_000)
  assert.strictEqual(since(n).length, 1, 'devia alertar ao subir de banda')
  assert.match(since(n)[0], /900000/, `banda errada: ${since(n)[0]}`)

  // ── 5. cair de volta não re-arma (senão oscilar em torno de 900k spamaria) ─
  n = alerts().length
  await req('alfa', 520_000)
  await req('alfa', 950_000)
  assert.strictEqual(since(n).length, 0, 're-alertou ao oscilar em torno da banda')

  // ── 6. cliente novo tem bandas próprias ───────────────────────────────────
  n = alerts().length
  await req('beta', 520_000)
  assert.strictEqual(since(n).length, 1, 'banda de um cliente vazou pro outro')
  assert.match(since(n)[0], /beta/, `alerta atribuído ao cliente errado: ${since(n)[0]}`)

  // ── 7. janela nova re-arma tudo ───────────────────────────────────────────
  resetCounters()
  n = alerts().length
  await req('alfa', 520_000)
  assert.strictEqual(since(n).length, 1, 'não re-armou depois do reset da janela de 7 dias')

  console.log = realLog
  console.log('ok — alerta de banda: sobe, não repete, não oscila, por cliente')
} finally {
  console.log = realLog
  rmSync(dir, { recursive: true, force: true })
}
