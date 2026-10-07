import { getConfig, getProfileByModel, listProfiles, resolveIpPolicy } from './config.js'
import { authenticate, keyScopes } from './keys.js'
import { cleanup } from './stats.js'
import { acquire, settle } from './limiter.js'
import { estimatePromptTokens, generateContent, resolvePacing } from './generator.js'
import { handleAdminApi } from './admin-api.js'
import { collectRotateKeys } from '../public/js/interpreter.js'
import { readJson, chatCompletionBody, completionBody, sseStream, responsesBody, responsesStream, extractInput } from './openai.js'
import { writeRequestLog, cleanupRequestLogs } from './logs.js'
import { json, openaiError, randomId, nowSec, sleep, corsHeaders } from './util.js'
import { verifyAccessJwt } from './access.js'
import { ipScopeKey } from './ip-match.js'

export { Limiter } from './limiter-do.js'

const FALLBACK_PROGRAM = {
  type: 'sequence',
  children: [
    { type: 'lorem', words: { min: 5, max: 20 }, capitalize: true },
    { type: 'text', value: ' ' },
    {
      type: 'repeat',
      times: { min: 2, max: 6 },
      children: [{ type: 'charset', pool: 'unicode-garbage', min: 2, max: 8 }]
    }
  ]
}

function withCors(response, origin) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    if (!headers.has(key)) headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function clientIp(request) {
  const direct = request.headers.get('CF-Connecting-IP')
  if (direct && direct.trim()) return direct.trim()
  return '0.0.0.0'
}

async function handleModels(env, origin) {
  const profiles = await listProfiles(env)
  const created = nowSec()
  const data = profiles
    .filter((profile) => profile.enabled)
    .map((profile) => ({ id: profile.modelId, object: 'model', created, owned_by: 'loremium' }))
  return withCors(json({ object: 'list', data }), origin)
}

async function handleCompletion(request, env, ctx, config, kind) {
  const startedAt = Date.now()
  const origin = config.corsOrigin || '*'
  const isChat = kind === 'chat'

  const auth = await authenticate(env, request, config.authMode)
  if (auth.status === 'invalid') {
    return withCors(openaiError(401, 'Invalid API key provided', 'authentication_error', 'invalid_api_key'), origin)
  }
  if (auth.status === 'none' && config.authMode === 'required') {
    return withCors(openaiError(401, 'Missing API key', 'authentication_error', 'invalid_api_key'), origin)
  }

  const read = await readJson(request)
  if (!read.ok) return withCors(read.response, origin)
  const body = read.body

  if (typeof body.model !== 'string' || body.model.length === 0) {
    return withCors(openaiError(400, 'Missing required parameter: model'), origin)
  }
  if (isChat && body.messages !== undefined && !Array.isArray(body.messages)) {
    return withCors(openaiError(400, 'Invalid parameter: messages must be an array'), origin)
  }
  if (kind === 'responses' && body.input === undefined) {
    return withCors(openaiError(400, 'Missing required parameter: input'), origin)
  }
  if (kind === 'text' && body.prompt === undefined) {
    return withCors(openaiError(400, 'Missing required parameter: prompt'), origin)
  }
  const tokenParam = ['max_completion_tokens', 'max_tokens', 'max_output_tokens'].find((key) => body[key] !== undefined)
  if (tokenParam) {
    const value = body[tokenParam]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return withCors(openaiError(400, `Invalid parameter: ${tokenParam} must be a positive integer`), origin)
    }
  }

  const model = body.model
  let profile = await getProfileByModel(env, model)
  if ((!profile || !profile.enabled) && config.strictModel) {
    return withCors(openaiError(404, `The model '${model}' does not exist`, 'not_found_error'), origin)
  }
  if (!profile || !profile.enabled) profile = await getProfileByModel(env, config.defaultModel)
  if (!profile || !profile.enabled) {
    profile = { id: 'fallback', name: 'fallback', modelId: model, program: FALLBACK_PROGRAM, isDefault: true, enabled: true, updatedAt: 0 }
  }
  const program = profile.program && typeof profile.program === 'object' ? profile.program : FALLBACK_PROGRAM
  const inputs = extractInput(body, kind)

  const ip = clientIp(request)
  const scopeIp = ipScopeKey(ip)
  const policy = await resolveIpPolicy(env, ip, config)
  if (!policy.allowed) {
    return withCors(
      openaiError(403, `IP not allowed: ${ip}`, 'permission_error', 'ip_not_allowed'),
      origin
    )
  }
  const scopes = [{ scope: `ip:${scopeIp}`, rules: policy.rules }]
  if (auth.status === 'valid' && auth.key && config.authMode !== 'off') {
    for (const scope of keyScopes(auth.key, scopeIp)) scopes.push(scope)
  }
  const rotateKeys = collectRotateKeys(program)
  const maxTokens = Number.isFinite(body.max_completion_tokens)
    ? body.max_completion_tokens
    : Number.isFinite(body.max_tokens)
      ? body.max_tokens
      : Number.isFinite(body.max_output_tokens)
        ? body.max_output_tokens
        : Infinity
  const reserveCap = Number.isFinite(maxTokens)
    ? Math.min(config.maxOutputChars, Math.max(0, maxTokens))
    : config.maxOutputChars
  const declaredMaxTokens = Number.isFinite(maxTokens) ? maxTokens : null
  const instructions = typeof body.instructions === 'string' ? body.instructions : null

  const acq = await acquire(env, {
    ip: scopeIp,
    keyId: auth.key ? auth.key.id : null,
    concurrencyLimit: policy.concurrency,
    reserveCap,
    maxDurationMs: config.maxDurationMs,
    scopes,
    rotateKeys
  })

  const stream = body.stream === true
  const includeUsage = stream && !!(body.stream_options && body.stream_options.include_usage)
  const id = kind === 'responses' ? randomId('resp_') : isChat ? randomId('chatcmpl-') : randomId('cmpl-')
  const created = nowSec()
  const promptTokens = estimatePromptTokens(
    kind === 'responses'
      ? body.input ?? ''
      : isChat
        ? (Array.isArray(body.messages) ? body.messages : [])
        : body.prompt ?? ''
  )
  const pacing = resolvePacing(config, profile)
  const scopeNames = scopes.map((scope) => scope.scope)
  const profileName = profile.name || profile.id || model
  let settled = false
  const settleOnce = async (used) => {
    if (!acq.ok || settled) return
    settled = true
    try {
      await settle(env, { ip: scopeIp, scopes: scopeNames, used, reservationId: acq.reservationId })
    } catch {}
  }
  const emit = (status, finishReason, chars, ttftMs, outputTokens = chars) => {
    const durationMs = Date.now() - startedAt
    const keyId = auth.key ? auth.key.id : null
    if (config.requestLogEnabled) {
      try {
        writeRequestLog(env, ctx, {
          keyId,
          ip,
          model,
          profile: profileName,
          status,
          finishReason,
          inputTokens: promptTokens,
          outputTokens,
          durationMs,
          ttftMs,
          isStream: stream
        })
      } catch {}
    }
  }

  if (!acq.ok) {
    if (acq.reason === 'quota' && config.overLimitBehavior !== 'reject') {
      const usage = { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens }
      if (stream) {
        const { response, done } =
          kind === 'responses'
            ? responsesStream({ id, model, created, text: '', usage, pacing, truncated: true, signal: request.signal, instructions, maxOutputTokens: declaredMaxTokens })
            : sseStream({
                kind,
                id,
                model,
                created,
                text: '',
                usage,
                pacing,
                includeUsage,
                truncated: true,
                signal: request.signal
              })
        ctx.waitUntil(
          (async () => {
            try {
              await done
            } catch {}
            emit(200, 'length', 0, Math.min(Date.now() - startedAt, pacing.firstDelayMs))
          })()
        )
        return withCors(response, origin)
      }
      const emptyBody =
        kind === 'responses'
          ? responsesBody({ id, model, created, text: '', usage, status: 'incomplete', incompleteReason: 'max_output_tokens', instructions, maxOutputTokens: declaredMaxTokens })
          : isChat
            ? chatCompletionBody({ id, model, created, text: '', usage, finishReason: 'length' })
            : completionBody({ id, model, created, text: '', usage, finishReason: 'length' })
      emit(200, 'length', 0, Date.now() - startedAt)
      return withCors(json(emptyBody, { status: 200 }), origin)
    }
    const retryAfterMs = Number.isFinite(acq.retryAfterMs) ? acq.retryAfterMs : 1000
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
    const message =
      acq.reason === 'concurrency'
        ? `Concurrency limit exceeded. Retry after ${retryAfterSec} seconds.`
        : `Rate limit exceeded. Retry after ${retryAfterSec} seconds.`
    const response = openaiError(429, message, 'rate_limit_exceeded', 'rate_limit_exceeded')
    response.headers.set('Retry-After', String(retryAfterSec))
    emit(429, 'error', 0, 0)
    return withCors(response, origin)
  }

  let budget = Math.min(acq.reserved, config.maxOutputChars, maxTokens)
  if (!Number.isFinite(budget) || budget < 0) budget = 0

  let generated
  try {
    generated = generateContent(program, { budget, rotations: acq.rotations || {}, inputs })
  } catch (error) {
    await settleOnce(0)
    throw error
  }
  const text = generated.text
  const textChars = text.length
  const usage = { prompt_tokens: promptTokens, completion_tokens: textChars, total_tokens: promptTokens + textChars }
  const finishReason = generated.truncated ? 'length' : 'stop'

  if (!stream) {
    let responseBody
    let used = 0
    try {
      if (pacing.firstDelayMs > 0) await sleep(pacing.firstDelayMs)
      responseBody =
        kind === 'responses'
          ? responsesBody({
              id,
              model,
              created,
              text,
              usage,
              status: generated.truncated ? 'incomplete' : 'completed',
              incompleteReason: generated.truncated ? 'max_output_tokens' : null,
              instructions,
              maxOutputTokens: declaredMaxTokens
            })
          : isChat
            ? chatCompletionBody({ id, model, created, text, usage, finishReason })
            : completionBody({ id, model, created, text, usage, finishReason })
      used = textChars
      return withCors(json(responseBody, { status: 200 }), origin)
    } finally {
      await settleOnce(used)
      emit(200, finishReason, used, Date.now() - startedAt)
    }
  }

  let sse
  try {
    sse =
      kind === 'responses'
        ? responsesStream({ id, model, created, text, usage, pacing, truncated: generated.truncated, signal: request.signal, instructions, maxOutputTokens: declaredMaxTokens })
        : sseStream({ kind, id, model, created, text, usage, pacing, includeUsage, truncated: generated.truncated, signal: request.signal })
  } catch (error) {
    await settleOnce(0)
    throw error
  }
  ctx.waitUntil(
    (async () => {
      let emitted = 0
      let reason = finishReason
      try {
        const result = await sse.done
        emitted = result.emitted
        reason = result.finishReason
      } catch {}
      await settleOnce(textChars)
      emit(200, reason, emitted, Math.min(Date.now() - startedAt, pacing.firstDelayMs))
    })()
  )
  return withCors(sse.response, origin)
}

async function handleV1(request, env, ctx, config) {
  const url = new URL(request.url)
  const origin = config.corsOrigin || '*'
  const path = url.pathname
  if (path === '/v1/models') {
    if (request.method !== 'GET') {
      return withCors(openaiError(405, 'Method not allowed', 'invalid_request_error'), origin)
    }
    return handleModels(env, origin)
  }
  if (path === '/v1/chat/completions') {
    if (request.method !== 'POST') {
      return withCors(openaiError(405, 'Method not allowed', 'invalid_request_error'), origin)
    }
    return handleCompletion(request, env, ctx, config, 'chat')
  }
  if (path === '/v1/completions') {
    if (request.method !== 'POST') {
      return withCors(openaiError(405, 'Method not allowed', 'invalid_request_error'), origin)
    }
    return handleCompletion(request, env, ctx, config, 'text')
  }
  if (path === '/v1/responses') {
    if (request.method !== 'POST') {
      return withCors(openaiError(405, 'Method not allowed', 'invalid_request_error'), origin)
    }
    return handleCompletion(request, env, ctx, config, 'responses')
  }
  return withCors(openaiError(404, `Unknown request URL: ${request.method} ${path}`, 'not_found_error'), origin)
}

function adminOriginAllowed(request, adminHosts) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  try {
    return adminHosts.includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    const adminHosts = String(env.ADMIN_HOST || 'admin.ai.example.com')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)
    const isAdminApi = path === '/admin/api' || path.startsWith('/admin/api/')
    const isV1 = path === '/v1' || path.startsWith('/v1/')
    let config = null
    try {
      config = await getConfig(env)
    } catch {}
    const origin = config && config.corsOrigin ? config.corsOrigin : '*'

    if (request.method === 'OPTIONS' && isV1) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    try {
      if (isAdminApi) {
        const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
        const devBypass = env.DEV_BYPASS_ADMIN === 'true' && (!env.ACCESS_AUD || localHost)
        if (!devBypass && !adminHosts.includes(url.hostname)) {
          return json({ ok: false, error: 'Forbidden' }, { status: 403 })
        }
        if (!devBypass) {
          if (!adminOriginAllowed(request, adminHosts)) {
            return json({ ok: false, error: 'Forbidden' }, { status: 403 })
          }
          const method = request.method.toUpperCase()
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            const contentType = String(request.headers.get('Content-Type') || '').toLowerCase()
            if (!contentType.startsWith('application/json')) {
              return json({ ok: false, error: 'Forbidden' }, { status: 403 })
            }
          }
          if (!env.ACCESS_AUD) return json({ ok: false, error: 'Forbidden' }, { status: 403 })
          const payload = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env)
          if (!payload) return json({ ok: false, error: 'Forbidden' }, { status: 403 })
        }
        return await handleAdminApi(request, env, ctx)
      }
      if (isV1) {
        if (!config) return withCors(openaiError(500, 'Internal server error', 'internal_error'), origin)
        return await handleV1(request, env, ctx, config)
      }
      const asset = await env.ASSETS.fetch(request)
      const headers = new Headers(asset.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('X-Frame-Options', 'DENY')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'")
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers })
    } catch {
      if (isAdminApi) return json({ ok: false, error: 'Internal server error' }, { status: 500 })
      if (isV1) return withCors(openaiError(500, 'Internal server error', 'internal_error'), origin)
      return new Response('Internal Server Error', { status: 500 })
    }
  },

  async scheduled(event, env, ctx) {
    try {
      if (event.cron === '0 4 * * *') {
        await cleanup(env)
        const config = await getConfig(env)
        await cleanupRequestLogs(env, config.requestLogRetentionDays)
      }
    } catch {}
  }
}
