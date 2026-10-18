/**
 * Entrega no TeamSpeak: o caminho que substituiu o webhook do Discord.
 *
 * O que está sendo protegido:
 *  1. o id do bot é resolvido pelo NOME. Os ids do TS3AudioBot são dados na
 *     ordem de conexão, então depois de um restart o id 0 pode ser o MusicBot —
 *     e o relatório de uso do reino iria parar na sala de música.
 *  2. a mensagem sobrevive ao ida-e-volta de aspas + percent-encoding. Um ")"
 *     solto fecharia o grupo /api/bot/use/<id>/(...) antes da hora e o comando
 *     viraria outra coisa.
 *  3. o corte em pedaços respeita o teto de bytes e não parte um caractere no
 *     meio (as barras e os emoji dos avisos são multibyte).
 *
 * Sem rede externa: sobe um TS3AudioBot de mentira em 127.0.0.1 numa porta
 * efêmera e confere o que chegou nele.
 *
 * Roda com: npx tsx tests/teamspeak.test.ts
 */

import assert from 'node:assert'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'

import { sendChat, render, chunks, encodeCommandArg } from '../src/teamspeak.js'

// ── 1. render: embed -> markdown ────────────────────────────────────────────
// O chat do TS6 é GFM (o locale do cliente lista markdown.{bold,code,codeblock,
// table}), então título vira heading, rótulo vira negrito e o que já vinha
// marcado do tempo do Discord passa DIRETO — nada de arrancar marcação.
assert.strictEqual(
  render({
    embeds: [
      {
        title: 'Uso da conta compartilhada: 45%',
        description: '`7d ████░░` **45.2%**',
        fields: [
          { name: 'status', value: '`allowed_warning`' },
          { name: 'zera em', value: '30/08 12:00 UTC' },
        ],
        footer: { text: 'janela de 7 dias' },
      },
    ],
  }),
  '### Uso da conta compartilhada: 45%\n' +
    '\n' +
    '`7d ████░░` **45.2%**\n' +
    '\n' +
    '**status** · `allowed_warning`\n' +
    '**zera em** · 30/08 12:00 UTC\n' +
    '\n' +
    '*janela de 7 dias*',
  'render não montou o markdown',
)

// card de destaque (2 linhas curtas) colapsa numa linha só — 9 deles em lista
// eram 27 linhas de rolagem
assert.ok(
  render({ embeds: [{ fields: [{ name: 'topo', value: 'alfa\n900 tokens' }] }] }).includes(
    '**topo** · alfa — 900 tokens',
  ),
  'card curto deveria caber numa linha',
)
// mas valor realmente longo continua em lista
{
  const longo = render({
    embeds: [{ fields: [{ name: 'x', value: `${'a'.repeat(80)}\n${'b'.repeat(80)}` }] }],
  })
  assert.ok(longo.includes('- ' + 'a'.repeat(80)), 'valor longo deveria virar lista')
}

// a marcação que o embed já trazia NÃO pode ser removida — era isso que
// destruía o alinhamento do placar (usage-meter já manda o bloco cercado).
assert.ok(render('**negrito** `mono`').includes('**negrito**'), 'arrancou markdown do texto')

// ── 3. corte: teto de bytes, sem partir caractere ────────────────────────────
{
  const linha = '⚔️'.repeat(400) // ~2.6 KB, bem acima do teto de 900 bytes
  const partes = chunks(linha)
  assert.ok(partes.length > 1, 'linha longa não foi cortada')
  for (const p of partes) {
    assert.ok(Buffer.byteLength(p) <= 900, `pedaço com ${Buffer.byteLength(p)} bytes passou do teto`)
  }
  assert.strictEqual(partes.join(''), linha, 'o corte perdeu ou duplicou caractere')
}
assert.strictEqual(chunks('a\nb\nc').length, 1, 'mensagem curta foi picotada à toa')

// ── 3b. corte DENTRO de bloco cercado ────────────────────────────────────────
// O placar do relatório é um bloco ``` que passa de uma mensagem. Cortado sem
// cuidado, o pedaço 1 fica com a cerca aberta e o 2 com uma cerca solta — os
// dois renderizam quebrados. Cada pedaço tem que sair balanceado.
{
  const tabela = Array.from({ length: 60 }, (_, i) => `linha ${i} ${'x'.repeat(40)}`)
  const partes = chunks(['antes', '```', ...tabela, '```', 'depois'].join('\n'))
  assert.ok(partes.length > 1, 'o caso nem chegou a cortar — teste não prova nada')
  for (const [i, p] of partes.entries()) {
    const cercas = p.split('\n').filter((l) => l.trimStart().startsWith('```')).length
    assert.strictEqual(cercas % 2, 0, `pedaço ${i + 1} saiu com cerca desbalanceada`)
  }
  // e o conteúdo não pode sumir no processo
  const linhas = partes.join('\n').split('\n').filter((l) => !l.trimStart().startsWith('```'))
  assert.deepStrictEqual(linhas, ['antes', ...tabela, 'depois'], 'o corte perdeu linha')
}

// ── 3c. o corte prefere quebrar num heading ─────────────────────────────────
// Sem isso o card de um usuário sai partido entre duas mensagens.
{
  const card = (n: number) => [`### ${n}. usuario${n}`, ...Array.from({ length: 12 }, (_, i) => `linha ${i} ${'y'.repeat(30)}`)]
  const partes = chunks([...card(1), ...card(2), ...card(3)].join('\n'))
  for (const p of partes) {
    const heads = p.split('\n').filter((l) => l.startsWith('### ')).length
    if (heads) {
      assert.ok(p.split('\n')[0].startsWith('### '), 'pedaço com heading não começa nele — card partido')
    }
  }
}

// ── 4. parênteses precisam sair encodados ────────────────────────────────────
assert.ok(!encodeCommandArg('a)b').includes(')'), '") " cru fecharia o grupo de comando')
assert.ok(!encodeCommandArg('a(b').includes('('), '"(" cru abriria grupo de comando')

// ── 5. ida-e-volta contra um TS3AudioBot de mentira ──────────────────────────
const recebidas: string[] = []
const usados: number[] = []

const srv = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/bot/list')) {
    // De propósito: "claudinho" NÃO é o id 0. Resolver por posição erra aqui.
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([
      { Id: 0, Name: 'music', Status: 2 },
      { Id: 7, Name: 'claudinho', Status: 2 },
    ]))
    return
  }
  const m = /^\/api\/bot\/use\/(\d+)\/\(\/pm\/channel\/(.*)\)$/.exec(url)
  if (!m) {
    res.statusCode = 422
    res.end()
    return
  }
  usados.push(Number(m[1]))
  // O segmento de path JÁ é um argumento inteiro: percent-decode e pronto.
  // Aspas aqui seriam texto literal — foi exatamente o bug de 2026-08-23.
  const texto = decodeURIComponent(m[2])
  assert.ok(!texto.startsWith('"'), 'a mensagem saiu entre aspas — elas aparecem na sala')
  recebidas.push(texto)
  res.statusCode = 204
  res.end()
})

await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
const porta = (srv.address() as AddressInfo).port

try {
  const msg = 'aspa " barra \\ paren ) aberto ( dois:pontos 50% ⚔️ acento ção'
  await sendChat(`http://127.0.0.1:${porta}/claudinho`, msg)

  assert.deepStrictEqual(usados, [7], 'não resolveu o bot pelo nome — id errado')
  assert.deepStrictEqual(recebidas, [msg], 'a mensagem não sobreviveu ao ida-e-volta')

  // Bot que não existe: avisa e não manda nada, nunca estoura.
  recebidas.length = 0
  await sendChat(`http://127.0.0.1:${porta}/naoexiste`, 'oi')
  assert.deepStrictEqual(recebidas, [], 'mandou mensagem para um bot inexistente')

  console.log('ok — teamspeak: resolve por nome, encoda parênteses/aspas, corta por bytes')
} finally {
  srv.close()
}
