import { nowSec, parseIntOr, randomId } from './util.js'
import { ipMatchesEntry, normalizeEntry, parseIpEntry } from './ip-match.js'

export const CONFIG_DEFAULTS = {
  first_delay_ms: '300',
  chars_per_second: '30',
  chunk_size: '4',
  max_duration_s: '120',
  max_output_chars: '32000',
  concurrency_limit: '2',
  over_limit_behavior: 'truncate',
  default_model: 'loremium-unicode',
  strict_model: 'false',
  cors_origin: '*',
  auth_mode: 'optional',
  unlisted_ip_policy: 'allow',
  stats_tz_offset: '480',
  request_log_enabled: 'true',
  request_log_retention_days: '7'
}

const CACHE_TTL_MS = 0
const cacheStore = {
  config: { value: null, expires: 0 },
  profiles: { value: null, expires: 0 },
  rules: { value: null, expires: 0 }
}

function cacheGet(name) {
  const entry = cacheStore[name]
  if (entry.value !== null && Date.now() < entry.expires) return entry.value
  return null
}

function cacheSet(name, value) {
  cacheStore[name] = { value, expires: Date.now() + CACHE_TTL_MS }
}

function cacheClear(name) {
  cacheStore[name] = { value: null, expires: 0 }
}

export function invalidateConfigCache() {
  cacheClear('config')
  cacheClear('profiles')
  cacheClear('rules')
}

function toNum(v, def) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function field(obj, camel, snake) {
  if (obj == null) return undefined
  if (obj[camel] !== undefined) return obj[camel]
  if (snake !== undefined && obj[snake] !== undefined) return obj[snake]
  return undefined
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeConfig(raw) {
  return {
    firstDelayMs: parseIntOr(raw.first_delay_ms, 300),
    charsPerSecond: toNum(raw.chars_per_second, 30),
    chunkSize: parseIntOr(raw.chunk_size, 4),
    maxDurationMs: toNum(raw.max_duration_s, 120) * 1000,
    maxOutputChars: parseIntOr(raw.max_output_chars, 32000),
    concurrencyLimit: parseIntOr(raw.concurrency_limit, 2),
    overLimitBehavior: raw.over_limit_behavior || 'truncate',
    defaultModel: raw.default_model || 'loremium-unicode',
    strictModel: toBool(raw.strict_model),
    corsOrigin: raw.cors_origin ?? '*',
    authMode: raw.auth_mode || 'optional',
    unlistedIpPolicy: raw.unlisted_ip_policy === 'deny' ? 'deny' : 'allow',
    statsTzOffset: parseIntOr(raw.stats_tz_offset, 480),
    requestLogEnabled: toBool(raw.request_log_enabled),
    requestLogRetentionDays: parseIntOr(raw.request_log_retention_days, 7)
  }
}

export async function getConfig(env) {
  const cached = cacheGet('config')
  if (cached) return cached
  const { results } = await env.DB.prepare('SELECT key, value FROM config').all()
  const raw = { ...CONFIG_DEFAULTS }
  for (const row of results || []) raw[row.key] = row.value
  const config = normalizeConfig(raw)
  cacheSet('config', config)
  return config
}

function parseProgram(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function programJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

function rowProfile(r) {
  return {
    id: r.id,
    name: r.name,
    modelId: r.model_id,
    program: parseProgram(r.program),
    isDefault: !!r.is_default,
    enabled: !!r.enabled,
    firstDelayMs: r.first_delay_ms ?? null,
    charsPerSecond: r.chars_per_second ?? null,
    updatedAt: r.updated_at
  }
}

export async function listProfiles(env) {
  const cached = cacheGet('profiles')
  if (cached) return cached
  const { results } = await env.DB.prepare('SELECT * FROM profiles ORDER BY is_default DESC, id').all()
  const profiles = (results || []).map(rowProfile)
  cacheSet('profiles', profiles)
  return profiles
}

export async function getProfileByModel(env, model) {
  const profiles = await listProfiles(env)
  return profiles.find((p) => p.modelId === model) || null
}

export async function getProfileById(env, id) {
  const profiles = await listProfiles(env)
  return profiles.find((p) => p.id === id) || null
}

export async function createProfile(env, input) {
  const id = input.id || randomId('p_', 12)
  const name = input.name
  const modelId = field(input, 'modelId', 'model_id')
  const program = field(input, 'program') ?? {}
  const isDefault = toBool(field(input, 'isDefault', 'is_default'))
  const enabled = input.enabled === undefined ? true : toBool(input.enabled)
  const firstDelayMs = optionalNumber(field(input, 'firstDelayMs', 'first_delay_ms'))
  const charsPerSecond = optionalNumber(field(input, 'charsPerSecond', 'chars_per_second'))
  const now = nowSec()
  await env.DB.prepare(
    `INSERT INTO profiles (id, name, model_id, program, is_default, enabled, first_delay_ms, chars_per_second, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, modelId, programJson(program), isDefault ? 1 : 0, enabled ? 1 : 0, firstDelayMs, charsPerSecond, now)
    .run()
  if (isDefault) {
    await env.DB.prepare('UPDATE profiles SET is_default = 0 WHERE id != ?').bind(id).run()
  }
  invalidateConfigCache()
  return { id, name, modelId, program: parseProgram(program), isDefault, enabled, firstDelayMs, charsPerSecond, updatedAt: now }
}

export async function updateProfile(env, id, patch) {
  const existing = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first()
  if (!existing) return null
  const fields = []
  const values = []
  if (patch.name !== undefined) {
    fields.push('name = ?')
    values.push(patch.name)
  }
  const modelId = field(patch, 'modelId', 'model_id')
  if (modelId !== undefined) {
    fields.push('model_id = ?')
    values.push(modelId)
  }
  const program = field(patch, 'program')
  if (program !== undefined) {
    fields.push('program = ?')
    values.push(programJson(program))
  }
  const hasDefault = patch.isDefault !== undefined || patch.is_default !== undefined
  const isDefault = toBool(field(patch, 'isDefault', 'is_default'))
  if (hasDefault) {
    fields.push('is_default = ?')
    values.push(isDefault ? 1 : 0)
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(toBool(patch.enabled) ? 1 : 0)
  }
  const firstDelayRaw = field(patch, 'firstDelayMs', 'first_delay_ms')
  if (firstDelayRaw !== undefined) {
    fields.push('first_delay_ms = ?')
    values.push(optionalNumber(firstDelayRaw))
  }
  const charsPerSecondRaw = field(patch, 'charsPerSecond', 'chars_per_second')
  if (charsPerSecondRaw !== undefined) {
    fields.push('chars_per_second = ?')
    values.push(optionalNumber(charsPerSecondRaw))
  }
  if (!fields.length) return rowProfile(existing)
  fields.push('updated_at = ?')
  values.push(nowSec())
  values.push(id)
  await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  if (hasDefault && isDefault) {
    await env.DB.prepare('UPDATE profiles SET is_default = 0 WHERE id != ?').bind(id).run()
  }
  invalidateConfigCache()
  const row = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first()
  return rowProfile(row)
}

export async function deleteProfile(env, id) {
  const row = await env.DB.prepare('SELECT id, is_default FROM profiles WHERE id = ?').bind(id).first()
  if (!row) return false
  if (row.is_default) throw new Error('cannot delete default profile')
  await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run()
  invalidateConfigCache()
  return true
}

function rowRule(r) {
  return {
    id: r.id,
    windowSeconds: r.window_seconds,
    limitChars: r.limit_chars,
    enabled: !!r.enabled,
    note: r.note ?? null
  }
}

export async function listRules(env) {
  const cached = cacheGet('rules')
  if (cached) return cached
  const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY id').all()
  const rules = (results || []).map(rowRule)
  cacheSet('rules', rules)
  return rules
}

export async function getEnabledRules(env) {
  const rules = await listRules(env)
  return rules
    .filter((r) => r.enabled)
    .map((r) => ({ windowSeconds: r.windowSeconds, limitChars: r.limitChars }))
}

function ruleValues(input) {
  const windowSeconds = Number(field(input, 'windowSeconds', 'window_seconds'))
  const limitChars = Number(field(input, 'limitChars', 'limit_chars'))
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('invalid_rule_window')
  if (!Number.isFinite(limitChars) || limitChars < 0) throw new Error('invalid_rule_limit')
  return { windowSeconds: Math.round(windowSeconds), limitChars: Math.round(limitChars) }
}

export async function createRule(env, input) {
  const { windowSeconds, limitChars } = ruleValues(input)
  const enabled = input.enabled === undefined ? true : toBool(input.enabled)
  const note = input.note ?? null
  const res = await env.DB.prepare(
    'INSERT INTO rules (window_seconds, limit_chars, enabled, note) VALUES (?, ?, ?, ?)'
  )
    .bind(windowSeconds, limitChars, enabled ? 1 : 0, note)
    .run()
  invalidateConfigCache()
  return { id: res.meta.last_row_id, windowSeconds, limitChars, enabled, note }
}

export async function updateRule(env, id, patch) {
  const existing = await env.DB.prepare('SELECT * FROM rules WHERE id = ?').bind(id).first()
  if (!existing) return null
  const fields = []
  const values = []
  const windowRaw = field(patch, 'windowSeconds', 'window_seconds')
  if (windowRaw !== undefined) {
    const windowSeconds = Number(windowRaw)
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('invalid_rule_window')
    fields.push('window_seconds = ?')
    values.push(Math.round(windowSeconds))
  }
  const limitRaw = field(patch, 'limitChars', 'limit_chars')
  if (limitRaw !== undefined) {
    const limitChars = Number(limitRaw)
    if (!Number.isFinite(limitChars) || limitChars < 0) throw new Error('invalid_rule_limit')
    fields.push('limit_chars = ?')
    values.push(Math.round(limitChars))
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(toBool(patch.enabled) ? 1 : 0)
  }
  if (patch.note !== undefined) {
    fields.push('note = ?')
    values.push(patch.note)
  }
  if (!fields.length) return rowRule(existing)
  values.push(id)
  await env.DB.prepare(`UPDATE rules SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  invalidateConfigCache()
  const row = await env.DB.prepare('SELECT * FROM rules WHERE id = ?').bind(id).first()
  return rowRule(row)
}

export async function deleteRule(env, id) {
  const res = await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run()
  invalidateConfigCache()
  return res.meta.changes > 0
}

export async function replaceRules(env, rules) {
  const list = Array.isArray(rules) ? rules : []
  const statements = [env.DB.prepare('DELETE FROM rules')]
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const windowSeconds = Number(field(raw, 'windowSeconds', 'window_seconds'))
    const limitChars = Number(field(raw, 'limitChars', 'limit_chars'))
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('invalid_rule_window')
    if (!Number.isFinite(limitChars) || limitChars < 0) throw new Error('invalid_rule_limit')
    const enabled = raw.enabled === undefined ? true : toBool(raw.enabled)
    const note = raw.note ?? null
    const id = raw.id == null ? null : Number(raw.id)
    if (id != null && Number.isFinite(id)) {
      statements.push(
        env.DB.prepare('INSERT INTO rules (id, window_seconds, limit_chars, enabled, note) VALUES (?, ?, ?, ?, ?)')
          .bind(id, Math.round(windowSeconds), Math.round(limitChars), enabled ? 1 : 0, note)
      )
    } else {
      statements.push(
        env.DB.prepare('INSERT INTO rules (window_seconds, limit_chars, enabled, note) VALUES (?, ?, ?, ?)')
          .bind(Math.round(windowSeconds), Math.round(limitChars), enabled ? 1 : 0, note)
      )
    }
  }
  await env.DB.batch(statements)
  invalidateConfigCache()
  return listRules(env)
}

function parseRules(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function rowIpOverride(r) {
  return {
    ip: r.ip,
    concurrency: r.concurrency ?? null,
    rules: parseRules(r.rules),
    expiresAt: r.expires_at ?? null,
    note: r.note ?? null
  }
}

export async function getIpOverride(env, ip) {
  const row = await env.DB.prepare('SELECT * FROM ip_overrides WHERE ip = ?').bind(ip).first()
  if (!row) return null
  if (row.expires_at != null && row.expires_at <= nowSec()) return null
  return rowIpOverride(row)
}

export async function listIpOverrides(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ip_overrides WHERE expires_at IS NULL OR expires_at > ? ORDER BY ip'
  )
    .bind(nowSec())
    .all()
  return (results || []).map(rowIpOverride)
}

export async function upsertIpOverride(env, ip, input) {
  const concurrency = field(input, 'concurrency') ?? null
  const rulesValue = field(input, 'rules')
  let rules = null
  if (rulesValue !== undefined && rulesValue !== null) {
    rules = typeof rulesValue === 'string' ? rulesValue : JSON.stringify(rulesValue)
  }
  const expiresAt = field(input, 'expiresAt', 'expires_at') ?? null
  const note = field(input, 'note') ?? null
  await env.DB.prepare(
    `INSERT INTO ip_overrides (ip, concurrency, rules, expires_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       concurrency = excluded.concurrency,
       rules = excluded.rules,
       expires_at = excluded.expires_at,
       note = excluded.note`
  )
    .bind(ip, concurrency, rules, expiresAt, note, nowSec())
    .run()
  return { ip, concurrency, rules: parseRules(rules), expiresAt, note }
}

export async function deleteIpOverride(env, ip) {
  const res = await env.DB.prepare('DELETE FROM ip_overrides WHERE ip = ?').bind(ip).run()
  return res.meta.changes > 0
}

function normalizeRuleList(rules) {
  if (!Array.isArray(rules)) return []
  const out = []
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue
    const windowSeconds = Number(raw.windowSeconds ?? raw.window_seconds)
    const limitChars = Number(raw.limitChars ?? raw.limit_chars)
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || !Number.isFinite(limitChars)) continue
    out.push({ windowSeconds, limitChars })
  }
  return out
}

function rowIpGroup(r, memberCount = 0) {
  const parsed = parseRules(r.rules)
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    concurrency: r.concurrency ?? null,
    rules: parsed ? normalizeRuleList(parsed) : null,
    enabled: !!r.enabled,
    note: r.note ?? null,
    memberCount: r.member_count ?? memberCount
  }
}

export async function listIpGroups(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM ip_group_members m WHERE m.group_id = g.id) AS member_count
     FROM ip_groups g
     ORDER BY g.priority ASC, g.created_at ASC, g.id ASC`
  ).all()
  return (results || []).map((r) => rowIpGroup(r))
}

export async function getIpGroup(env, id) {
  const row = await env.DB.prepare('SELECT * FROM ip_groups WHERE id = ?').bind(id).first()
  if (!row) return null
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ip_group_members WHERE group_id = ?').bind(id).first()
  return rowIpGroup(row, count ? count.n : 0)
}

export async function createIpGroup(env, input) {
  const id = input.id || randomId('g_', 12)
  const name = input.name === undefined || input.name === null ? '' : String(input.name)
  const priority = parseIntOr(input.priority, 100)
  const concurrencyValue = input.concurrency === undefined || input.concurrency === null ? null : Number(input.concurrency)
  const concurrency = Number.isFinite(concurrencyValue) ? concurrencyValue : null
  const rules = input.rules === undefined || input.rules === null ? null : JSON.stringify(normalizeRuleList(input.rules))
  const enabled = input.enabled === undefined ? true : toBool(input.enabled)
  const note = input.note ?? null
  const now = nowSec()
  await env.DB.prepare(
    `INSERT INTO ip_groups (id, name, priority, concurrency, rules, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, priority, concurrency, rules, enabled ? 1 : 0, note, now, now)
    .run()
  return getIpGroup(env, id)
}

export async function updateIpGroup(env, id, patch) {
  const existing = await env.DB.prepare('SELECT * FROM ip_groups WHERE id = ?').bind(id).first()
  if (!existing) return null
  const fields = []
  const values = []
  if (patch.name !== undefined) {
    fields.push('name = ?')
    values.push(String(patch.name))
  }
  if (patch.priority !== undefined) {
    fields.push('priority = ?')
    values.push(parseIntOr(patch.priority, 100))
  }
  if (patch.concurrency !== undefined) {
    const c = patch.concurrency === null ? null : Number(patch.concurrency)
    fields.push('concurrency = ?')
    values.push(Number.isFinite(c) ? c : null)
  }
  if (patch.rules !== undefined) {
    fields.push('rules = ?')
    values.push(patch.rules === null ? null : JSON.stringify(normalizeRuleList(patch.rules)))
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(toBool(patch.enabled) ? 1 : 0)
  }
  if (patch.note !== undefined) {
    fields.push('note = ?')
    values.push(patch.note)
  }
  if (!fields.length) return getIpGroup(env, id)
  fields.push('updated_at = ?')
  values.push(nowSec())
  values.push(id)
  await env.DB.prepare(`UPDATE ip_groups SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  return getIpGroup(env, id)
}

export async function deleteIpGroup(env, id) {
  const res = await env.DB.prepare('DELETE FROM ip_groups WHERE id = ?').bind(id).run()
  if (!res.meta.changes) return false
  await env.DB.prepare('DELETE FROM ip_group_members WHERE group_id = ?').bind(id).run()
  return true
}

export async function listIpGroupMembers(env, groupId) {
  const group = await env.DB.prepare('SELECT id FROM ip_groups WHERE id = ?').bind(groupId).first()
  if (!group) return null
  const { results } = await env.DB.prepare(
    'SELECT id, value, kind FROM ip_group_members WHERE group_id = ? ORDER BY id'
  )
    .bind(groupId)
    .all()
  return (results || []).map((r) => ({ id: r.id, value: r.value, kind: r.kind }))
}

export async function addIpGroupMembers(env, groupId, values) {
  const group = await env.DB.prepare('SELECT id FROM ip_groups WHERE id = ?').bind(groupId).first()
  if (!group) return null
  const added = []
  const invalid = []
  const seen = new Set()
  const now = nowSec()
  for (const raw of Array.isArray(values) ? values : []) {
    const entry = parseIpEntry(raw)
    if (!entry) {
      invalid.push(raw)
      continue
    }
    added.push(entry.value)
    if (seen.has(entry.value)) continue
    seen.add(entry.value)
    await env.DB.prepare(
      `INSERT INTO ip_group_members (group_id, value, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, value) DO NOTHING`
    )
      .bind(groupId, entry.value, entry.kind, now)
      .run()
  }
  return { added, invalid }
}

export async function deleteIpGroupMember(env, groupId, value) {
  const candidates = new Set()
  if (typeof value === 'string') candidates.add(value)
  const normalized = normalizeEntry(value)
  if (normalized) candidates.add(normalized)
  let deleted = false
  for (const candidate of candidates) {
    const res = await env.DB.prepare('DELETE FROM ip_group_members WHERE group_id = ? AND value = ?')
      .bind(groupId, candidate)
      .run()
    if (res.meta.changes > 0) deleted = true
  }
  return deleted
}

async function enabledGroupsWithMembers(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.priority, g.concurrency, g.rules, g.created_at, m.value, m.kind
     FROM ip_groups g
     JOIN ip_group_members m ON m.group_id = g.id
     WHERE g.enabled = 1
     ORDER BY g.priority ASC, g.created_at ASC, g.id ASC`
  ).all()
  const groups = new Map()
  for (const row of results || []) {
    let group = groups.get(row.id)
    if (!group) {
      group = { id: row.id, name: row.name, concurrency: row.concurrency, rules: parseRules(row.rules), members: [] }
      groups.set(row.id, group)
    }
    group.members.push({ kind: row.kind, value: row.value })
  }
  return [...groups.values()]
}

export async function resolveIpPolicy(env, ip, config) {
  const unlistedPolicy = config.unlistedIpPolicy === 'deny' ? 'deny' : 'allow'
  const globalRules = await getEnabledRules(env)
  const override = await getIpOverride(env, ip)
  if (override) {
    const overrideRules = normalizeRuleList(override.rules)
    return {
      allowed: true,
      source: 'override',
      rules: overrideRules.length > 0 ? overrideRules : globalRules,
      concurrency: Number.isFinite(override.concurrency) ? override.concurrency : config.concurrencyLimit,
      unlistedPolicy
    }
  }
  if (typeof ip === 'string' && ip.length > 0) {
    for (const group of await enabledGroupsWithMembers(env)) {
      if (!group.members.some((member) => ipMatchesEntry(ip, member))) continue
      const groupRules = normalizeRuleList(group.rules)
      return {
        allowed: true,
        source: 'group',
        groupId: group.id,
        groupName: group.name,
        rules: groupRules.length > 0 ? groupRules : globalRules,
        concurrency: Number.isFinite(group.concurrency) ? group.concurrency : config.concurrencyLimit,
        unlistedPolicy
      }
    }
  }
  if (unlistedPolicy === 'deny') {
    return {
      allowed: false,
      source: 'unlisted',
      rules: [],
      concurrency: config.concurrencyLimit,
      unlistedPolicy
    }
  }
  return {
    allowed: true,
    source: 'global',
    rules: globalRules,
    concurrency: config.concurrencyLimit,
    unlistedPolicy
  }
}
