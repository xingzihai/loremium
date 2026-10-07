import { openaiError, randomId, sleep, nowSec } from './util.js'

const STOP = Symbol('stop')

export const MAX_BODY_BYTES = 1024 * 1024

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: openaiError(413, 'Request body too large') }
  }
  let text
  try {
    text = await readBodyText(request, maxBytes)
  } catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return { ok: false, response: openaiError(413, 'Request body too large') }
    }
    return { ok: false, response: openaiError(400, 'Invalid JSON in request body') }
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, response: openaiError(400, 'Invalid JSON in request body') }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: openaiError(400, 'Request body must be a JSON object') }
  }
  return { ok: true, body }
}

export async function readBodyText(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.body || typeof request.body.getReader !== 'function') {
    const text = await request.text()
    if (new TextEncoder().encode(text).length > maxBytes) {
      const err = new Error('body too large')
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    return text
  }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > maxBytes) {
      try {
        await reader.cancel()
      } catch {}
      const err = new Error('body too large')
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function collectText(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out)
    return
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') out.push(value.text)
    else if (value.content !== undefined) collectText(value.content, out)
  }
}

export function extractInput(body, kind) {
  const parts = []
  let lastUser = null
  if (kind === 'chat') {
    const messages = Array.isArray(body.messages) ? body.messages : []
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const messageParts = []
      collectText(message.content, messageParts)
      const text = messageParts.join('\n')
      if (!text) continue
      parts.push(text)
      if (message.role === 'user') lastUser = text
    }
  } else if (kind === 'responses') {
    const input = body.input
    if (typeof input === 'string') {
      parts.push(input)
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item === 'string') {
          parts.push(item)
          continue
        }
        if (!item || typeof item !== 'object') continue
        const itemParts = []
        collectText(item.content, itemParts)
        if (!itemParts.length) collectText(item.text, itemParts)
        const text = itemParts.join('\n')
        if (!text) continue
        parts.push(text)
        if (item.role === 'user') lastUser = text
      }
    } else if (input && typeof input === 'object') {
      const itemParts = []
      collectText(input.content, itemParts)
      if (!itemParts.length) collectText(input.text, itemParts)
      const text = itemParts.join('\n')
      if (text) parts.push(text)
    }
  } else {
    const prompt = body.prompt
    if (typeof prompt === 'string') parts.push(prompt)
    else if (Array.isArray(prompt)) for (const item of prompt) if (typeof item === 'string') parts.push(item)
  }
  const all = parts.join('\n')
  return { all, last: lastUser || all }
}

export function chatCompletionBody({ id, model, created, text = '', usage, finishReason = 'stop' }) {
  return {
    id: id || randomId('chatcmpl-'),
    object: 'chat.completion',
    created: created ?? nowSec(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason
      }
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

export function completionBody({ id, model, created, text = '', usage, finishReason = 'stop' }) {
  return {
    id: id || randomId('cmpl-'),
    object: 'text_completion',
    created: created ?? nowSec(),
    model,
    choices: [{ index: 0, text, finish_reason: finishReason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

function responseUsage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens
  }
}

function responseObject({ id, model, created, status, incompleteReason, output, instructions, maxOutputTokens = null, inputTokens, outputTokens }) {
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    error: null,
    incomplete_details: status === 'incomplete' && incompleteReason ? { reason: incompleteReason } : null,
    instructions: instructions ?? null,
    max_output_tokens: maxOutputTokens ?? null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: responseUsage(inputTokens, outputTokens),
    user: null,
    metadata: {}
  }
}

function usageTokens(usage) {
  const input = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0
  const output = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0
  return { input, output }
}

export function responsesBody({ id, model, created, text = '', usage, status = 'completed', incompleteReason = null, instructions = null, maxOutputTokens = null }) {
  const { input, output } = usageTokens(usage)
  const message = {
    type: 'message',
    id: randomId('msg_'),
    status: status === 'completed' ? 'completed' : 'incomplete',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  }
  return responseObject({
    id: id || randomId('resp_'),
    model,
    created: created ?? nowSec(),
    status,
    incompleteReason,
    output: [message],
    instructions,
    maxOutputTokens,
    inputTokens: input,
    outputTokens: output
  })
}

export function responsesStream({ id, model, created, text = '', usage, pacing = {}, truncated = false, signal = null, instructions = null, maxOutputTokens = null }) {
  const respId = id || randomId('resp_')
  const msgId = randomId('msg_')
  const createdAt = created ?? nowSec()
  const { input: inputTokens } = usageTokens(usage)
  const firstDelayMs = Math.max(0, Number(pacing.firstDelayMs) || 0)
  const charsPerSecond = Number(pacing.charsPerSecond) > 0 ? Number(pacing.charsPerSecond) : 30
  const chunkSize = Math.max(1, Math.floor(Number(pacing.chunkSize) || 1))
  const maxDurationMs = Number.isFinite(Number(pacing.maxDurationMs)) ? Number(pacing.maxDurationMs) : Infinity
  const chunkDelayMs = (chunkSize / charsPerSecond) * 1000
  const chunks = codePointChunks(String(text), chunkSize)
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const startedAt = Date.now()
  let emitted = 0
  let aborted = false
  let watchdogFired = false
  let wake = null
  const abortPromise = new Promise((resolve) => {
    wake = resolve
  })
  const onAbort = () => {
    aborted = true
    if (wake) wake()
  }
  const onWatchdog = () => {
    watchdogFired = true
    onAbort()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const watchdog = Number.isFinite(maxDurationMs) ? setTimeout(onWatchdog, maxDurationMs + 1000) : null
  const delay = async (ms) => {
    if (ms <= 0 || aborted) return
    await Promise.race([sleep(ms), abortPromise])
  }
  let seq = 0
  const event = (payload) => ({ ...payload, sequence_number: seq++ })
  const writeBytes = async (bytes) => {
    if (aborted && !watchdogFired) throw STOP
    if (watchdogFired) {
      await writer.write(bytes)
      return
    }
    const result = await Promise.race([
      writer.write(bytes).then(() => null),
      abortPromise.then(() => STOP)
    ])
    if (result === STOP) throw STOP
  }
  const write = (payload) => writeBytes(encoder.encode(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`))
  const emptyResponse = (status) =>
    responseObject({
      id: respId,
      model,
      created: createdAt,
      status,
      incompleteReason: null,
      output: [],
      instructions,
      maxOutputTokens,
      inputTokens,
      outputTokens: 0
    })
  const done = (async () => {
    let delivered = ''
    let incomplete = truncated
    try {
      if (!aborted) {
        await write(event({ type: 'response.created', response: emptyResponse('in_progress') }))
        await write(event({ type: 'response.in_progress', response: emptyResponse('in_progress') }))
        await write(
          event({
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: msgId, type: 'message', status: 'in_progress', content: [], role: 'assistant' }
          })
        )
        await write(
          event({
            type: 'response.content_part.added',
            item_id: msgId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] }
          })
        )
      }
      await delay(firstDelayMs)
      let timedOut = false
      for (const part of chunks) {
        if (aborted) break
        if (Date.now() - startedAt >= maxDurationMs) {
          timedOut = true
          break
        }
        await write(
          event({
            type: 'response.output_text.delta',
            item_id: msgId,
            output_index: 0,
            content_index: 0,
            delta: part
          })
        )
        delivered += part
        emitted += part.length
        await delay(chunkDelayMs)
      }
      if (timedOut) incomplete = true
      const status = incomplete || aborted ? 'incomplete' : 'completed'
      const part = { type: 'output_text', text: delivered, annotations: [] }
      const item = { id: msgId, type: 'message', status, content: [part], role: 'assistant' }
      if (!aborted || watchdogFired) {
        await write(event({ type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: delivered }))
        await write(event({ type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part }))
        await write(event({ type: 'response.output_item.done', output_index: 0, item }))
        await write(
          event({
            type: status === 'completed' ? 'response.completed' : 'response.incomplete',
            response: responseObject({
              id: respId,
              model,
              created: createdAt,
              status,
              incompleteReason: incomplete ? 'max_output_tokens' : null,
              output: [item],
              instructions,
              maxOutputTokens,
              inputTokens,
              outputTokens: delivered.length
            })
          })
        )
      }
      return { emitted, finishReason: status === 'completed' ? 'stop' : 'length' }
    } catch {
      return { emitted, finishReason: 'length' }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (watchdog) clearTimeout(watchdog)
      try {
        if (watchdogFired) await writer.close()
        else await Promise.race([writer.close(), abortPromise])
      } catch {}
    }
  })()
  const response = new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  })
  return { response, done }
}

function codePointChunks(text, size) {
  const points = Array.from(text)
  const chunks = []
  for (let i = 0; i < points.length; i += size) {
    chunks.push(points.slice(i, i + size).join(''))
  }
  return chunks
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function sseStream({ kind, id, model, created, text = '', usage, pacing = {}, includeUsage = false, truncated = false, signal = null }) {
  const isChat = kind === 'chat'
  const object = isChat ? 'chat.completion.chunk' : 'text_completion'
  const firstDelayMs = Math.max(0, Number(pacing.firstDelayMs) || 0)
  const charsPerSecond = Number(pacing.charsPerSecond) > 0 ? Number(pacing.charsPerSecond) : 30
  const chunkSize = Math.max(1, Math.floor(Number(pacing.chunkSize) || 1))
  const maxDurationMs = Number.isFinite(Number(pacing.maxDurationMs)) ? Number(pacing.maxDurationMs) : Infinity
  const chunkDelayMs = (chunkSize / charsPerSecond) * 1000
  const chunks = codePointChunks(String(text), chunkSize)
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const startedAt = Date.now()
  let emitted = 0
  let aborted = false
  let watchdogFired = false
  let wake = null
  const abortPromise = new Promise((resolve) => {
    wake = resolve
  })
  const onAbort = () => {
    aborted = true
    if (wake) wake()
  }
  const onWatchdog = () => {
    watchdogFired = true
    onAbort()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const watchdog = Number.isFinite(maxDurationMs) ? setTimeout(onWatchdog, maxDurationMs + 1000) : null
  const delay = async (ms) => {
    if (ms <= 0 || aborted) return
    await Promise.race([sleep(ms), abortPromise])
  }
  const base = () => ({ id, object, created, model })
  const usageNull = includeUsage ? { usage: null } : {}
  const writeBytes = async (bytes) => {
    if (aborted && !watchdogFired) throw STOP
    if (watchdogFired) {
      await writer.write(bytes)
      return
    }
    const result = await Promise.race([
      writer.write(bytes).then(() => null),
      abortPromise.then(() => STOP)
    ])
    if (result === STOP) throw STOP
  }
  const write = (payload) => writeBytes(encoder.encode(sseEvent(payload)))
  const done = (async () => {
    try {
      if (isChat && !aborted) {
        await write({
          ...base(),
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          ...usageNull
        })
      }
      await delay(firstDelayMs)
      let timedOut = false
      for (const part of chunks) {
        if (aborted) break
        if (Date.now() - startedAt >= maxDurationMs) {
          timedOut = true
          break
        }
        const choice = isChat
          ? { index: 0, delta: { content: part }, finish_reason: null }
          : { index: 0, text: part, finish_reason: null }
        await write({ ...base(), choices: [choice], ...usageNull })
        emitted += part.length
        await delay(chunkDelayMs)
      }
      const finishReason = truncated || aborted || timedOut ? 'length' : 'stop'
      if (!aborted || watchdogFired) {
        const finishChoice = isChat
          ? { index: 0, delta: {}, finish_reason: finishReason }
          : { index: 0, text: '', finish_reason: finishReason }
        await write({ ...base(), choices: [finishChoice], ...usageNull })
        if (includeUsage) {
          const promptTokens = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0
          await write({
            ...base(),
            choices: [],
            usage: usage
              ? { ...usage, completion_tokens: emitted, total_tokens: promptTokens + emitted }
              : { prompt_tokens: 0, completion_tokens: emitted, total_tokens: emitted }
          })
        }
        await writeBytes(encoder.encode('data: [DONE]\n\n'))
      }
      return { emitted, finishReason }
    } catch {
      return { emitted, finishReason: 'length' }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (watchdog) clearTimeout(watchdog)
      try {
        if (watchdogFired) await writer.close()
        else await Promise.race([writer.close(), abortPromise])
      } catch {}
    }
  })()
  const response = new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  })
  return { response, done }
}
