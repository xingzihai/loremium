const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const RUN = Date.now().toString(36)
const PROD = process.env.SMOKE_MODE === 'prod'
const CLIENT_IP = process.env.SMOKE_IP || '127.0.0.1'
const FIXED = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.'
const ADMIN_HEADERS = (() => {
  const headers = {}
  if (process.env.SMOKE_ACCESS_CLIENT_ID && process.env.SMOKE_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.SMOKE_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.SMOKE_ACCESS_CLIENT_SECRET
  }
  return headers
})()

let passed = 0
let failed = 0
const failures = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'value'} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
}

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (err) {
    failed++
    failures.push(`${name}: ${err.message}`)
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, headers: res.headers, text, data }
}

const admin = (method, path, body) => req('/admin/api' + path, { method, body, headers: ADMIN_HEADERS })

async function setConfig(patch) {
  const r = await admin('PUT', '/config', patch)
  assert(r.status === 200 && r.data && r.data.ok, `config PUT failed: ${r.text}`)
}

async function listRules() {
  const r = await admin('GET', '/rules')
  assert(r.data && r.data.ok, 'rules list')
  return r.data.data
}

async function clearRules() {
  for (const rule of await listRules()) await admin('DELETE', '/rules/' + rule.id)
}

async function listOverrides() {
  const r = await admin('GET', '/ip-overrides')
  assert(r.data && r.data.ok, 'overrides list')
  return r.data.data
}

async function clearOverrides() {
  for (const o of await listOverrides()) await admin('DELETE', '/ip-overrides/' + encodeURIComponent(o.ip))
}

async function listKeys() {
  const r = await admin('GET', '/api-keys')
  assert(r.data && r.data.ok, 'keys list')
  return r.data.data
}

async function clearKeys() {
  for (const k of await listKeys()) await admin('DELETE', '/api-keys/' + k.id)
}

async function resetIp() {
  await admin('POST', '/ip/' + CLIENT_IP + '/reset')
  await sleep(250)
  await admin('POST', '/ip/' + CLIENT_IP + '/reset')
}

async function debugState(label) {
  const st = await admin('GET', '/ip/' + CLIENT_IP + '/status')
  const rules = await listRules()
  const overrides = await listOverrides()
  console.log(
    `DEBUG[${label}]`,
    JSON.stringify({
      scopes: st.data && st.data.data && st.data.data.scopes,
      rules: rules.map((r) => ({ id: r.id, ws: r.windowSeconds, lc: r.limitChars, en: r.enabled })),
      overrides: overrides.map((o) => ({ ip: o.ip, rules: o.rules }))
    })
  )
}

const chat = (body, opts = {}) => req('/v1/chat/completions', { method: 'POST', body, ...opts })
const completion = (body, opts = {}) => req('/v1/completions', { method: 'POST', body, ...opts })

function parseSSE(text) {
  const events = []
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const line = trimmed.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      events.push('[DONE]')
      continue
    }
    try {
      events.push(JSON.parse(payload))
    } catch {
      events.push(payload)
    }
  }
  return events
}

function emittedChars(events) {
  let n = 0
  for (const e of events) {
    const c = e && e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content
    if (typeof c === 'string') n += c.length
    const t = e && e.choices && e.choices[0] && typeof e.choices[0].text === 'string' ? e.choices[0].text : null
    if (t !== null && !e.choices[0].delta) n += t.length
  }
  return n
}

function finishReason(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const f = e && e.choices && e.choices[0] && e.choices[0].finish_reason
    if (f) return f
  }
  return null
}

async function chatStream(body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip
  const t0 = performance.now()
  const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let firstContentAt = null
  let lastContentAt = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const piece = decoder.decode(value, { stream: true })
    text += piece
    if (/"content":"[^"]/.test(piece)) {
      const now = performance.now() - t0
      if (firstContentAt === null) firstContentAt = now
      lastContentAt = now
    }
  }
  return { status: res.status, text, events: parseSSE(text), firstContentAt, lastContentAt, totalMs: performance.now() - t0 }
}

async function setup() {
  await setConfig({
    first_delay_ms: 0,
    chars_per_second: 1000,
    chunk_size: 8,
    max_duration_s: 30,
    max_output_chars: 32000,
    concurrency_limit: 10,
    over_limit_behavior: 'truncate',
    default_model: 'loremium-unicode',
    strict_model: false,
    cors_origin: '*',
    auth_mode: 'optional'
  })
  await clearRules()
  await clearOverrides()
  await clearKeys()
  await resetIp()
}

async function cleanup() {
  await clearRules()
  await clearOverrides()
  await clearKeys()
  await resetIp()
  await setConfig({ first_delay_ms: 300, chars_per_second: 30, chunk_size: 4, max_duration_s: 120, max_output_chars: 32000, concurrency_limit: 2, over_limit_behavior: 'truncate', default_model: 'loremium-unicode', strict_model: false, cors_origin: '*', auth_mode: 'optional' })
  const profiles = await admin('GET', '/profiles')
  for (const p of profiles.data.data) {
    if (p.modelId.startsWith('loremium-rot-')) await admin('DELETE', '/profiles/' + p.id)
  }
}

async function main() {
  console.log(`Loremium smoke @ ${BASE} run=${RUN}`)
  await setup()

  await test('GET /v1/models lists 3 seeded models', async () => {
    const r = await req('/v1/models')
    eq(r.status, 200)
    const ids = r.data.data.map((m) => m.id).sort()
    assert(ids.join(',') === 'loremium-fixed,loremium-lorem,loremium-unicode', `ids=${ids}`)
    eq(r.data.object, 'list')
  })

  await test('chat non-stream fixed profile exact content + usage', async () => {
    const r = await chat({ model: 'loremium-fixed', messages: [{ role: 'user', content: 'hi' }] })
    eq(r.status, 200)
    eq(r.data.object, 'chat.completion')
    eq(r.data.choices[0].message.content, FIXED)
    eq(r.data.choices[0].finish_reason, 'stop')
    eq(r.data.usage.completion_tokens, FIXED.length)
    eq(r.data.usage.total_tokens, r.data.usage.prompt_tokens + r.data.usage.completion_tokens)
  })

  await test('chat stream SSE structure unicode', async () => {
    const r = await chatStream({ model: 'loremium-unicode', messages: [], stream: true })
    eq(r.status, 200)
    assert(r.events.length >= 4, `events=${r.events.length}`)
    assert(r.events[r.events.length - 1] === '[DONE]', 'missing [DONE]')
    const role = r.events[0]
    eq(role.object, 'chat.completion.chunk')
    eq(role.choices[0].delta.role, 'assistant')
    eq(finishReason(r.events), 'stop')
    assert(emittedChars(r.events) > 0, 'no content emitted')
  })

  await test('legacy /v1/completions non-stream', async () => {
    const r = await completion({ model: 'loremium-fixed', prompt: 'x' })
    eq(r.status, 200)
    eq(r.data.object, 'text_completion')
    eq(r.data.choices[0].text, FIXED)
  })

  await test('legacy /v1/completions stream', async () => {
    const r = await req('/v1/completions', { method: 'POST', body: { model: 'loremium-fixed', prompt: 'x', stream: true } })
    eq(r.status, 200)
    const events = parseSSE(r.text)
    assert(events[events.length - 1] === '[DONE]', 'missing [DONE]')
    const text = events.filter((e) => e && e.choices && typeof e.choices[0].text === 'string').map((e) => e.choices[0].text).join('')
    eq(text, FIXED)
  })

  await test('responses API non-stream returns output_text', async () => {
    const r = await req('/v1/responses', { method: 'POST', body: { model: 'loremium-fixed', input: [{ role: 'user', content: 'hi' }] } })
    eq(r.status, 200)
    eq(r.data.object, 'response')
    eq(r.data.status, 'completed')
    eq(r.data.output[0].type, 'message')
    eq(r.data.output[0].content[0].type, 'output_text')
    eq(r.data.output[0].content[0].text, FIXED)
    eq(r.data.usage.output_tokens, FIXED.length)
  })

  await test('responses API stream emits deltas then completed', async () => {
    const res = await fetch(BASE + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'loremium-fixed', input: 'hi', stream: true })
    })
    eq(res.status, 200)
    const text = await res.text()
    const events = []
    for (const block of text.split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let payload = null
      try {
        payload = JSON.parse(line.slice(6))
      } catch {}
      if (payload && payload.type) events.push(payload)
    }
    const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('')
    eq(deltas, FIXED)
    assert(events.some((e) => e.type === 'response.created'), 'missing response.created')
    eq(events[events.length - 1].type, 'response.completed')
    eq(events[events.length - 1].response.status, 'completed')
  })

  await test('responses API requires input and validates model', async () => {
    const noInput = await req('/v1/responses', { method: 'POST', body: { model: 'loremium-fixed' } })
    eq(noInput.status, 400)
    const noModel = await req('/v1/responses', { method: 'POST', body: { input: 'hi' } })
    eq(noModel.status, 400)
    eq((await req('/v1/responses')).status, 405)
  })

  await test('unknown /v1 path -> 404 OpenAI error', async () => {
    const r = await req('/v1/nope')
    eq(r.status, 404)
    eq(r.data.error.type, 'not_found_error')
  })

  await test('wrong method -> 405', async () => {
    const r = await req('/v1/chat/completions', { method: 'GET' })
    eq(r.status, 405)
  })

  await test('invalid JSON -> 400', async () => {
    const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
    eq(res.status, 400)
  })

  await test('OPTIONS preflight -> 204 + CORS', async () => {
    const r = await req('/v1/chat/completions', { method: 'OPTIONS' })
    eq(r.status, 204)
    eq(r.headers.get('access-control-allow-origin'), '*')
  })

  await test('unknown model falls back to default; strict -> 404', async () => {
    const r = await chat({ model: 'no-such-model', messages: [] })
    eq(r.status, 200)
    await setConfig({ strict_model: true })
    const strict = await chat({ model: 'no-such-model', messages: [] })
    eq(strict.status, 404)
    await setConfig({ strict_model: false })
  })

  await test('max_tokens caps output and sets length', async () => {
    const r = await chat({ model: 'loremium-fixed', messages: [], max_tokens: 5 })
    eq(r.status, 200)
    eq(r.data.choices[0].message.content.length, 5)
    eq(r.data.choices[0].finish_reason, 'length')
  })

  await test('include_usage adds usage chunk after finish with null usage elsewhere', async () => {
    const r = await chatStream({ model: 'loremium-fixed', messages: [], stream: true, stream_options: { include_usage: true } })
    const usageIdx = r.events.findIndex((e) => e && Array.isArray(e.choices) && e.choices.length === 0 && e.usage)
    const finishIdx = r.events.findIndex((e) => e && e.choices && e.choices[0] && e.choices[0].finish_reason)
    assert(usageIdx > -1, 'no usage chunk')
    assert(finishIdx > -1, 'no finish chunk')
    assert(usageIdx > finishIdx, 'usage chunk must come after finish chunk')
    const contentChunks = r.events.filter((e) => e && e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content)
    assert(contentChunks.length > 0, 'no content chunks')
    assert(contentChunks.every((e) => e.usage === null), 'content chunks must carry usage:null')
  })

  await test('first_delay applies to non-stream', async () => {
    await setConfig({ first_delay_ms: 800, chars_per_second: 1000 })
    const t0 = performance.now()
    const r = await chat({ model: 'loremium-fixed', messages: [] })
    const ms = performance.now() - t0
    eq(r.status, 200)
    // Threshold deliberately below first_delay_ms=800 to absorb CI scheduling jitter.
    assert(ms >= 700, `expected >=700ms got ${Math.round(ms)}`)
    await setConfig({ first_delay_ms: 0 })
  })

  await test('stream pacing: ttft delay + chars_per_second', async () => {
    await setConfig({ first_delay_ms: 400, chars_per_second: 20, chunk_size: 1 })
    const r = await chatStream({ model: 'loremium-fixed', messages: [], stream: true, max_tokens: 10 })
    eq(r.status, 200)
    assert(r.firstContentAt !== null, 'no content')
    // first_delay_ms=400; 350 leaves ~50ms slack for CI jitter.
    assert(r.firstContentAt >= 350, `ttft too early: ${Math.round(r.firstContentAt)}ms`)
    const spread = r.lastContentAt - r.firstContentAt
    // 10 chars at 20 chars/s spans ~450ms; 250 is a lower bound only.
    assert(spread >= 250, `pacing too fast: ${Math.round(spread)}ms`)
    eq(emittedChars(r.events), 10, 'emitted')
    await setConfig({ first_delay_ms: 0, chars_per_second: 1000, chunk_size: 8 })
  })

  await test('max_duration_s caps stream with length', async () => {
    await setConfig({ first_delay_ms: 0, chars_per_second: 1, chunk_size: 1, max_duration_s: 2 })
    const r = await chatStream({ model: 'loremium-fixed', messages: [], stream: true })
    // max_duration_s=2 but transport can lag; 6000 is a loose upper bound.
    assert(r.totalMs < 6000, `too long ${Math.round(r.totalMs)}ms`)
    eq(finishReason(r.events), 'length')
    const emitted = emittedChars(r.events)
    assert(emitted > 0 && emitted < FIXED.length, `emitted=${emitted}`)
    await setConfig({ chars_per_second: 1000, chunk_size: 8, max_duration_s: 30 })
  })

  let mainKey = null
  let mainKeyId = null

  await test('auth optional: no key allowed, invalid key 401', async () => {
    const noKey = await chat({ model: 'loremium-fixed', messages: [] })
    eq(noKey.status, 200)
    const bad = await chat({ model: 'loremium-fixed', messages: [] }, { headers: { Authorization: 'Bearer sk-lorem-wrong' } })
    eq(bad.status, 401)
    eq(bad.data.error.type, 'authentication_error')
  })

  await test('auth required: missing 401, valid key 200', async () => {
    await setConfig({ auth_mode: 'required' })
    const missing = await chat({ model: 'loremium-fixed', messages: [] })
    eq(missing.status, 401)
    const created = await admin('POST', '/api-keys', { name: 'smoke-main-' + RUN, quota_mode: 'unlimited' })
    eq(created.status, 200)
    mainKey = created.data.data.key
    mainKeyId = created.data.data.id
    assert(mainKey.startsWith('sk-lorem-'), 'key format')
    const ok = await chat({ model: 'loremium-fixed', messages: [] }, { headers: { Authorization: `Bearer ${mainKey}` } })
    eq(ok.status, 200)
    await setConfig({ auth_mode: 'optional' })
  })

  await test('disabled and expired keys rejected', async () => {
    const h = { Authorization: `Bearer ${mainKey}` }
    await admin('PUT', '/api-keys/' + mainKeyId, { enabled: false })
    eq((await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })).status, 401)
    await admin('PUT', '/api-keys/' + mainKeyId, { enabled: true })
    eq((await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })).status, 200)
    await admin('PUT', '/api-keys/' + mainKeyId, { expires_at: Math.floor(Date.now() / 1000) - 60 })
    eq((await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })).status, 401)
    await admin('PUT', '/api-keys/' + mainKeyId, { expires_at: null })
    eq((await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })).status, 200)
  })

  await test('total quota truncates at limit then empties', async () => {
    const created = await admin('POST', '/api-keys', { name: 'smoke-total-' + RUN, quota_mode: 'total', quota_rules: [{ window_seconds: 60, limit_chars: 20 }] })
    const key = created.data.data.key
    const id = created.data.data.id
    const h = { Authorization: `Bearer ${key}` }
    const first = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })
    eq(first.status, 200)
    eq(first.data.choices[0].message.content.length, 20)
    eq(first.data.choices[0].finish_reason, 'length')
    const second = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })
    eq(second.status, 200)
    eq(second.data.choices[0].message.content.length, 0)
    eq(second.data.choices[0].finish_reason, 'length')
    const st = await admin('GET', '/api-keys/' + id + '/status')
    eq(st.data.data.scopes[0].windows[0].used, 20)
    await admin('DELETE', '/api-keys/' + id)
  })

  await test('multi-rule quota uses lowest remaining (60s/100 + 5s/10)', async () => {
    const created = await admin('POST', '/api-keys', { name: 'smoke-multi-' + RUN, quota_mode: 'total', quota_rules: [{ window_seconds: 60, limit_chars: 100 }, { window_seconds: 5, limit_chars: 10 }] })
    const key = created.data.data.key
    const id = created.data.data.id
    const first = await chat({ model: 'loremium-fixed', messages: [] }, { headers: { Authorization: `Bearer ${key}` } })
    eq(first.data.choices[0].message.content.length, 10)
    await admin('DELETE', '/api-keys/' + id)
  })

  if (!PROD) await test('per_ip key quota is independent per IP', async () => {
    const created = await admin('POST', '/api-keys', { name: 'smoke-perip-' + RUN, quota_mode: 'per_ip', quota_rules: [{ window_seconds: 60, limit_chars: 10 }] })
    const key = created.data.data.key
    const id = created.data.data.id
    const h = { Authorization: `Bearer ${key}` }
    const a1 = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h, ip: '10.9.9.1' })
    eq(a1.data.choices[0].message.content.length, 10)
    const a2 = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h, ip: '10.9.9.1' })
    eq(a2.data.choices[0].message.content.length, 0)
    const b1 = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h, ip: '10.9.9.2' })
    eq(b1.data.choices[0].message.content.length, 10)
    const st = await admin('GET', '/api-keys/' + id + '/status')
    const scopes = st.data.data.scopes.map((s) => s.scope)
    assert(scopes.includes(`key:${id}:10.9.9.1`), `scopes=${scopes}`)
    assert(scopes.includes(`key:${id}:10.9.9.2`), `scopes=${scopes}`)
    const reset = await admin('POST', '/api-keys/' + id + '/reset')
    eq(reset.status, 200)
    const again = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h, ip: '10.9.9.1' })
    eq(again.data.choices[0].message.content.length, 10, 'after reset')
    await admin('DELETE', '/api-keys/' + id)
  })

  await test('unlimited key outputs full content', async () => {
    const created = await admin('POST', '/api-keys', { name: 'smoke-unlim-' + RUN, quota_mode: 'unlimited' })
    const key = created.data.data.key
    const r = await chat({ model: 'loremium-fixed', messages: [] }, { headers: { Authorization: `Bearer ${key}` } })
    eq(r.data.choices[0].message.content, FIXED)
    eq(r.data.choices[0].finish_reason, 'stop')
    await admin('DELETE', '/api-keys/' + created.data.data.id)
  })

  await test('reject mode returns 429 for exhausted quota', async () => {
    await setConfig({ over_limit_behavior: 'reject' })
    const created = await admin('POST', '/api-keys', { name: 'smoke-reject-' + RUN, quota_mode: 'total', quota_rules: [{ window_seconds: 60, limit_chars: 5 }] })
    const key = created.data.data.key
    const id = created.data.data.id
    const h = { Authorization: `Bearer ${key}` }
    const first = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })
    eq(first.status, 200)
    const second = await chat({ model: 'loremium-fixed', messages: [] }, { headers: h })
    eq(second.status, 429)
    assert(Number(second.headers.get('retry-after')) >= 1, 'retry-after')
    await admin('DELETE', '/api-keys/' + id)
    await setConfig({ over_limit_behavior: 'truncate' })
  })

  await test('global IP rule truncates unauthenticated requests', async () => {
    await clearRules()
    await resetIp()
    if (process.env.SMOKE_DEBUG) await debugState('before-rule')
    const rule = await admin('POST', '/rules', { window_seconds: 60, limit_chars: 15 })
    try {
      await resetIp()
      if (process.env.SMOKE_DEBUG) await debugState('after-reset')
      const first = await chat({ model: 'loremium-fixed', messages: [] })
      if (first.data.choices[0].message.content.length !== 15 && process.env.SMOKE_DEBUG) {
        await debugState('after-first-fail')
        console.log('DEBUG first body:', JSON.stringify(first.data))
      }
      eq(first.data.choices[0].message.content.length, 15)
      const second = await chat({ model: 'loremium-fixed', messages: [] })
      eq(second.data.choices[0].message.content.length, 0)
    } finally {
      await admin('DELETE', '/rules/' + rule.data.data.id)
      await clearRules()
      await resetIp()
    }
  })

  await test('IP override replaces global rules', async () => {
    const rule = await admin('POST', '/rules', { window_seconds: 60, limit_chars: 15 })
    try {
      await admin('PUT', '/ip-overrides/' + CLIENT_IP, { rules: [{ window_seconds: 60, limit_chars: 30 }] })
      await resetIp()
      const r = await chat({ model: 'loremium-fixed', messages: [] })
      eq(r.data.choices[0].message.content.length, 30)
      await admin('DELETE', '/ip-overrides/' + CLIENT_IP)
      await resetIp()
      const r2 = await chat({ model: 'loremium-fixed', messages: [] })
      eq(r2.data.choices[0].message.content.length, 15)
    } finally {
      await admin('DELETE', '/ip-overrides/' + CLIENT_IP)
      await admin('DELETE', '/rules/' + rule.data.data.id)
      await resetIp()
    }
  })

  await test('concurrency limit 429 + retry-after + inflight release', async () => {
    await setConfig({ concurrency_limit: 1, first_delay_ms: 1500, chars_per_second: 1000 })
    const controller = new AbortController()
    let first = null
    try {
      first = chat({ model: 'loremium-fixed', messages: [] }, { signal: controller.signal }).catch(() => ({ aborted: true }))
      let acquired = false
      for (let i = 0; i < 40; i++) {
        const st = await admin('GET', '/ip/' + CLIENT_IP + '/status')
        if (((st.data && st.data.data && st.data.data.inflight) || {})[CLIENT_IP] >= 1) {
          acquired = true
          break
        }
        await sleep(150)
      }
      assert(acquired, 'first request did not acquire a concurrency slot')
      const second = await chat({ model: 'loremium-fixed', messages: [] })
      eq(second.status, 429)
      eq(second.data.error.code, 'rate_limit_exceeded')
      assert(Number(second.headers.get('retry-after')) >= 1, 'retry-after')
    } finally {
      controller.abort()
      if (first) await first
      await sleep(800)
      await resetIp()
      await setConfig({ concurrency_limit: 10, first_delay_ms: 0 })
    }
  })

  await test('rotate cycle returns sequential options', async () => {
    const model = 'loremium-rot-' + RUN
    const program = { type: 'sequence', children: [{ type: 'rotate', key: 'smoke-' + RUN, mode: 'cycle', scope: 'global', options: ['AAA', 'BBB', 'CCC'] }] }
    const created = await admin('POST', '/profiles', { name: 'smoke rotate', model_id: model, program })
    eq(created.status, 200)
    for (const expected of ['AAA', 'BBB', 'CCC']) {
      const r = await chat({ model, messages: [] })
      eq(r.status, 200)
      eq(r.data.choices[0].message.content, expected)
    }
    await admin('DELETE', '/profiles/' + created.data.data.id)
  })

  await test('rotate random stays within options', async () => {
    const model = 'loremium-rot-' + RUN + '-r'
    const program = { type: 'sequence', children: [{ type: 'rotate', key: 'smoke-r-' + RUN, mode: 'random', scope: 'ip', options: ['X1', 'X2', 'X3'] }] }
    const created = await admin('POST', '/profiles', { name: 'smoke rotate r', model_id: model, program })
    for (let i = 0; i < 3; i++) {
      const r = await chat({ model, messages: [] })
      assert(['X1', 'X2', 'X3'].includes(r.data.choices[0].message.content), `content=${r.data.choices[0].message.content}`)
    }
    await admin('DELETE', '/profiles/' + created.data.data.id)
  })

  // Only endpoint reachability is asserted here: scheduling side effects happen
  // asynchronously inside the Worker and are not observable over HTTP from the test.
  if (!PROD) await test('hooks/cron endpoint reachable for the daily cleanup schedule (no side-effect assertion)', async () => {
    const b = await req('/__scheduled?cron=0+4+*+*+*')
    eq(b.status, 200)
  })

  await test('admin: unknown route 404, overview and stats queryable', async () => {
    const nf = await admin('GET', '/nope')
    eq(nf.status, 404)
    eq(nf.data.ok, false)

    const ov = await admin('GET', '/overview?hours=1')
    eq(ov.status, 200)
    eq(ov.data.ok, true)
    eq(typeof ov.data.data.requests, 'number')
    eq(typeof ov.data.data.chars, 'number')
    eq(typeof ov.data.data.errors, 'number')
    eq(typeof ov.data.data.activeIps, 'number')
    assert(Array.isArray(ov.data.data.series), 'overview series not array')

    const stats = await admin('GET', '/stats?limit=5')
    eq(stats.status, 200)
    eq(stats.data.ok, true)
    assert(Array.isArray(stats.data.data), 'stats items not array')
  })

  await test('admin: config ignores unknown keys', async () => {
    const before = await admin('GET', '/config')
    await admin('PUT', '/config', { bogus_key: 'x' })
    const after = await admin('GET', '/config')
    assert(!('bogus_key' in after.data.data), 'bogus key stored')
    assert(Object.keys(before.data.data).length === Object.keys(after.data.data).length, 'config size changed')
  })

  await test('admin: rules CRUD', async () => {
    const created = await admin('POST', '/rules', { window_seconds: 120, limit_chars: 777, note: 'smoke' })
    eq(created.status, 200)
    const id = created.data.data.id
    const updated = await admin('PUT', '/rules/' + id, { window_seconds: 120, limit_chars: 888, enabled: true, note: 'smoke2' })
    eq(updated.data.data.limitChars, 888)
    const list = await listRules()
    assert(list.some((r) => r.id === id), 'rule missing')
    await admin('DELETE', '/rules/' + id)
    assert(!(await listRules()).some((r) => r.id === id), 'rule not deleted')
  })

  await test('admin: profiles CRUD + validate + default protected', async () => {
    const created = await admin('POST', '/profiles', { name: 'smoke prof', model_id: 'loremium-smoke-' + RUN, program: { type: 'text', value: 'X' } })
    eq(created.status, 200)
    const id = created.data.data.id
    const updated = await admin('PUT', '/profiles/' + id, { name: 'smoke prof 2', program: { type: 'text', value: 'Y' } })
    assert(updated.status === 200, updated.text)
    const valid = await admin('POST', '/profiles/validate', { program: { type: 'text', value: 'ok' } })
    eq(valid.data.data.ok, true)
    const invalid = await admin('POST', '/profiles/validate', { program: { type: 'repeat', times: 1000001, children: [] } })
    eq(invalid.data.data.ok, false)
    const delDefault = await admin('DELETE', '/profiles/p_unicode')
    eq(delDefault.data.ok, false)
    await admin('DELETE', '/profiles/' + id)
  })

  await test('admin: ip-overrides CRUD', async () => {
    const put = await admin('PUT', '/ip-overrides/10.7.7.7', { concurrency: 1, rules: [{ window_seconds: 60, limit_chars: 5 }], note: 'smoke' })
    eq(put.status, 200)
    const list = await listOverrides()
    assert(list.some((o) => o.ip === '10.7.7.7'), 'override missing')
    const del = await admin('DELETE', '/ip-overrides/10.7.7.7')
    eq(del.status, 200)
  })

  await test('admin: api-keys CRUD + ips empty locally', async () => {
    const created = await admin('POST', '/api-keys', { name: 'smoke crud-' + RUN, quota_mode: 'unlimited' })
    const id = created.data.data.id
    const list = await listKeys()
    assert(list.some((k) => k.id === id), 'key missing')
    assert(!('keyHash' in list.find((k) => k.id === id)), 'hash leaked')
    const ips = await admin('GET', '/api-keys/' + id + '/ips')
    eq(ips.status, 200)
    assert(Array.isArray(ips.data.data), 'ips not array')
    await admin('DELETE', '/api-keys/' + id)
    const notFound = await admin('GET', '/api-keys/' + id + '/status')
    eq(notFound.status, 404)
  })

  await test('admin: ip status and reset', async () => {
    const st = await admin('GET', '/ip/' + CLIENT_IP + '/status')
    eq(st.status, 200)
    assert(typeof st.data.data.inflight === 'object', 'no inflight')
    const reset = await admin('POST', '/ip/' + CLIENT_IP + '/reset')
    eq(reset.status, 200)
  })

  await test('static assets: panel index and scripts served', async () => {
    const index = await req('/')
    eq(index.status, 200)
    assert(index.text.includes('Loremium'), 'index missing title')
    assert(index.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff')
    assert(index.headers.get('x-frame-options') === 'DENY', 'missing frame deny')
    const app = await req('/js/app.js')
    eq(app.status, 200)
    const interp = await req('/js/interpreter.js')
    eq(interp.status, 200)
  })

  if (!PROD) await test('security: concurrent streams cannot overshoot window limit', async () => {
    const model = 'smoke-sec-long-' + RUN
    const program = { type: 'sequence', children: [{ type: 'repeat', times: 10, children: [{ type: 'text', value: 'X'.repeat(56) }] }] }
    const prof = await admin('POST', '/profiles', { name: 'smoke sec long', model_id: model, program })
    const rule = await admin('POST', '/rules', { window_seconds: 3600, limit_chars: 100 })
    await admin('PUT', '/ip-overrides/' + CLIENT_IP, { concurrency: 2, rules: null })
    await setConfig({ first_delay_ms: 200, chars_per_second: 30, over_limit_behavior: 'truncate' })
    await resetIp()
    try {
      const body = { model, messages: [], max_tokens: 100, stream: true }
      const [a, b] = await Promise.all([chatStream(body, { ip: CLIENT_IP }), chatStream(body, { ip: CLIENT_IP })])
      const total = emittedChars(a.events) + emittedChars(b.events)
      assert(total <= 100, `overshoot: ${total}`)
      const st = await admin('GET', '/ip/' + CLIENT_IP + '/status')
      const used = (st.data.data.scopes || []).flatMap((s) => s.windows || []).reduce((n, w) => n + w.used, 0)
      assert(used <= 100, `used=${used}`)
    } finally {
      await admin('DELETE', '/rules/' + rule.data.data.id)
      await admin('DELETE', '/ip-overrides/' + CLIENT_IP)
      await admin('DELETE', '/profiles/' + prof.data.data.id)
      await setConfig({ first_delay_ms: 0, chars_per_second: 1000, over_limit_behavior: 'truncate' })
      await resetIp()
    }
  })

  if (!PROD) await test('security: aborted stream still consumes quota', async () => {
    const model = 'loremium-fixed'
    const rule = await admin('POST', '/rules', { window_seconds: 3600, limit_chars: 100 })
    await setConfig({ first_delay_ms: 300, chars_per_second: 30, over_limit_behavior: 'truncate' })
    await resetIp()
    try {
      const controller = new AbortController()
      const pending = chat({ model, messages: [], stream: true, max_tokens: 100 }, { ip: CLIENT_IP, signal: controller.signal }).catch(() => null)
      await sleep(60)
      controller.abort()
      await pending
      await sleep(300)
      const st = await admin('GET', '/ip/' + CLIENT_IP + '/status')
      const used = (st.data.data.scopes || []).flatMap((s) => s.windows || []).reduce((n, w) => n + w.used, 0)
      assert(used > 0, `aborted request was free: used=${used}`)
    } finally {
      await admin('DELETE', '/rules/' + rule.data.data.id)
      await setConfig({ first_delay_ms: 0, chars_per_second: 1000, over_limit_behavior: 'truncate' })
      await resetIp()
    }
  })

  if (!PROD) await test('security: ipv6 addresses share /64 quota', async () => {
    const rule = await admin('POST', '/rules', { window_seconds: 3600, limit_chars: 15 })
    await setConfig({ first_delay_ms: 0, over_limit_behavior: 'truncate' })
    const reset6 = async (ip) => admin('POST', '/ip/' + encodeURIComponent(ip) + '/reset')
    await reset6('2001:db8:1::1')
    await reset6('2001:db8:2::1')
    await sleep(250)
    await reset6('2001:db8:1::1')
    await reset6('2001:db8:2::1')
    try {
      const a1 = await chat({ model: 'loremium-fixed', messages: [] }, { ip: '2001:db8:1::1' })
      const a2 = await chat({ model: 'loremium-fixed', messages: [] }, { ip: '2001:db8:1::2' })
      const b1 = await chat({ model: 'loremium-fixed', messages: [] }, { ip: '2001:db8:2::1' })
      eq(a1.data.choices[0].message.content.length, 15)
      eq(a2.data.choices[0].message.content.length, 0)
      eq(b1.data.choices[0].message.content.length, 15)
    } finally {
      await reset6('2001:db8:1::1')
      await reset6('2001:db8:2::1')
      await admin('DELETE', '/rules/' + rule.data.data.id)
    }
  })

  if (!PROD)   await test('echo block outputs request input verbatim (all/last)', async () => {
    const allModel = 'smoke-echo-all-' + RUN
    const lastModel = 'smoke-echo-last-' + RUN
    const p1 = await admin('POST', '/profiles', { name: 'smoke echo all', model_id: allModel, program: { type: 'echo', source: 'all' } })
    const p2 = await admin('POST', '/profiles', { name: 'smoke echo last', model_id: lastModel, program: { type: 'echo', source: 'last' } })
    try {
      const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'line1\nline2' }]
      const all = await chat({ model: allModel, messages })
      eq(all.status, 200)
      eq(all.data.choices[0].message.content, 'S\nline1\nline2')
      const last = await chat({ model: lastModel, messages })
      eq(last.data.choices[0].message.content, 'line1\nline2')
    } finally {
      await admin('DELETE', '/profiles/' + p1.data.data.id)
      await admin('DELETE', '/profiles/' + p2.data.data.id)
    }
  })

  await test('text block preserves newlines', async () => {
    const model = 'smoke-newline-' + RUN
    const p = await admin('POST', '/profiles', { name: 'smoke newline', model_id: model, program: { type: 'text', value: 'a\nb' } })
    try {
      const r = await chat({ model, messages: [] })
      eq(r.data.choices[0].message.content, 'a\nb')
    } finally {
      await admin('DELETE', '/profiles/' + p.data.data.id)
    }
  })

  await test('request logs queryable by key and ip', async () => {
    await setConfig({ request_log_enabled: true })
    const created = await admin('POST', '/api-keys', { name: 'smoke-log-' + RUN, quota_mode: 'unlimited' })
    const key = created.data.data.key
    const id = created.data.data.id
    const ip = '10.200.0.7'
    try {
      const r = await chat({ model: 'loremium-fixed', messages: [] }, { headers: { Authorization: `Bearer ${key}` }, ip })
      eq(r.status, 200)
      let found = null
      for (let i = 0; i < 20 && !found; i++) {
        const logs = await admin('GET', `/logs?key_id=${encodeURIComponent(id)}&limit=10`)
        eq(logs.status, 200)
        found = (logs.data.data.items || []).find((x) => x.ip === ip)
        if (!found) await sleep(150)
      }
      assert(found, 'log row not found')
      eq(found.keyId, id)
      eq(found.outputTokens, FIXED.length)
      assert(found.inputTokens >= 0, 'inputTokens')
      assert(typeof found.durationMs === 'number', 'durationMs')
      const byIp = await admin('GET', `/logs?ip=${encodeURIComponent(ip)}&limit=10`)
      assert((byIp.data.data.items || []).some((x) => x.keyId === id), 'ip filter missing row')
    } finally {
      await admin('DELETE', '/api-keys/' + id)
    }
  })

  await test('security: admin preflight not permissive; oversized body 413', async () => {
    const opt = await fetch(BASE + '/admin/api/config', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } })
    assert(!(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*'), `admin preflight open: ${opt.status}`)
    const big = 'A'.repeat(1024 * 1024 + 100)
    const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'loremium-fixed', prompt: big }) })
    eq(res.status, 413)
  })

  await cleanup()

  console.log('')
  console.log(`passed ${passed}, failed ${failed}`)
  if (failures.length) {
    console.log('failures:')
    for (const f of failures) console.log(' - ' + f)
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(2)
})
