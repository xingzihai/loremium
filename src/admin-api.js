import { json, parseIntOr, nowSec } from './util.js'
import {
  CONFIG_DEFAULTS,
  invalidateConfigCache,
  getConfig,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  replaceRules,
  listIpOverrides,
  upsertIpOverride,
  deleteIpOverride,
  listIpGroups,
  createIpGroup,
  updateIpGroup,
  deleteIpGroup,
  listIpGroupMembers,
  addIpGroupMembers,
  deleteIpGroupMember,
  resolveIpPolicy
} from './config.js'
import { listKeys, getKeyById, createKey, updateKey, deleteKey } from './keys.js'
import { overview, overviewToday, queryStats, keyUsage } from './stats.js'
import { status as limiterStatus, reset as limiterReset, keyIps as limiterKeyIps } from './limiter.js'
import { queryRequestLogs, requestLogIpSummary } from './logs.js'
import { validateProgram } from '../public/js/interpreter.js'
import { readBodyText, MAX_BODY_BYTES } from './openai.js'
import { ipScopeKey } from './ip-match.js'

const PREFIX = '/admin/api'

function ok(data) {
  return json({ ok: true, data })
}

function fail(error, status = 400) {
  return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status })
}

function notFound() {
  return json({ ok: false, error: 'not_found' }, { status: 404 })
}

async function readBody(request) {
  let text
  try {
    text = await readBodyText(request, MAX_BODY_BYTES)
  } catch {
    return null
  }
  if (!text || !text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj != null && obj[k] !== undefined) return obj[k]
  }
  return undefined
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

function ruleInput(b) {
  const out = {}
  const ws = pick(b, ['windowSeconds', 'window_seconds'])
  if (ws !== undefined) out.windowSeconds = toNum(ws)
  const lc = pick(b, ['limitChars', 'limit_chars'])
  if (lc !== undefined) out.limitChars = toNum(lc)
  if (b.enabled !== undefined) out.enabled = !!b.enabled
  if (b.note !== undefined) out.note = b.note
  return out
}

function rulesInput(arr) {
  return Array.isArray(arr) ? arr.map(ruleInput) : arr
}

function profileInput(b) {
  const out = {}
  if (b.name !== undefined) out.name = b.name
  const modelId = pick(b, ['modelId', 'model_id'])
  if (modelId !== undefined) out.modelId = modelId
  if (b.program !== undefined) out.program = b.program
  const isDefault = pick(b, ['isDefault', 'is_default'])
  if (isDefault !== undefined) out.isDefault = !!isDefault
  if (b.enabled !== undefined) out.enabled = !!b.enabled
  const firstDelay = pick(b, ['firstDelayMs', 'first_delay_ms'])
  if (firstDelay !== undefined) out.firstDelayMs = firstDelay === null || firstDelay === '' ? null : toNum(firstDelay)
  const charsPerSecond = pick(b, ['charsPerSecond', 'chars_per_second'])
  if (charsPerSecond !== undefined) out.charsPerSecond = charsPerSecond === null || charsPerSecond === '' ? null : toNum(charsPerSecond)
  return out
}

function overrideInput(b) {
  const out = {}
  if (b.concurrency !== undefined) out.concurrency = b.concurrency === null ? null : toNum(b.concurrency)
  if (b.rules !== undefined) out.rules = b.rules === null ? null : rulesInput(b.rules)
  const expiresAt = pick(b, ['expiresAt', 'expires_at'])
  if (expiresAt !== undefined) out.expiresAt = expiresAt === null ? null : toNum(expiresAt)
  if (b.note !== undefined) out.note = b.note
  return out
}

function groupInput(b) {
  const out = {}
  if (b.name !== undefined) out.name = b.name
  if (b.priority !== undefined) out.priority = toNum(b.priority)
  if (b.concurrency !== undefined) out.concurrency = b.concurrency === null ? null : toNum(b.concurrency)
  if (b.rules !== undefined) out.rules = b.rules === null ? null : rulesInput(b.rules)
  if (b.enabled !== undefined) out.enabled = !!b.enabled
  if (b.note !== undefined) out.note = b.note
  return out
}

function keyInput(b) {
  const out = {}
  if (b.name !== undefined) out.name = b.name
  const quotaMode = pick(b, ['quotaMode', 'quota_mode'])
  if (quotaMode !== undefined) out.quotaMode = quotaMode
  const quotaRules = pick(b, ['quotaRules', 'quota_rules'])
  if (quotaRules !== undefined) out.quotaRules = quotaRules === null ? null : rulesInput(quotaRules)
  const expiresAt = pick(b, ['expiresAt', 'expires_at'])
  if (expiresAt !== undefined) out.expiresAt = expiresAt === null ? null : toNum(expiresAt)
  if (b.note !== undefined) out.note = b.note
  if (b.enabled !== undefined) out.enabled = !!b.enabled
  return out
}

async function readConfigRaw(env) {
  const out = { ...CONFIG_DEFAULTS }
  const res = await env.DB.prepare('SELECT key, value FROM config').all()
  for (const row of res.results || []) out[row.key] = row.value
  return out
}

async function putConfig(request, env) {
  const body = await readBody(request)
  if (!body) return fail('invalid json')
  const stmts = []
  for (const [key, value] of Object.entries(body)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) continue
    stmts.push(
      env.DB.prepare(
        'INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).bind(key, String(value), nowSec())
    )
  }
  if (stmts.length) await env.DB.batch(stmts)
  invalidateConfigCache()
  return ok(await readConfigRaw(env))
}

function statsFilters(sp) {
  const filters = {}
  const from = sp.get('from')
  if (from) filters.from = from
  const to = sp.get('to')
  if (to) filters.to = to
  const ip = sp.get('ip')
  if (ip) filters.ip = ip
  const model = sp.get('model')
  if (model) filters.model = model
  const status = sp.get('status')
  if (status) filters.status = status
  const keyId = sp.get('key_id') || sp.get('keyId')
  if (keyId) filters.keyId = keyId
  const limit = sp.get('limit')
  if (limit) filters.limit = parseIntOr(limit, 100)
  return filters
}

function withLogNote(data, config) {
  if (config && config.requestLogEnabled) return data
  return {
    ...data,
    unavailable: true,
    note: '逐请求日志已关闭，统计为空；可在「行为」页开启「记录逐请求日志」。'
  }
}

async function keyScopeList(env, key) {
  if (key.quotaMode === 'total') return { scopes: [`key:${key.id}`] }
  if (key.quotaMode === 'per_ip') {
    const rows = await requestLogIpSummary(env, key.id, 50).catch(() => [])
    const ips = []
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row.ip === 'string' && row.ip) ips.push(row.ip)
      if (ips.length >= 50) break
    }
    return { scopes: ips.map((ip) => `key:${key.id}:${ip}`), scopePrefix: `key:${key.id}:` }
  }
  return { scopes: [] }
}

async function route(request, env, method, parts, url) {
  const a = parts[0]
  if (!a) return null

  if (a === 'overview' && method === 'GET') {
    const range = url.searchParams.get('range')
    const config = await getConfig(env)
    if (range === 'today') {
      return ok(withLogNote(await overviewToday(env, config.statsTzOffset), config))
    }
    const hours = parseIntOr(url.searchParams.get('hours'), 24)
    return ok(withLogNote(await overview(env, hours), config))
  }

  if (a === 'config') {
    if (method === 'GET') return ok(await readConfigRaw(env))
    if (method === 'PUT') return putConfig(request, env)
    return null
  }

  if (a === 'profiles') {
    const b = parts[1]
    if (b === undefined && method === 'GET') return ok(await listProfiles(env))
    if (b === undefined && method === 'POST') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      const input = profileInput(body)
      const checked = validateProgram(input.program)
      if (!checked.ok) return json({ ok: false, error: 'invalid_program', details: checked.errors }, { status: 400 })
      return ok(await createProfile(env, input))
    }
    if (b === 'validate' && method === 'POST') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      return ok(validateProgram(body.program))
    }
    if (b !== undefined && method === 'PUT') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      const input = profileInput(body)
      if (input.program !== undefined) {
        const checked = validateProgram(input.program)
        if (!checked.ok) return json({ ok: false, error: 'invalid_program', details: checked.errors }, { status: 400 })
      }
      return ok(await updateProfile(env, b, input))
    }
    if (b !== undefined && method === 'DELETE') {
      return ok((await deleteProfile(env, b)) ?? { deleted: true })
    }
    return null
  }

  if (a === 'rules') {
    const b = parts[1]
    if (b === undefined && method === 'GET') return ok(await listRules(env))
    if (b === undefined && method === 'POST') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      try {
        return ok(await createRule(env, ruleInput(body)))
      } catch (err) {
        return fail(err)
      }
    }
    if (b === undefined && method === 'PUT') {
      const body = await readBody(request)
      if (!body || !Array.isArray(body.rules)) return fail('invalid json')
      try {
        return ok(await replaceRules(env, body.rules))
      } catch (err) {
        return fail(err)
      }
    }
    if (b !== undefined && method === 'PUT') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      try {
        return ok(await updateRule(env, b, ruleInput(body)))
      } catch (err) {
        return fail(err)
      }
    }
    if (b !== undefined && method === 'DELETE') {
      return ok((await deleteRule(env, b)) ?? { deleted: true })
    }
    return null
  }

  if (a === 'ip-overrides') {
    const b = parts[1]
    if (b === undefined && method === 'GET') return ok(await listIpOverrides(env))
    if (b !== undefined && method === 'PUT') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      return ok(await upsertIpOverride(env, b, overrideInput(body)))
    }
    if (b !== undefined && method === 'DELETE') {
      return ok((await deleteIpOverride(env, b)) ?? { deleted: true })
    }
    return null
  }

  if (a === 'ip-groups') {
    const b = parts[1]
    const c = parts[2]
    if (b === undefined && method === 'GET') return ok(await listIpGroups(env))
    if (b === undefined && method === 'POST') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      return ok(await createIpGroup(env, groupInput(body)))
    }
    if (b !== undefined && c === undefined) {
      if (method === 'PUT') {
        const body = await readBody(request)
        if (!body) return fail('invalid json')
        return ok(await updateIpGroup(env, b, groupInput(body)))
      }
      if (method === 'DELETE') {
        return ok({ deleted: await deleteIpGroup(env, b) })
      }
      return null
    }
    if (b !== undefined && c === 'members') {
      const d = parts[3]
      if (d === undefined && method === 'GET') {
        const members = await listIpGroupMembers(env, b)
        if (members === null) return fail('group_not_found', 404)
        return ok(members)
      }
      if (d === undefined && method === 'POST') {
        const body = await readBody(request)
        if (!body || !Array.isArray(body.values)) return fail('invalid json')
        const result = await addIpGroupMembers(env, b, body.values)
        if (result === null) return fail('group_not_found', 404)
        return ok(result)
      }
      if (d !== undefined && method === 'DELETE') {
        return ok({ deleted: await deleteIpGroupMember(env, b, d) })
      }
      return null
    }
    return null
  }

  if (a === 'ip-policy' && parts[1] === 'resolve' && method === 'GET') {
    const ip = url.searchParams.get('ip')
    if (!ip) return fail('missing ip')
    const config = await getConfig(env)
    const scopeKey = ipScopeKey(ip)
    const policy = await resolveIpPolicy(env, ip, config)
    const st = await limiterStatus(env, { scopes: [`ip:${scopeKey}`], ip: scopeKey })
    const scopeRow = (st.scopes || []).find((s) => s.scope === `ip:${scopeKey}`)
    const windows = (scopeRow && scopeRow.windows ? scopeRow.windows : []).map((w) => ({
      windowSeconds: w.windowSeconds,
      used: w.used
    }))
    let remaining = Infinity
    let retryAfterMs = 0
    for (const rule of policy.rules) {
      const row = windows.find((w) => w.windowSeconds === rule.windowSeconds)
      const used = row ? row.used : 0
      const left = rule.limitChars - used
      if (left < remaining) remaining = left
      if (left <= 0) retryAfterMs = Math.max(retryAfterMs, rule.windowSeconds * 1000)
    }
    return ok({
      ...policy,
      scopeKey,
      status: {
        inflight: (st.inflight && st.inflight[scopeKey]) || 0,
        windows,
        retryAfterMs: remaining > 0 ? 0 : retryAfterMs
      }
    })
  }

  if (a === 'ip') {
    const ip = parts[1]
    const action = parts[2]
    if (!ip || !action) return null
    const scopeKey = ipScopeKey(ip)
    if (action === 'status' && method === 'GET') {
      return ok(await limiterStatus(env, { scopes: [`ip:${scopeKey}`], ip: scopeKey }))
    }
    if (action === 'reset' && method === 'POST') {
      return ok(await limiterReset(env, { scopes: [`ip:${scopeKey}`], ip: scopeKey }))
    }
    return null
  }

  if (a === 'api-keys') {
    const id = parts[1]
    const action = parts[2]
    if (id === undefined && method === 'GET') return ok(await listKeys(env))
    if (id === undefined && method === 'POST') {
      const body = await readBody(request)
      if (!body) return fail('invalid json')
      const { key, plaintext } = await createKey(env, keyInput(body))
      return ok({
        ...key,
        key: plaintext,
        key_prefix: key.keyPrefix,
        quota_mode: key.quotaMode,
        quota_rules: key.quotaRules,
        expires_at: key.expiresAt
      })
    }
    if (id !== undefined && action === undefined) {
      if (method === 'PUT') {
        const body = await readBody(request)
        if (!body) return fail('invalid json')
        return ok(await updateKey(env, id, keyInput(body)))
      }
      if (method === 'DELETE') {
        const deleted = await deleteKey(env, id)
        if (deleted) {
          try {
            await limiterReset(env, { scopes: [`key:${id}`], scopePrefix: `key:${id}:`, keyId: id })
          } catch {}
        }
        return ok(deleted ?? { deleted: true })
      }
      return null
    }
    if (id !== undefined && action) {
      const key = await getKeyById(env, id)
      if (!key) return fail('key_not_found', 404)
      if (action === 'status' && method === 'GET') {
        const { scopes, scopePrefix } = await keyScopeList(env, key)
        return ok(await limiterStatus(env, { scopes, scopePrefix }))
      }
      if (action === 'reset' && method === 'POST') {
        const { scopes, scopePrefix } = await keyScopeList(env, key)
        return ok(await limiterReset(env, { scopes, scopePrefix }))
      }
      if (action === 'usage' && method === 'GET') {
        const days = parseIntOr(url.searchParams.get('days'), 7)
        const config = await getConfig(env)
        return ok(withLogNote(await keyUsage(env, id, days), config))
      }
      if (action === 'ips' && method === 'GET') {
        const limit = parseIntOr(url.searchParams.get('limit'), 100)
        const logged = await requestLogIpSummary(env, id, limit).catch(() => [])
        const live = await limiterKeyIps(env, { keyId: id }).catch(() => [])
        const merged = new Map()
        for (const row of logged) {
          if (!row || typeof row.ip !== 'string') continue
          merged.set(row.ip, { ip: row.ip, requests: row.requests, chars: row.chars ?? null, firstSeen: row.firstSeen ?? null, lastSeen: row.lastSeen, live: false })
        }
        for (const row of live) {
          if (!row || typeof row.ip !== 'string') continue
          const existing = merged.get(row.ip)
          merged.set(row.ip, { ...(existing || {}), ip: row.ip, requests: row.requests, lastSeen: row.lastSeen, live: true })
        }
        const data = [...merged.values()].sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0)).slice(0, limit)
        return ok(data)
      }
      return null
    }
    return null
  }

  if (a === 'logs' && method === 'GET') {
    const filters = {}
    const keyId = url.searchParams.get('key_id') || url.searchParams.get('keyId')
    if (keyId) filters.keyId = keyId
    const ip = url.searchParams.get('ip')
    if (ip) filters.ip = ip
    const before = parseIntOr(url.searchParams.get('before'), NaN)
    if (Number.isFinite(before)) filters.before = before
    filters.limit = parseIntOr(url.searchParams.get('limit'), 100)
    return ok(await queryRequestLogs(env, filters))
  }

  if (a === 'stats' && method === 'GET') {
    return ok(await queryStats(env, statsFilters(url.searchParams)))
  }

  return null
}

export async function handleAdminApi(request, env, ctx) {
  const url = new URL(request.url)
  let path = url.pathname
  if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length)
  if (!path.startsWith('/')) path = '/' + path
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  const method = request.method.toUpperCase()
  try {
    const res = await route(request, env, method, parts, url)
    return res || notFound()
  } catch (err) {
    return fail(err, 400)
  }
}
