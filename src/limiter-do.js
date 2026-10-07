import {
  pickRotation,
  remainingForRules,
  retryAfterForRules,
  sumWindow
} from './limiter-core.js'

const LEASE_GRACE_MS = 30000
const INFLIGHT_WRITE_INTERVAL_MS = 1000
const MAX_ROTATION_KEYS = 20000

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS buckets (
    scope TEXT NOT NULL,
    window_seconds INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, window_seconds)
  )`,
  `CREATE TABLE IF NOT EXISTS inflight (
    ip TEXT PRIMARY KEY,
    leases TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rotations (
    rkey TEXT PRIMARY KEY,
    counter INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS key_ips_live (
    key_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    PRIMARY KEY (key_id, ip)
  )`
]

const MAX_KEY_IPS = 200

function keyIpsRowKey(keyId, ip) {
  return `${keyId}\u0000${ip}`
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asRules(value) {
  const rules = []
  for (const raw of asArray(value)) {
    const rule = asObject(raw)
    const windowSeconds = asNumber(rule.windowSeconds, 0)
    const limitChars = asNumber(rule.limitChars, NaN)
    if (!(windowSeconds > 0) || !Number.isFinite(limitChars)) continue
    rules.push({ windowSeconds, limitChars })
  }
  return rules
}

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

export class Limiter {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.buckets = new Map()
    this.leases = new Map()
    this.reservations = new Map()
    this.reservationSeq = 0
    this.rotations = new Map()
    this.liveKeyIps = new Map()
    this.keyIpsCount = new Map()
    this.dirtyBuckets = new Map()
    this.dirtyRotations = new Set()
    this.dirtyInflight = new Set()
    this.dirtyKeyIps = new Set()
    this.deletedKeyIps = new Set()
    this.lastInflightWrite = 0
    this.alarmAt = null
    this.ready = ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.sql.exec(statement)
      this.loadState()
      await this.refreshAlarm()
    })
  }

  loadState() {
    for (const row of this.sql.exec('SELECT scope, window_seconds, data FROM buckets').toArray()) {
      const scope = asString(row.scope)
      let windows = this.buckets.get(scope)
      if (!windows) {
        windows = {}
        this.buckets.set(scope, windows)
      }
      windows[String(row.window_seconds)] = this.parseEntries(row.data)
    }
    for (const row of this.sql.exec('SELECT ip, leases FROM inflight').toArray()) {
      const ip = asString(row.ip)
      const leases = this.parseLeases(row.leases)
      if (ip && leases.length > 0) this.leases.set(ip, leases)
    }
    for (const row of this.sql.exec('SELECT rkey, counter FROM rotations').toArray()) {
      this.rotations.set(asString(row.rkey), asNumber(row.counter, 0))
    }
    for (const row of this.sql.exec('SELECT key_id, ip, first_seen, last_seen, requests FROM key_ips_live').toArray()) {
      const keyId = asString(row.key_id)
      const ip = asString(row.ip)
      if (!keyId || !ip) continue
      this.liveKeyIps.set(keyIpsRowKey(keyId, ip), {
        keyId,
        ip,
        firstSeen: asNumber(row.first_seen, 0),
        lastSeen: asNumber(row.last_seen, 0),
        requests: asNumber(row.requests, 0)
      })
      this.keyIpsCount.set(keyId, (this.keyIpsCount.get(keyId) || 0) + 1)
    }
  }

  parseEntries(data) {
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && Number.isFinite(entry.ts) && Number.isFinite(entry.chars))
  }

  parseLeases(data) {
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((lease) => Number.isFinite(lease))
  }

  async fetch(request) {
    await this.ready
    const url = new URL(request.url)
    if (url.pathname !== '/rpc') return respond({ error: 'not_found' }, 404)
    if (request.method !== 'POST') return respond({ error: 'method_not_allowed' }, 405)
    let body
    try {
      body = await request.json()
    } catch {
      return respond({ error: 'invalid_json' }, 400)
    }
    if (!body || typeof body !== 'object') return respond({ error: 'invalid_body' }, 400)
    const params = asObject(body.params)
    switch (body.method) {
      case 'acquire':
        return respond(await this.acquire(params))
      case 'settle':
        return respond(await this.settle(params))
      case 'status':
        return respond(await this.status(params))
      case 'reset':
        return respond(await this.reset(params))
      case 'keyIps':
        return respond(await this.keyIps(params))
      default:
        return respond({ error: 'unknown_method' }, 400)
    }
  }

  async acquire(params) {
    const ip = asString(params.ip)
    const concurrencyLimit = Math.max(1, Math.floor(asNumber(params.concurrencyLimit, 1)))
    const reserveCap = Math.max(0, asNumber(params.reserveCap, Infinity))
    const maxDurationMs = Math.max(0, asNumber(params.maxDurationMs, 0))
    const keyId = asString(params.keyId)
    const now = Date.now()
    this.purge(now)
    if (keyId) this.touchKeyIp(keyId, ip, now)

    let leases = this.leases.get(ip)
    if (!leases) {
      leases = []
      this.leases.set(ip, leases)
    }
    const active = leases.filter((lease) => lease > now)
    if (active.length !== leases.length) {
      this.leases.set(ip, active)
      this.dirtyInflight.add(ip)
      leases = active
    }
    if (leases.length >= concurrencyLimit) {
      let retryAfterMs = Infinity
      for (const lease of leases) retryAfterMs = Math.min(retryAfterMs, lease - now)
      this.persist(now)
      return { ok: false, reason: 'concurrency', retryAfterMs: Math.max(0, retryAfterMs) }
    }

    const scopes = []
    for (const raw of asArray(params.scopes)) {
      const item = asObject(raw)
      if (typeof item.scope !== 'string' || item.scope.length === 0) continue
      const rules = asRules(item.rules)
      if (rules.length === 0) continue
      const windows = this.ensureScope(item.scope)
      for (const rule of rules) this.ensureWindow(item.scope, windows, rule.windowSeconds)
      scopes.push({ scope: item.scope, rules, windows })
    }

    let remaining = Infinity
    let minScope
    for (const item of scopes) {
      const value = remainingForRules(item.windows, item.rules, now)
      if (value < remaining) {
        remaining = value
        minScope = item.scope
      }
    }

    if (remaining <= 0) {
      const mergedWindows = {}
      const allRules = []
      for (const item of scopes) {
        allRules.push(...item.rules)
        for (const key of Object.keys(item.windows)) {
          mergedWindows[key] = (mergedWindows[key] || []).concat(item.windows[key])
        }
      }
      const retryAfterMs = retryAfterForRules(mergedWindows, allRules, now)
      this.persist(now)
      return { ok: false, reason: 'quota', retryAfterMs, scope: minScope }
    }

    const reserved = Math.min(remaining, reserveCap)
    const leaseUntil = now + maxDurationMs + LEASE_GRACE_MS
    this.reservationSeq += 1
    const reservationId = `${crypto.randomUUID()}#${this.reservationSeq}`
    for (const item of scopes) {
      for (const key of Object.keys(item.windows)) {
        const entries = item.windows[key]
        if (!Array.isArray(entries)) continue
        entries.push({ ts: now, chars: reserved, pending: reservationId })
        this.dirtyBuckets.set(`${item.scope}\u0000${key}`, [item.scope, key])
      }
    }
    this.reservations.set(reservationId, {
      ip,
      scopes: scopes.map((item) => item.scope),
      expiresAt: leaseUntil
    })
    leases.push(leaseUntil)
    this.dirtyInflight.add(ip)

    const rotations = this.resolveRotations(params.rotateKeys, ip)
    this.persist(now)
    await this.refreshAlarm()
    return { ok: true, reserved, rotations, reservationId }
  }

  async settle(params) {
    const ip = asString(params.ip)
    const used = Math.max(0, asNumber(params.used, 0))
    const reservationId = typeof params.reservationId === 'string' && params.reservationId ? params.reservationId : null
    const now = Date.now()
    if (reservationId) {
      const reservation = this.reservations.get(reservationId)
      this.reservations.delete(reservationId)
      const scopes = reservation ? reservation.scopes : [...this.buckets.keys()]
      this.applyReservationSettlement(scopes, reservationId, used)
    } else {
      for (const raw of asArray(params.scopes)) {
        if (typeof raw !== 'string') continue
        const windows = this.buckets.get(raw)
        if (!windows) continue
        for (const key of Object.keys(windows)) {
          if (!Array.isArray(windows[key])) continue
          windows[key].push({ ts: now, chars: used })
          this.dirtyBuckets.set(`${raw}\u0000${key}`, [raw, key])
        }
      }
    }
    if (ip) this.releaseEarliestLease(ip)
    this.persist(now, true)
    return { ok: true }
  }

  applyReservationSettlement(scopes, reservationId, used) {
    for (const scope of scopes) {
      const windows = this.buckets.get(scope)
      if (!windows) continue
      for (const key of Object.keys(windows)) {
        const entries = windows[key]
        if (!Array.isArray(entries)) continue
        let changed = false
        for (const entry of entries) {
          if (entry && entry.pending === reservationId) {
            entry.chars = used
            delete entry.pending
            changed = true
          }
        }
        if (changed) this.dirtyBuckets.set(`${scope}\u0000${key}`, [scope, key])
      }
    }
  }

  touchKeyIp(keyId, ip, now) {
    const rowKey = keyIpsRowKey(keyId, ip)
    let entry = this.liveKeyIps.get(rowKey)
    if (entry) {
      entry.requests += 1
      entry.lastSeen = now
    } else {
      entry = { keyId, ip, firstSeen: now, lastSeen: now, requests: 1 }
      this.liveKeyIps.set(rowKey, entry)
      this.keyIpsCount.set(keyId, (this.keyIpsCount.get(keyId) || 0) + 1)
    }
    this.dirtyKeyIps.add(rowKey)
    let count = this.keyIpsCount.get(keyId) || 0
    while (count > MAX_KEY_IPS) {
      let oldestKey = null
      let oldestSeen = Infinity
      for (const [candidateKey, candidate] of this.liveKeyIps) {
        if (candidate.keyId !== keyId) continue
        if (candidate.lastSeen < oldestSeen) {
          oldestSeen = candidate.lastSeen
          oldestKey = candidateKey
        }
      }
      if (oldestKey === null) break
      this.liveKeyIps.delete(oldestKey)
      this.dirtyKeyIps.delete(oldestKey)
      this.deletedKeyIps.add(oldestKey)
      count -= 1
    }
    this.keyIpsCount.set(keyId, count)
  }

  async keyIps(params) {
    const keyId = asString(params.keyId)
    if (!keyId) return []
    const list = []
    for (const entry of this.liveKeyIps.values()) {
      if (entry.keyId !== keyId) continue
      list.push({ ip: entry.ip, requests: entry.requests, lastSeen: entry.lastSeen })
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen)
    return list
  }

  async status(params) {
    const now = Date.now()
    const requested = Array.isArray(params.scopes)
      ? params.scopes.filter((scope) => typeof scope === 'string')
      : null
    const prefix = typeof params.scopePrefix === 'string' && params.scopePrefix ? params.scopePrefix : null
    let names = requested || [...this.buckets.keys()]
    if (prefix) {
      const seen = new Set(names)
      for (const scope of this.buckets.keys()) if (scope.startsWith(prefix)) seen.add(scope)
      names = [...seen]
    }
    const scopes = names.map((scope) => {
      const windows = this.buckets.get(scope) || {}
      const list = Object.keys(windows).map((key) => ({
        windowSeconds: Number(key),
        used: sumWindow(windows[key], now, Number(key) * 1000)
      }))
      return { scope, windows: list }
    })
    const inflight = {}
    const ip = asString(params.ip)
    const ips = ip ? [ip] : [...this.leases.keys()]
    for (const item of ips) {
      inflight[item] = (this.leases.get(item) || []).filter((lease) => lease > now).length
    }
    const rotations = {}
    for (const [rkey, counter] of this.rotations) rotations[rkey] = counter
    return { scopes, inflight, rotations }
  }

  deleteScope(scope) {
    this.buckets.delete(scope)
    for (const key of [...this.dirtyBuckets.keys()]) {
      if (this.dirtyBuckets.get(key)[0] === scope) this.dirtyBuckets.delete(key)
    }
    this.sql.exec('DELETE FROM buckets WHERE scope = ?', scope)
  }

  async reset(params) {
    const now = Date.now()
    for (const scope of asArray(params.scopes)) {
      if (typeof scope !== 'string') continue
      this.deleteScope(scope)
    }
    const prefix = typeof params.scopePrefix === 'string' && params.scopePrefix ? params.scopePrefix : null
    if (prefix) {
      for (const scope of [...this.buckets.keys()]) if (scope.startsWith(prefix)) this.deleteScope(scope)
    }
    const ip = asString(params.ip)
    if (ip) {
      this.leases.delete(ip)
      this.dirtyInflight.add(ip)
      for (const [id, reservation] of this.reservations) {
        if (reservation.ip === ip) this.reservations.delete(id)
      }
    }
    const keyId = asString(params.keyId)
    if (keyId) {
      for (const [rowKey, entry] of [...this.liveKeyIps]) {
        if (entry.keyId !== keyId) continue
        this.liveKeyIps.delete(rowKey)
        this.sql.exec('DELETE FROM key_ips_live WHERE key_id = ? AND ip = ?', entry.keyId, entry.ip)
      }
      this.keyIpsCount.delete(keyId)
    }
    for (const rkey of asArray(params.rotations)) {
      if (typeof rkey !== 'string') continue
      this.rotations.delete(rkey)
      this.dirtyRotations.delete(rkey)
      this.sql.exec('DELETE FROM rotations WHERE rkey = ?', rkey)
    }
    this.persist(now, true)
    return { ok: true }
  }

  async alarm() {
    await this.ready
    const now = Date.now()
    this.purge(now)
    for (const [ip, leases] of [...this.leases]) {
      const active = leases.filter((lease) => lease > now)
      if (active.length !== leases.length) this.dirtyInflight.add(ip)
      if (active.length > 0) this.leases.set(ip, active)
      else this.leases.delete(ip)
    }
    for (const [scope, windows] of [...this.buckets]) {
      for (const key of Object.keys(windows)) {
        if (!Array.isArray(windows[key]) || windows[key].length === 0) {
          delete windows[key]
          this.dirtyBuckets.delete(`${scope}\u0000${key}`)
          this.sql.exec('DELETE FROM buckets WHERE scope = ? AND window_seconds = ?', scope, Number(key))
        }
      }
      if (Object.keys(windows).length === 0) this.buckets.delete(scope)
    }
    this.persist(now, true)
    this.alarmAt = null
    await this.refreshAlarm()
  }

  ensureScope(scope) {
    let windows = this.buckets.get(scope)
    if (!windows) {
      windows = {}
      this.buckets.set(scope, windows)
    }
    return windows
  }

  ensureWindow(scope, windows, windowSeconds) {
    const key = String(windowSeconds)
    if (!Array.isArray(windows[key])) {
      windows[key] = []
      this.dirtyBuckets.set(`${scope}\u0000${key}`, [scope, key])
    }
  }

  purge(now) {
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) this.reservations.delete(id)
    }
    for (const [scope, windows] of this.buckets) {
      for (const key of Object.keys(windows)) {
        const entries = windows[key]
        if (!Array.isArray(entries) || entries.length === 0) continue
        const windowMs = Number(key) * 1000
        const kept = entries.filter((entry) => entry.ts > now - windowMs)
        if (kept.length !== entries.length) {
          windows[key] = kept
          this.dirtyBuckets.set(`${scope}\u0000${key}`, [scope, key])
        }
      }
    }
  }

  releaseEarliestLease(ip) {
    const leases = this.leases.get(ip)
    if (!leases || leases.length === 0) return
    let index = 0
    for (let i = 1; i < leases.length; i++) {
      if (leases[i] < leases[index]) index = i
    }
    leases.splice(index, 1)
    this.dirtyInflight.add(ip)
  }

  resolveRotations(rotateKeys, ip) {
    const rotations = {}
    for (const raw of asArray(rotateKeys)) {
      const item = asObject(raw)
      if (typeof item.key !== 'string' || item.key.length === 0) continue
      const options = asArray(item.options).filter((option) => typeof option === 'string')
      if (options.length === 0) continue
      const mode = item.mode === 'random' ? 'random' : 'cycle'
      const count = asNumber(item.count, options.length)
      const rkey = item.scope === 'ip' ? `r:${item.key}:ip:${ip}` : `r:${item.key}`
      if (!this.rotations.has(rkey) && this.rotations.size >= MAX_ROTATION_KEYS) continue
      const counter = this.rotations.get(rkey) || 0
      rotations[item.key] = pickRotation(mode, count, options, counter)
      this.rotations.set(rkey, counter + 1)
      this.dirtyRotations.add(rkey)
    }
    return rotations
  }

  persist(now, force = false) {
    for (const [scope, key] of this.dirtyBuckets.values()) {
      const windows = this.buckets.get(scope)
      const entries = windows && Array.isArray(windows[key]) ? windows[key] : []
      this.sql.exec(
        `INSERT INTO buckets (scope, window_seconds, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, window_seconds) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        scope,
        Number(key),
        JSON.stringify(entries),
        now
      )
    }
    this.dirtyBuckets.clear()
    for (const rkey of this.dirtyRotations) {
      this.sql.exec(
        `INSERT INTO rotations (rkey, counter) VALUES (?, ?)
         ON CONFLICT(rkey) DO UPDATE SET counter = excluded.counter`,
        rkey,
        this.rotations.get(rkey) || 0
      )
    }
    this.dirtyRotations.clear()
    if (!force && now - this.lastInflightWrite < INFLIGHT_WRITE_INTERVAL_MS) return
    for (const ip of this.dirtyInflight) {
      const leases = this.leases.get(ip)
      if (leases && leases.length > 0) {
        this.sql.exec(
          `INSERT INTO inflight (ip, leases) VALUES (?, ?)
           ON CONFLICT(ip) DO UPDATE SET leases = excluded.leases`,
          ip,
          JSON.stringify(leases)
        )
      } else {
        this.sql.exec('DELETE FROM inflight WHERE ip = ?', ip)
      }
    }
    this.dirtyInflight.clear()
    for (const rowKey of this.dirtyKeyIps) {
      const entry = this.liveKeyIps.get(rowKey)
      if (!entry) continue
      this.sql.exec(
        `INSERT INTO key_ips_live (key_id, ip, first_seen, last_seen, requests) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key_id, ip) DO UPDATE SET
           first_seen = excluded.first_seen,
           last_seen = excluded.last_seen,
           requests = excluded.requests`,
        entry.keyId,
        entry.ip,
        entry.firstSeen,
        entry.lastSeen,
        entry.requests
      )
    }
    this.dirtyKeyIps.clear()
    for (const rowKey of this.deletedKeyIps) {
      const sep = rowKey.indexOf('\u0000')
      if (sep < 0) continue
      this.sql.exec('DELETE FROM key_ips_live WHERE key_id = ? AND ip = ?', rowKey.slice(0, sep), rowKey.slice(sep + 1))
    }
    this.deletedKeyIps.clear()
    this.lastInflightWrite = now
  }

  nextLeaseTime() {
    let next = null
    for (const leases of this.leases.values()) {
      for (const lease of leases) {
        if (!Number.isFinite(lease)) continue
        if (next === null || lease < next) next = lease
      }
    }
    return next
  }

  async refreshAlarm() {
    const next = this.nextLeaseTime()
    if (next === null) return
    if (this.alarmAt !== null && this.alarmAt <= next) return
    await this.ctx.storage.setAlarm(next)
    this.alarmAt = next
  }
}
