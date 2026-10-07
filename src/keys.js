import { randomId, nowSec } from './util.js'

export const KEY_PREFIX = 'sk-lorem-'

const CACHE_TTL_MS = 0
const hashCache = new Map()
const idCache = new Map()

export async function hashKey(plaintext) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateKeyMaterial() {
  const plaintext = randomId(KEY_PREFIX, 48)
  const hash = await hashKey(plaintext)
  const prefix = plaintext.slice(0, 15) + '…'
  return { plaintext, hash, prefix }
}

export function parseBearer(request) {
  const header = request?.headers?.get?.('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  return token || null
}

function cacheGet(map, key) {
  const entry = map.get(key)
  if (!entry) return { hit: false }
  if (Date.now() < entry.expires) return { hit: true, value: entry.value }
  map.delete(key)
  return { hit: false }
}

function cacheSet(map, key, value) {
  map.set(key, { value, expires: Date.now() + CACHE_TTL_MS })
}

export function invalidateKeyCache() {
  hashCache.clear()
  idCache.clear()
}

function normalizeRule(r) {
  if (!r || typeof r !== 'object') return null
  const windowSeconds = Number(r.windowSeconds ?? r.window_seconds)
  const limitChars = Number(r.limitChars ?? r.limit_chars)
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null
  if (!Number.isFinite(limitChars) || limitChars < 0) return null
  return {
    windowSeconds,
    limitChars,
    enabled: r.enabled !== false,
    note: r.note == null ? '' : String(r.note)
  }
}

function asBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return []
  return rules.map(normalizeRule).filter(Boolean)
}

function parseQuotaRules(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeRules(parsed) : null
  } catch {
    return null
  }
}

function rowKey(r) {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    quotaMode: r.quota_mode,
    quotaRules: parseQuotaRules(r.quota_rules),
    enabled: !!r.enabled,
    expiresAt: r.expires_at ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function isExpired(key) {
  return key.expiresAt != null && key.expiresAt <= nowSec()
}

async function loadByHash(env, hash) {
  const cached = cacheGet(hashCache, hash)
  if (cached.hit) return cached.value
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(hash).first()
  const key = row ? rowKey(row) : null
  cacheSet(hashCache, hash, key)
  if (key) cacheSet(idCache, key.id, key)
  return key
}

async function loadById(env, id) {
  const cached = cacheGet(idCache, id)
  if (cached.hit) return cached.value
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first()
  const key = row ? rowKey(row) : null
  cacheSet(idCache, id, key)
  if (row && row.key_hash) cacheSet(hashCache, row.key_hash, key)
  return key
}

export async function authenticate(env, request, authMode = 'optional') {
  const token = parseBearer(request)
  if (!token) return authMode === 'required' ? { status: 'invalid' } : { status: 'none' }
  const hash = await hashKey(token)
  const key = await loadByHash(env, hash)
  if (!key || !key.enabled || isExpired(key)) return { status: 'invalid' }
  return { status: 'valid', key }
}

export async function listKeys(env) {
  const { results } = await env.DB.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all()
  return (results || []).map(rowKey)
}

export async function getKeyById(env, id) {
  return loadById(env, id)
}

export async function createKey(env, input) {
  const { plaintext, hash, prefix } = await generateKeyMaterial()
  const id = randomId('key_', 12)
  const now = nowSec()
  const name = input.name
  const quotaMode = input.quotaMode ?? input.quota_mode ?? 'unlimited'
  const quotaRulesInput = input.quotaRules ?? input.quota_rules
  const quotaRulesJson = Array.isArray(quotaRulesInput) ? JSON.stringify(normalizeRules(quotaRulesInput)) : null
  const enabled = input.enabled === undefined ? true : asBool(input.enabled)
  const expiresAt = input.expiresAt ?? input.expires_at ?? null
  const note = input.note ?? null
  await env.DB.prepare(
    `INSERT INTO api_keys
       (id, name, key_hash, key_prefix, quota_mode, quota_rules, enabled, expires_at, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, hash, prefix, quotaMode, quotaRulesJson, enabled ? 1 : 0, expiresAt, note, now, now)
    .run()
  invalidateKeyCache()
  const key = {
    id,
    name,
    keyPrefix: prefix,
    quotaMode,
    quotaRules: parseQuotaRules(quotaRulesJson),
    enabled,
    expiresAt,
    note,
    createdAt: now,
    updatedAt: now
  }
  return { key, plaintext }
}

export async function updateKey(env, id, patch) {
  const existing = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first()
  if (!existing) return null
  const fields = []
  const values = []
  if (patch.name !== undefined) {
    fields.push('name = ?')
    values.push(patch.name)
  }
  const quotaMode = patch.quotaMode ?? patch.quota_mode
  if (quotaMode !== undefined) {
    fields.push('quota_mode = ?')
    values.push(quotaMode)
  }
  if (patch.quotaRules !== undefined || patch.quota_rules !== undefined) {
    const rulesValue = patch.quotaRules ?? patch.quota_rules
    fields.push('quota_rules = ?')
    values.push(rulesValue === null ? null : JSON.stringify(normalizeRules(rulesValue)))
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(asBool(patch.enabled) ? 1 : 0)
  }
  if (patch.expiresAt !== undefined || patch.expires_at !== undefined) {
    fields.push('expires_at = ?')
    values.push(patch.expiresAt ?? patch.expires_at ?? null)
  }
  if (patch.note !== undefined) {
    fields.push('note = ?')
    values.push(patch.note)
  }
  if (!fields.length) return rowKey(existing)
  fields.push('updated_at = ?')
  values.push(nowSec())
  values.push(id)
  await env.DB.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  invalidateKeyCache()
  return loadById(env, id)
}

export async function deleteKey(env, id) {
  const res = await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run()
  invalidateKeyCache()
  return res.meta.changes > 0
}

export function keyScopes(key, ip) {
  const rules = (Array.isArray(key.quotaRules) ? key.quotaRules : []).filter((r) => r && r.enabled !== false)
  if (key.quotaMode === 'total') return [{ scope: `key:${key.id}`, rules }]
  if (key.quotaMode === 'per_ip') return [{ scope: `key:${key.id}:${ip}`, rules }]
  return []
}
