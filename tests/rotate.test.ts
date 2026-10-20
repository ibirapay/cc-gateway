/**
 * Client token rotation: new token works at once, old token keeps working for
 * the grace period and then stops; config.yaml keeps its comments and its
 * one-line OAuth fields (oauth.persistTokens edits them line by line); the
 * launcher in clients/ is regenerated; /_admin/rotate is admin-only.
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { loadConfig } from '../src/config.js'
import { authenticate, initAuth, isAdmin } from '../src/auth.js'
import { endGrace, GRACE_MS, rotateClientToken, RotateError } from '../src/rotate.js'
import { startProxy } from '../src/proxy.js'

const T = (c: string) => c.repeat(64)
const LONG_RT = 'sk-ant-ort01-' + 'x'.repeat(120)
const CONFIG = `# top comment
server:
  port: 8443
upstream:
  url: https://api.anthropic.com
auth:
  tokens:
    - name: admin
      token: ${T('a')}
      admin: true
    # nodge's machine
    - name: nodge
      token: ${T('b')}
    - name: nesi
      token: ${T('c')}
oauth:
  access_token: sk-ant-oat01-${'y'.repeat(120)}
  refresh_token: ${LONG_RT}
  expires_at: 9999999999999
logging:
  level: error
  audit: false
`
const LAUNCHER = (url: string, tok: string) => `#!/bin/bash\nGATEWAY_URL="${url}"\nCLIENT_TOKEN="${tok}"\necho body\n`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ccg-rotate-'))
  const cfgPath = join(dir, 'config.yaml')
  writeFileSync(cfgPath, CONFIG)
  mkdirSync(join(dir, 'clients'))
  writeFileSync(join(dir, 'clients', 'cc-nodge'), LAUNCHER('http://old:8443', T('b')))
  const config = loadConfig(cfgPath)
  config.clients = { gateway_url: 'https://ccg.example.org' }
  initAuth(config)
  return { dir, cfgPath, config }
}

const req = (key: string) => ({ headers: { 'x-api-key': key } }) as unknown as IncomingMessage

// 1. grace window + persistence + launcher
{
  const { dir, cfgPath, config } = setup()
  const r = rotateClientToken(config, cfgPath, 'nodge')
  assert.match(r.token, /^[0-9a-f]{64}$/)
  assert.notEqual(r.token, T('b'))
  assert.equal(authenticate(req(r.token)), 'nodge', 'new token works')
  assert.equal(authenticate(req(T('b'))), 'nodge', 'old token works during grace')
  assert.equal(authenticate(req(T('c'))), 'nesi', 'other clients untouched')

  const after = readFileSync(cfgPath, 'utf-8')
  assert.ok(after.includes('# top comment') && after.includes("# nodge's machine"), 'comments kept')
  assert.ok(after.includes(`  refresh_token: ${LONG_RT}\n`), 'refresh_token still one line')
  const reloaded = loadConfig(cfgPath)
  const nodge = reloaded.auth.tokens.find((t) => t.name === 'nodge')!
  assert.equal(nodge.token, r.token)
  assert.equal(nodge.previous_token, T('b'))
  assert.equal(nodge.previous_expires_at, r.previousValidUntil)

  initAuth(reloaded) // a restart during the grace period keeps the old token alive
  assert.equal(authenticate(req(T('b'))), 'nodge', 'grace survives restart')

  assert.equal(r.launcher?.filename, 'cc-nodge')
  assert.equal(r.launcher?.content, LAUNCHER('https://ccg.example.org', r.token))
  assert.equal(readFileSync(join(dir, 'clients', 'cc-nodge'), 'utf-8'), r.launcher?.content, 'launcher saved')

  const nesi = rotateClientToken(config, cfgPath, 'nesi')
  assert.equal(nesi.launcher?.filename, 'cc-nesi', 'no own launcher: built from a cc-* template')
  assert.ok(nesi.launcher?.content.includes(`CLIENT_TOKEN="${nesi.token}"`))

  assert.throws(() => rotateClientToken(config, cfgPath, 'ghost'), (e) => e instanceof RotateError && e.status === 404)
  assert.ok(isAdmin(config, 'admin') && !isAdmin(config, 'nodge'))
  rmSync(dir, { recursive: true })
}

// 2. old token stops working when the grace period ends (live expiry, no reload)
{
  const { dir, cfgPath, config } = setup()
  const r = rotateClientToken(config, cfgPath, 'nodge', Date.now() - GRACE_MS + 150)
  assert.equal(authenticate(req(T('b'))), 'nodge', 'still inside grace')
  await new Promise((ok) => setTimeout(ok, 250))
  assert.equal(authenticate(req(T('b'))), null, 'old token rejected after grace')
  assert.equal(authenticate(req(r.token)), 'nodge', 'new token still works')
  initAuth(loadConfig(cfgPath))
  assert.equal(authenticate(req(T('b'))), null, 'expired grace is not re-registered on restart')
  rmSync(dir, { recursive: true })
}

// 2b. leaked token: rotate without grace, and end a grace period early
{
  const { dir, cfgPath, config } = setup()
  const first = rotateClientToken(config, cfgPath, 'nodge') // normal rotation, b is in grace
  const leak = rotateClientToken(config, cfgPath, 'nodge', Date.now(), false)
  assert.equal(leak.previousValidUntil, null)
  assert.equal(authenticate(req(T('b'))), null, 'grace token killed by a no-grace rotation')
  assert.equal(authenticate(req(first.token)), null, 'replaced token killed at once')
  assert.equal(authenticate(req(leak.token)), 'nodge')
  const saved = loadConfig(cfgPath).auth.tokens.find((t) => t.name === 'nodge')!
  assert.equal(saved.previous_token, undefined, 'no grace fields left in config.yaml')
  initAuth(loadConfig(cfgPath))
  assert.equal(authenticate(req(first.token)), null, 'stays dead after restart')

  const r = rotateClientToken(config, cfgPath, 'nesi')
  assert.equal(authenticate(req(T('c'))), 'nesi', 'in grace')
  endGrace(config, cfgPath, 'nesi')
  assert.equal(authenticate(req(T('c'))), null, 'end-grace kills the old token now')
  assert.equal(authenticate(req(r.token)), 'nesi', 'new token unaffected')
  assert.equal(loadConfig(cfgPath).auth.tokens.find((t) => t.name === 'nesi')!.previous_token, undefined)
  assert.throws(() => endGrace(config, cfgPath, 'nesi'), (e) => e instanceof RotateError && e.status === 409)
  rmSync(dir, { recursive: true })
}

// 3. HTTP route: admin-only, returns token + launcher
{
  const { dir, cfgPath, config } = setup()
  const server = startProxy({ ...config, server: { ...config.server, port: 0 } }, cfgPath)
  await new Promise((ok) => server.once('listening', ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const rotate = (key: string, name: string, grace = true) =>
    fetch(`${base}/_admin/rotate`, { method: 'POST', headers: { 'x-api-key': key }, body: JSON.stringify({ name, grace }) })

  assert.equal((await rotate(T('b'), 'nesi')).status, 403, 'non-admin refused')
  assert.equal((await rotate('nope'.repeat(16), 'nesi')).status, 401, 'unknown token refused')
  assert.equal((await rotate(T('a'), 'ghost')).status, 404)
  const res = await rotate(T('a'), 'nodge')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { token: string; self: boolean; launcher: { filename: string } }
  assert.equal(body.self, false)
  assert.equal(body.launcher.filename, 'cc-nodge')
  const verify = (key: string) => fetch(`${base}/_verify`, { headers: { 'x-api-key': key } }).then((r) => r.status)
  assert.equal(await verify(body.token), 200, 'new token accepted over HTTP')
  assert.equal(await verify(T('b')), 200, 'old token accepted over HTTP during grace')
  const end = await fetch(`${base}/_admin/end-grace`, { method: 'POST', headers: { 'x-api-key': T('a') }, body: JSON.stringify({ name: 'nodge' }) })
  assert.equal(end.status, 200)
  assert.equal(await verify(T('b')), 401, 'old token refused after end-grace')
  const nogr = await rotate(T('a'), 'nesi', false)
  assert.equal(((await nogr.json()) as { previous_valid_until: unknown }).previous_valid_until, null)
  assert.equal(await verify(T('c')), 401, 'grace=false kills the old token over HTTP')
  server.close()
  rmSync(dir, { recursive: true })
}

console.log('rotate: ok')
