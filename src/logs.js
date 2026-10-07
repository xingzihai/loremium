import { nowSec } from './util.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const RETENTION_DAYS = 7
const DAY_SECONDS = 86400

const INSERT_SQL = `INSERT INTO request_logs
  (created_at, key_id, ip, model, profile, status, finish_reason, input_tokens, output_tokens, duration_ms, ttft_ms, is_stream)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const SELECT_SQL = `SELECT id, created_at, key_id, ip, model, profile, status, finish_reason, input_tokens, output_tokens, duration_ms, ttft_ms, is_stream FROM request_logs`

function num(v, def = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function nonNeg(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function rowLog(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    keyId: r.key_id ?? null,
    ip: r.ip,
    model: r.model,
    profile: r.profile ?? null,
    status: r.status,
    finishReason: r.finish_reason ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    durationMs: r.duration_ms,
    ttftMs: r.ttft_ms,
    isStream: r.is_stream === 1
  }
}

export function normalizeRequestLog(event) {
  const e = event ?? {}
  return {
    created_at: e.createdAt ?? nowSec(),
    key_id: e.keyId ?? null,
    ip: String(e.ip ?? ''),
    model: String(e.model ?? ''),
    profile: e.profile ?? null,
    status: num(e.status, 0),
    finish_reason: e.finishReason ?? null,
    input_tokens: nonNeg(e.inputTokens),
    output_tokens: nonNeg(e.outputTokens),
    duration_ms: nonNeg(e.durationMs),
    ttft_ms: nonNeg(e.ttftMs),
    is_stream: e.isStream ? 1 : 0
  }
}

export async function writeRequestLog(env, ctx, event) {
  if (!env || !env.DB) return
  try {
    const row = normalizeRequestLog(event)
    const pending = env.DB.prepare(INSERT_SQL)
      .bind(
        row.created_at,
        row.key_id,
        row.ip,
        row.model,
        row.profile,
        row.status,
        row.finish_reason,
        row.input_tokens,
        row.output_tokens,
        row.duration_ms,
        row.ttft_ms,
        row.is_stream
      )
      .run()
    const guarded = Promise.resolve(pending).then(
      () => undefined,
      () => undefined
    )
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(guarded)
      return
    }
    await guarded
  } catch {
    return
  }
}

export async function queryRequestLogs(env, filters = {}) {
  const conditions = []
  const params = []
  if (filters.keyId) {
    conditions.push('key_id = ?')
    params.push(filters.keyId)
  }
  if (filters.ip) {
    conditions.push('ip = ?')
    params.push(filters.ip)
  }
  if (filters.before !== undefined && filters.before !== null && filters.before !== '') {
    const before = Number(filters.before)
    if (Number.isFinite(before)) {
      conditions.push('id < ?')
      params.push(before)
    }
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(num(filters.limit, DEFAULT_LIMIT))))
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const { results } = await env.DB.prepare(`${SELECT_SQL}${where} ORDER BY id DESC LIMIT ?`)
    .bind(...params, limit)
    .all()
  const items = (results || []).map(rowLog)
  const last = items[items.length - 1]
  const nextBefore = items.length === limit && last ? last.id : null
  return { items, nextBefore }
}

export async function cleanupRequestLogs(env, retentionDays) {
  if (!env || !env.DB) return { deleted: 0 }
  const days = num(retentionDays, RETENTION_DAYS)
  const effective = days > 0 ? days : RETENTION_DAYS
  const cutoff = nowSec() - effective * DAY_SECONDS
  const res = await env.DB.prepare('DELETE FROM request_logs WHERE created_at < ?').bind(cutoff).run()
  return { deleted: res.meta.changes }
}

export async function requestLogIpSummary(env, keyId, limit = 100) {
  if (!env || !env.DB) return []
  const { results } = await env.DB.prepare(
    `SELECT ip, COUNT(*) AS requests, COALESCE(SUM(output_tokens), 0) AS chars, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen FROM request_logs WHERE key_id = ? GROUP BY ip ORDER BY last_seen DESC LIMIT ?`
  )
    .bind(keyId, limit)
    .all()
  return (results || []).map((r) => ({
    ip: r.ip,
    requests: r.requests,
    chars: r.chars,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen
  }))
}
