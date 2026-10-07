const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {})
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8')
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function openaiError(status, message, type = 'invalid_request_error', code = null) {
  return json({ error: { message, type, param: null, code } }, { status })
}

export function randomId(prefix, len = 24) {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < len; i++) out += BASE62[bytes[i] % 62]
  return prefix + out
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

export function parseIntOr(v, def) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

export function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  }
}
