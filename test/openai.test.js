import test from 'node:test'
import assert from 'node:assert/strict'
import { readJson, chatCompletionBody, completionBody, sseStream, responsesBody, responsesStream, extractInput } from '../src/openai.js'

function jsonRequest(payload) {
  return new Request('https://ai.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  })
}

async function collectEvents(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }
  raw += decoder.decode()
  return raw
    .split('\n\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseEvent(event) {
  assert.ok(event.startsWith('data: '))
  return JSON.parse(event.slice(6))
}

test('readJson parses a valid JSON object', async () => {
  const result = await readJson(jsonRequest(JSON.stringify({ model: 'loremium-test', messages: [] })))
  assert.equal(result.ok, true)
  assert.deepEqual(result.body, { model: 'loremium-test', messages: [] })
})

test('readJson rejects malformed JSON with an OpenAI 400 error', async () => {
  const result = await readJson(jsonRequest('{not json'))
  assert.equal(result.ok, false)
  assert.equal(result.response.status, 400)
  const payload = await result.response.json()
  assert.deepEqual(payload, {
    error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', param: null, code: null }
  })
})

test('readJson rejects non-object JSON bodies', async () => {
  const arrayResult = await readJson(jsonRequest('[1,2,3]'))
  assert.equal(arrayResult.ok, false)
  assert.equal(arrayResult.response.status, 400)
  const nullResult = await readJson(jsonRequest('null'))
  assert.equal(nullResult.ok, false)
  assert.equal(nullResult.response.status, 400)
})

test('readJson rejects bodies above the byte limit', async () => {
  const small = await readJson(jsonRequest(JSON.stringify({ model: 'x' })), 8)
  assert.equal(small.ok, false)
  assert.equal(small.response.status, 413)
  const declared = {
    headers: new Headers({ 'Content-Length': '999999' }),
    text: async () => JSON.stringify({ model: 'x' })
  }
  const large = await readJson(declared, 1024)
  assert.equal(large.ok, false)
  assert.equal(large.response.status, 413)
  const ok = await readJson(jsonRequest(JSON.stringify({ model: 'x' })), 1024)
  assert.equal(ok.ok, true)
})

test('chatCompletionBody matches API.md 3.2 fields', () => {
  const usage = { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
  const body = chatCompletionBody({
    id: 'chatcmpl-abc',
    model: 'loremium-unicode',
    created: 1759536000,
    text: 'hello',
    usage,
    finishReason: 'stop'
  })
  assert.deepEqual(body, {
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: 1759536000,
    model: 'loremium-unicode',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }
    ],
    usage
  })
})

test('chatCompletionBody fills defaults for id and created', () => {
  const body = chatCompletionBody({ model: 'm', text: '', finishReason: 'length' })
  assert.match(body.id, /^chatcmpl-/)
  assert.equal(Number.isInteger(body.created), true)
  assert.equal(body.choices[0].finish_reason, 'length')
})

test('completionBody matches API.md 4 fields', () => {
  const usage = { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }
  const body = completionBody({
    id: 'cmpl-abc',
    model: 'loremium-lorem',
    created: 1759536000,
    text: 'lorem',
    usage,
    finishReason: 'length'
  })
  assert.deepEqual(body, {
    id: 'cmpl-abc',
    object: 'text_completion',
    created: 1759536000,
    model: 'loremium-lorem',
    choices: [{ index: 0, text: 'lorem', finish_reason: 'length' }],
    usage
  })
})

test('sseStream chat emits role, content, usage, finish and DONE in order', async () => {
  const usage = { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
  const { response, done } = sseStream({
    kind: 'chat',
    id: 'chatcmpl-test',
    model: 'loremium-unicode',
    created: 1759536000,
    text: 'abcdef',
    usage,
    pacing: { firstDelayMs: 1, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    includeUsage: true,
    truncated: false,
    signal: null
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/)
  const events = await collectEvents(response)
  assert.equal(events.length, 7)

  const role = parseEvent(events[0])
  assert.equal(role.object, 'chat.completion.chunk')
  assert.equal(role.id, 'chatcmpl-test')
  assert.equal(role.model, 'loremium-unicode')
  assert.equal(role.created, 1759536000)
  assert.deepEqual(role.choices, [
    { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
  ])

  const contents = [parseEvent(events[1]), parseEvent(events[2]), parseEvent(events[3])]
  assert.deepEqual(contents.map((chunk) => chunk.choices[0].delta.content), ['ab', 'cd', 'ef'])
  for (const chunk of contents) {
    assert.equal(chunk.object, 'chat.completion.chunk')
    assert.deepEqual(Object.keys(chunk).sort(), ['choices', 'created', 'id', 'model', 'object', 'usage'])
    assert.equal(chunk.usage, null)
    assert.equal(chunk.choices[0].index, 0)
    assert.equal(chunk.choices[0].finish_reason, null)
    assert.equal('role' in chunk.choices[0].delta, false)
  }

  const finish = parseEvent(events[4])
  assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }])
  assert.equal(finish.usage, null)

  const usageChunk = parseEvent(events[5])
  assert.deepEqual(usageChunk.choices, [])
  assert.deepEqual(usageChunk.usage, usage)

  assert.equal(events[6], 'data: [DONE]')

  assert.deepEqual(await done, { emitted: 6, finishReason: 'stop' })
})

test('sseStream text emits text_completion chunks without usage by default', async () => {
  const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  const { response, done } = sseStream({
    kind: 'text',
    id: 'cmpl-test',
    model: 'loremium-lorem',
    created: 1759536000,
    text: 'abc',
    usage,
    pacing: { firstDelayMs: 0, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    includeUsage: false,
    truncated: false
  })
  const events = await collectEvents(response)
  assert.equal(events.length, 4)

  const first = parseEvent(events[0])
  assert.equal(first.object, 'text_completion')
  assert.deepEqual(first.choices, [{ index: 0, text: 'ab', finish_reason: null }])
  assert.equal('delta' in first.choices[0], false)

  const second = parseEvent(events[1])
  assert.equal(second.choices[0].text, 'c')

  const finish = parseEvent(events[2])
  assert.equal(finish.choices[0].finish_reason, 'stop')
  assert.equal(finish.choices[0].text, '')

  assert.equal(events[3], 'data: [DONE]')
  assert.deepEqual(await done, { emitted: 3, finishReason: 'stop' })
})

test('sseStream reports length when truncated', async () => {
  const { response, done } = sseStream({
    kind: 'chat',
    id: 'chatcmpl-trunc',
    model: 'm',
    created: 1,
    text: 'abcd',
    usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
    pacing: { firstDelayMs: 0, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    includeUsage: true,
    truncated: true
  })
  const events = await collectEvents(response)
  const finish = parseEvent(events[3])
  assert.equal(finish.choices[0].finish_reason, 'length')
  const usageChunk = parseEvent(events[4])
  assert.equal(usageChunk.usage.completion_tokens, 4)
  assert.deepEqual(await done, { emitted: 4, finishReason: 'length' })
})

test('sseStream stops on maxDuration and keeps emitted count', async () => {
  const { response, done } = sseStream({
    kind: 'chat',
    id: 'chatcmpl-timeout',
    model: 'm',
    created: 1,
    text: 'abcdefgh',
    usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
    pacing: { firstDelayMs: 0, charsPerSecond: 100, chunkSize: 2, maxDurationMs: 10 },
    includeUsage: false,
    truncated: false
  })
  const events = await collectEvents(response)
  const contents = events.slice(1).filter((event) => event !== 'data: [DONE]')
  const finish = parseEvent(contents[contents.length - 1])
  assert.equal(finish.choices[0].finish_reason, 'length')
  assert.equal(events[events.length - 1], 'data: [DONE]')
  const result = await done
  assert.equal(result.finishReason, 'length')
  assert.equal(result.emitted, 2)
})

test('sseStream stops on abort and resolves emitted partial output', async () => {
  const controller = new AbortController()
  const { response, done } = sseStream({
    kind: 'chat',
    id: 'chatcmpl-abort',
    model: 'm',
    created: 1,
    text: 'abcdef',
    usage: { prompt_tokens: 1, completion_tokens: 6, total_tokens: 7 },
    pacing: { firstDelayMs: 100, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    includeUsage: false,
    truncated: false,
    signal: controller.signal
  })
  controller.abort()
  const events = await collectEvents(response)
  assert.equal(events.length, 1)
  assert.equal(parseEvent(events[0]).choices[0].delta.role, 'assistant')
  assert.deepEqual(await done, { emitted: 0, finishReason: 'length' })
})

test('sseStream splits on code points without breaking surrogate pairs', async () => {
  const text = 'a\u{1D306}b'
  const { response, done } = sseStream({
    kind: 'chat',
    id: 'chatcmpl-astral',
    model: 'm',
    created: 1,
    text,
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    pacing: { firstDelayMs: 0, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    includeUsage: false,
    truncated: false
  })
  const events = await collectEvents(response)
  assert.equal(parseEvent(events[1]).choices[0].delta.content, 'a\u{1D306}')
  assert.equal(parseEvent(events[2]).choices[0].delta.content, 'b')
  assert.equal(parseEvent(events[3]).choices[0].finish_reason, 'stop')
  assert.equal(events[4], 'data: [DONE]')
  const result = await done
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.emitted, text.length)
})

test('responsesBody matches Responses API fields', () => {
  const body = responsesBody({
    id: 'resp_abc',
    model: 'loremium-lorem',
    created: 1759536000,
    text: 'lorem',
    usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }
  })
  assert.equal(body.id, 'resp_abc')
  assert.equal(body.object, 'response')
  assert.equal(body.status, 'completed')
  assert.equal(body.incomplete_details, null)
  assert.equal(body.output[0].type, 'message')
  assert.equal(body.output[0].role, 'assistant')
  assert.equal(body.output[0].content[0].type, 'output_text')
  assert.equal(body.output[0].content[0].text, 'lorem')
  assert.deepEqual(body.usage, {
    input_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 6
  })
})

test('responsesBody marks truncated output as incomplete', () => {
  const body = responsesBody({ model: 'm', text: 'abc', status: 'incomplete', incompleteReason: 'max_output_tokens' })
  assert.equal(body.status, 'incomplete')
  assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' })
  assert.equal(body.output[0].status, 'incomplete')
  assert.match(body.id, /^resp_/)
})

function parseNamedEvents(raw) {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const eventLine = lines.find((l) => l.startsWith('event: '))
      const dataLine = lines.find((l) => l.startsWith('data: '))
      return { event: eventLine ? eventLine.slice(7) : null, data: JSON.parse(dataLine.slice(6)) }
    })
}

test('responsesStream emits lifecycle events and text deltas', async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 }
  const { response, done } = responsesStream({
    id: 'resp_test',
    model: 'm',
    created: 1759536000,
    text: 'abcdef',
    usage,
    pacing: { firstDelayMs: 1, charsPerSecond: 100000, chunkSize: 2, maxDurationMs: 60000 },
    truncated: false,
    signal: null
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/)
  const blocks = await collectEvents(response)
  const events = parseNamedEvents(blocks.join('\n\n'))
  assert.deepEqual(
    events.map((e) => e.event),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed'
    ]
  )
  const deltas = events
    .filter((e) => e.event === 'response.output_text.delta')
    .map((e) => e.data.delta)
    .join('')
  assert.equal(deltas, 'abcdef')
  const final = events[events.length - 1].data.response
  assert.equal(final.status, 'completed')
  assert.equal(final.output[0].content[0].text, 'abcdef')
  assert.equal(final.usage.output_tokens, 6)
  const result = await done
  assert.equal(result.emitted, 6)
  assert.equal(result.finishReason, 'stop')
})

test('responsesStream marks truncated output as incomplete', async () => {
  const { response, done } = responsesStream({
    id: 'resp_trunc',
    model: 'm',
    text: 'abcdef',
    usage: { prompt_tokens: 1, completion_tokens: 6, total_tokens: 7 },
    pacing: { firstDelayMs: 0, charsPerSecond: 100000, chunkSize: 100, maxDurationMs: 60000 },
    truncated: true,
    signal: null
  })
  const blocks = await collectEvents(response)
  const events = parseNamedEvents(blocks.join('\n\n'))
  assert.equal(events[events.length - 1].event, 'response.incomplete')
  assert.equal(events[events.length - 1].data.response.status, 'incomplete')
  const result = await done
  assert.equal(result.finishReason, 'length')
})

test('extractInput collects chat messages and last user text', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '甲\n乙' },
      { role: 'assistant', content: [{ type: 'text', text: 'old' }] }
    ]
  }
  const result = extractInput(body, 'chat')
  assert.equal(result.all, 'sys\n甲\n乙\nold')
  assert.equal(result.last, '甲\n乙')
})

test('extractInput falls back to all text without a user message', () => {
  const result = extractInput({ messages: [{ role: 'system', content: 'only' }] }, 'chat')
  assert.equal(result.all, 'only')
  assert.equal(result.last, 'only')
})

test('extractInput handles responses input shapes', () => {
  assert.deepEqual(extractInput({ input: 'hello' }, 'responses'), { all: 'hello', last: 'hello' })
  const messages = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '一' }] },
      { role: 'user', content: '二' }
    ]
  }
  assert.deepEqual(extractInput(messages, 'responses'), { all: '一\n二', last: '二' })
  assert.deepEqual(extractInput({ input: { text: 'obj' } }, 'responses'), { all: 'obj', last: 'obj' })
})

test('extractInput handles completions prompt', () => {
  assert.deepEqual(extractInput({ prompt: 'p' }, 'text'), { all: 'p', last: 'p' })
  assert.deepEqual(extractInput({ prompt: ['a', 'b'] }, 'text'), { all: 'a\nb', last: 'a\nb' })
  assert.deepEqual(extractInput({}, 'text'), { all: '', last: '' })
})
