import { randomBytes } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { isSeq, parseDocument } from 'yaml'
import type { Config } from './config.js'
import { initAuth } from './auth.js'
import { log } from './logger.js'

export const GRACE_MS = 24 * 60 * 60 * 1000

export class RotateError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export type RotateResult = {
  name: string
  token: string
  previousValidUntil: number | null
  launcher: { filename: string; content: string } | null
}

function findClient(config: Config, name: string) {
  const idx = config.auth.tokens.findIndex((t) => t.name === name)
  if (idx === -1) throw new RotateError(404, `Unknown client: ${name}`)
  return { idx, entry: config.auth.tokens[idx] }
}

/** Apply `edit` to the client's YAML node and save; throws before writing if the file drifted. */
function saveClient(configPath: string, idx: number, name: string, edit: (path: (k: string) => unknown[], doc: ReturnType<typeof parseDocument>) => void) {
  const doc = parseDocument(readFileSync(configPath, 'utf-8'))
  if (doc.getIn(['auth', 'tokens', idx, 'name']) !== name) {
    throw new RotateError(409, 'config.yaml changed on disk since startup; restart the gateway before changing tokens')
  }
  edit((k) => ['auth', 'tokens', idx, k], doc)
  // lineWidth 0: never fold long scalars; oauth.persistTokens edits config.yaml line by line
  writeFileSync(configPath, doc.toString({ lineWidth: 0 }))
}

/**
 * Give a client a new token. With grace, the old one keeps working for GRACE_MS so
 * the machine can be updated without an outage; without (leaked token), every old
 * token dies now. Persists to config.yaml first, then swaps the live token map.
 */
// ponytail: one grace slot per client, rotating twice within 24h kills the oldest token immediately
export function rotateClientToken(config: Config, configPath: string, name: string, now = Date.now(), grace = true): RotateResult {
  const { idx, entry } = findClient(config, name)
  const oldToken = entry.token
  const token = randomBytes(32).toString('hex')
  const previousValidUntil = grace ? now + GRACE_MS : null

  saveClient(configPath, idx, name, (k, doc) => {
    doc.setIn(k('token'), token)
    if (previousValidUntil === null) {
      doc.deleteIn(k('previous_token'))
      doc.deleteIn(k('previous_expires_at'))
    } else {
      doc.setIn(k('previous_token'), oldToken)
      doc.setIn(k('previous_expires_at'), previousValidUntil)
    }
  })

  entry.token = token
  if (previousValidUntil === null) {
    delete entry.previous_token
    delete entry.previous_expires_at
  } else {
    entry.previous_token = oldToken
    entry.previous_expires_at = previousValidUntil
  }
  initAuth(config)

  return { name, token, previousValidUntil, launcher: rewriteLauncher(config, configPath, name, oldToken, token) }
}

/** Kill a client's grace-period token now (e.g. it leaked after a normal rotation). */
export function endGrace(config: Config, configPath: string, name: string): void {
  const { idx, entry } = findClient(config, name)
  if (!entry.previous_token || (entry.previous_expires_at ?? 0) <= Date.now()) {
    throw new RotateError(409, `${name} has no old token in a grace period`)
  }
  saveClient(configPath, idx, name, (k, doc) => {
    doc.deleteIn(k('previous_token'))
    doc.deleteIn(k('previous_expires_at'))
  })
  delete entry.previous_token
  delete entry.previous_expires_at
  initAuth(config)
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** Register a new client (new machine) with a fresh token, live without a restart. */
export function addClient(config: Config, configPath: string, name: string): RotateResult {
  if (!NAME_RE.test(name)) throw new RotateError(400, 'Name: 1-32 characters, lowercase letters, digits, - or _')
  if (config.auth.tokens.some((t) => t.name === name)) throw new RotateError(409, `A client named ${name} already exists`)
  const token = randomBytes(32).toString('hex')

  const doc = parseDocument(readFileSync(configPath, 'utf-8'))
  const list = doc.getIn(['auth', 'tokens'])
  if (!isSeq(list) || list.items.length !== config.auth.tokens.length) {
    throw new RotateError(409, 'config.yaml changed on disk since startup; restart the gateway before changing tokens')
  }
  doc.addIn(['auth', 'tokens'], doc.createNode({ name, token }))
  writeFileSync(configPath, doc.toString({ lineWidth: 0 }))

  config.auth.tokens.push({ name, token })
  initAuth(config)
  return { name, token, previousValidUntil: null, launcher: rewriteLauncher(config, configPath, name, null, token) }
}

const tokenOf = (script: string) => script.match(/^CLIENT_TOKEN="([^"]*)"/m)?.[1]

/**
 * Regenerate the client's launcher script from clients/: the file that holds the
 * old token, or (none found) any cc-* launcher as a template saved as cc-<name>.
 */
function rewriteLauncher(config: Config, configPath: string, name: string, oldToken: string | null, token: string) {
  const dir = config.clients?.dir ?? join(dirname(resolve(configPath)), 'clients')
  if (!existsSync(dir)) return null
  const scripts = readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => ({ f, s: readFileSync(join(dir, f), 'utf-8') }))
    .filter(({ s }) => tokenOf(s) !== undefined)

  const own = scripts.find(({ s }) => tokenOf(s) === oldToken)
  const base = own ?? scripts.find(({ f }) => f.startsWith('cc-'))
  if (!base) return null
  const filename = own ? own.f : `cc-${name}`

  let content = base.s.replace(/^CLIENT_TOKEN=.*$/m, `CLIENT_TOKEN="${token}"`)
  if (config.clients?.gateway_url) {
    content = content.replace(/^GATEWAY_URL=.*$/m, `GATEWAY_URL="${config.clients.gateway_url}"`)
  }
  try {
    writeFileSync(join(dir, filename), content, { mode: 0o700 })
  } catch (err) {
    log('warn', `rotate: could not save ${filename} in ${dir}: ${err}`)
  }
  return { filename, content }
}
