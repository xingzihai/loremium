import { nowSec } from './util.js'

const HOUR = 3600

function num(v, def = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function toIso(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return null
  return new Date(n * 1000).toISOString()
}

async function requestLogRows(env, { start, end, keyId }) {
  const conditions = ['created_at >= ?', 'created_at < ?']
  const binds = [start, end]
  if (keyId) {
    conditions.push('key_id = ?')
    binds.push(keyId)
  }
  const { results } = await env.DB.prepare(
    `SELECT CAST(created_at / ${HOUR} AS INTEGER) * ${HOUR} AS bucket,
            COUNT(*) AS requests,
            COALESCE(SUM(output_tokens), 0) AS chars,
            COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
     FROM request_logs
     WHERE ${conditions.join(' AND ')}
     GROUP BY bucket
     ORDER BY bucket`
  )
    .bind(...binds)
    .all()
  return results || []
}

async function distinctIps(env, start, end) {
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT ip) AS active_ips FROM request_logs WHERE created_at >= ? AND created_at < ?'
  )
    .bind(start, end)
    .first()
  return num(row && row.active_ips)
}

function fillSeries(rows, start, end) {
  const alignedStart = Math.floor(start / HOUR) * HOUR
  const map = new Map((rows || []).map((r) => [Number(r.bucket), r]))
  const series = []
  for (let t = alignedStart; t < end; t += HOUR) {
    const row = map.get(t)
    series.push({
      t: toIso(t),
      requests: row ? num(row.requests) : 0,
      chars: row ? num(row.chars) : 0
    })
  }
  return series
}

function sumRows(rows) {
  let requests = 0
  let chars = 0
  let errors = 0
  for (const row of rows || []) {
    requests += num(row.requests)
    chars += num(row.chars)
    errors += num(row.errors)
  }
  return { requests, chars, errors }
}

export async function overview(env, hours = 24) {
  const h = Math.max(1, Math.min(24 * 31, Math.floor(num(hours, 24))))
  const now = nowSec()
  const start = now - h * HOUR
  const rows = await requestLogRows(env, { start, end: now + 1 })
  const totals = sumRows(rows)
  const activeIps = await distinctIps(env, start, now + 1)
  return {
    requests: totals.requests,
    chars: totals.chars,
    errors: totals.errors,
    activeIps,
    series: fillSeries(rows, start, now + 1)
  }
}

export async function overviewToday(env, tzOffsetMinutes = 480) {
  const offsetSec = num(tzOffsetMinutes, 480) * 60
  const now = nowSec()
  const local = now + offsetSec
  const dayStart = Math.floor(local / 86400) * 86400 - offsetSec
  const end = dayStart + 86400
  const rows = await requestLogRows(env, { start: dayStart, end })
  const totals = sumRows(rows)
  const activeIps = await distinctIps(env, dayStart, end)
  const visibleEnd = Math.min(end, now + 1)
  return {
    requests: totals.requests,
    chars: totals.chars,
    errors: totals.errors,
    activeIps,
    series: fillSeries(rows, dayStart, visibleEnd)
  }
}

export async function queryStats(env, filters = {}) {
  const conditions = []
  const binds = []
  const from = Date.parse(filters.from)
  if (Number.isFinite(from)) {
    conditions.push('created_at >= ?')
    binds.push(Math.floor(from / 1000))
  }
  const to = Date.parse(filters.to)
  if (Number.isFinite(to)) {
    conditions.push('created_at <= ?')
    binds.push(Math.floor(to / 1000))
  }
  if (filters.ip) {
    conditions.push('ip = ?')
    binds.push(String(filters.ip))
  }
  if (filters.model) {
    conditions.push('model = ?')
    binds.push(String(filters.model))
  }
  if (filters.status !== undefined && filters.status !== null && filters.status !== '') {
    const status = Number(filters.status)
    if (Number.isFinite(status)) {
      conditions.push('status = ?')
      binds.push(status)
    }
  }
  const keyId = filters.keyId ?? filters.key_id
  if (keyId) {
    conditions.push('key_id = ?')
    binds.push(String(keyId))
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(num(filters.limit, 100))))
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { results } = await env.DB.prepare(
    `SELECT created_at, key_id, ip, model, profile, status, finish_reason,
            input_tokens, output_tokens, duration_ms, ttft_ms, is_stream
     FROM request_logs
     ${where}
     ORDER BY id DESC
     LIMIT ?`
  )
    .bind(...binds, limit)
    .all()
  return (results || []).map((r) => ({
    timestamp: toIso(r.created_at),
    ip: r.ip,
    model: r.model,
    status: num(r.status, r.status),
    profile: r.profile,
    finishReason: r.finish_reason,
    keyId: r.key_id || null,
    chars: num(r.output_tokens),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    durationMs: num(r.duration_ms),
    ttftMs: num(r.ttft_ms),
    isStream: num(r.is_stream) === 1
  }))
}

export async function keyUsage(env, keyId, days = 7) {
  const d = Math.max(1, Math.min(31, Math.floor(num(days, 7))))
  const now = nowSec()
  const start = now - d * 86400
  const rows = await requestLogRows(env, { start, end: now + 1, keyId })
  const totals = sumRows(rows)
  return {
    requests: totals.requests,
    chars: totals.chars,
    series: fillSeries(rows, start, now + 1)
  }
}

export async function cleanup(env) {
  const res = await env.DB.prepare(
    'DELETE FROM ip_overrides WHERE expires_at IS NOT NULL AND expires_at <= ?'
  )
    .bind(nowSec())
    .run()
  return { deleted: res.meta.changes }
}
