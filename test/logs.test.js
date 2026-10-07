import test from 'node:test'
import assert from 'node:assert/strict'

import { nowSec } from '../src/util.js'
import {
  normalizeRequestLog,
  writeRequestLog,
  queryRequestLogs,
  cleanupRequestLogs,
  requestLogIpSummary
} from '../src/logs.js'

function fakeDb(handlers = {}) {
  const calls = []
  const db = {
    prepare(sql) {
      const s = {
        sql,
        args: [],
        bind(...a) {
          s.args = a
          return s
        },
        run: async () => {
          calls.push(s)
          if (handlers.run) return handlers.run(sql, s.args)
          return { meta: { changes: 1 } }
        },
        all: async () => {
          calls.push(s)
          if (handlers.all) return handlers.all(sql, s.args)
          return { results: [] }
        },
        first: async () => {
          calls.push(s)
          if (handlers.first) return handlers.first(sql, s.args)
          return null
        }
      }
      return s
    }
  }
  return { DB: db, calls }
}

test('normalizeRequestLog maps a complete event', () => {
  const row = normalizeRequestLog({
    createdAt: 1700000000,
    keyId: 'key_1',
    ip: '1.2.3.4',
    model: 'gpt-x',
    profile: 'default',
    status: 200,
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 20,
    durationMs: 300,
    ttftMs: 50,
    isStream: true
  })
  assert.deepEqual(row, {
    created_at: 1700000000,
    key_id: 'key_1',
    ip: '1.2.3.4',
    model: 'gpt-x',
    profile: 'default',
    status: 200,
    finish_reason: 'stop',
    input_tokens: 10,
    output_tokens: 20,
    duration_ms: 300,
    ttft_ms: 50,
    is_stream: 1
  })
})

test('normalizeRequestLog applies defaults for missing fields', () => {
  const before = nowSec()
  const row = normalizeRequestLog({})
  const after = nowSec()
  assert.ok(row.created_at >= before && row.created_at <= after)
  assert.equal(row.key_id, null)
  assert.equal(row.ip, '')
  assert.equal(row.model, '')
  assert.equal(row.profile, null)
  assert.equal(row.status, 0)
  assert.equal(row.finish_reason, null)
  assert.equal(row.input_tokens, 0)
  assert.equal(row.output_tokens, 0)
  assert.equal(row.duration_ms, 0)
  assert.equal(row.ttft_ms, 0)
  assert.equal(row.is_stream, 0)
})

test('normalizeRequestLog sanitizes non-finite and negative numbers', () => {
  const row = normalizeRequestLog({
    createdAt: 1700000000,
    status: 'nope',
    inputTokens: 'abc',
    outputTokens: -5,
    durationMs: NaN,
    ttftMs: Infinity,
    ip: 123,
    model: null
  })
  assert.equal(row.status, 0)
  assert.equal(row.input_tokens, 0)
  assert.equal(row.output_tokens, 0)
  assert.equal(row.duration_ms, 0)
  assert.equal(row.ttft_ms, 0)
  assert.equal(row.ip, '123')
  assert.equal(row.model, '')
})

test('normalizeRequestLog coerces isStream to 1/0', () => {
  assert.equal(normalizeRequestLog({ createdAt: 1, isStream: true }).is_stream, 1)
  assert.equal(normalizeRequestLog({ createdAt: 1, isStream: 1 }).is_stream, 1)
  assert.equal(normalizeRequestLog({ createdAt: 1, isStream: false }).is_stream, 0)
  assert.equal(normalizeRequestLog({ createdAt: 1, isStream: undefined }).is_stream, 0)
})

test('queryRequestLogs builds combined keyId/ip/before conditions and binds params', async () => {
  const db = fakeDb()
  const result = await queryRequestLogs(db, { keyId: 'key_1', ip: '9.9.9.9', before: 500, limit: 10 })
  assert.deepEqual(result, { items: [], nextBefore: null })
  const call = db.calls[0]
  assert.ok(call.sql.includes('key_id = ?'))
  assert.ok(call.sql.includes('ip = ?'))
  assert.ok(call.sql.includes('id < ?'))
  assert.ok(call.sql.includes('ORDER BY id DESC LIMIT ?'))
  assert.ok(call.sql.includes(' AND '))
  assert.deepEqual(call.args, ['key_1', '9.9.9.9', 500, 10])
})

test('queryRequestLogs defaults limit to 100 and clamps to 1..500', async () => {
  const db = fakeDb()
  await queryRequestLogs(db, {})
  assert.equal(db.calls[0].args.at(-1), 100)
  assert.ok(!db.calls[0].sql.includes('WHERE'))
  await queryRequestLogs(db, { limit: 1000 })
  assert.equal(db.calls[1].args.at(-1), 500)
  await queryRequestLogs(db, { limit: 0 })
  assert.equal(db.calls[2].args.at(-1), 1)
  await queryRequestLogs(db, { limit: -3 })
  assert.equal(db.calls[3].args.at(-1), 1)
  await queryRequestLogs(db, { limit: 'nope' })
  assert.equal(db.calls[4].args.at(-1), 100)
  await queryRequestLogs(db, { limit: 12.9 })
  assert.equal(db.calls[5].args.at(-1), 12)
})

test('queryRequestLogs maps rows to camelCase and sets nextBefore when page is full', async () => {
  const rows = [1, 2, 3].map((n) => ({
    id: 400 - n,
    created_at: 1700000000 + n,
    key_id: 'key_1',
    ip: '1.2.3.4',
    model: 'gpt-x',
    profile: 'default',
    status: 200,
    finish_reason: 'stop',
    input_tokens: 5,
    output_tokens: 10,
    duration_ms: 20,
    ttft_ms: 3,
    is_stream: 1
  }))
  const db = fakeDb({ all: async () => ({ results: rows }) })
  const result = await queryRequestLogs(db, { limit: 3 })
  assert.equal(result.items.length, 3)
  assert.equal(result.nextBefore, 397)
  assert.deepEqual(result.items[0], {
    id: 399,
    createdAt: 1700000001,
    keyId: 'key_1',
    ip: '1.2.3.4',
    model: 'gpt-x',
    profile: 'default',
    status: 200,
    finishReason: 'stop',
    inputTokens: 5,
    outputTokens: 10,
    durationMs: 20,
    ttftMs: 3,
    isStream: true
  })
  assert.deepEqual(db.calls[0].args, [3])
})

test('queryRequestLogs returns nextBefore null when page is partial', async () => {
  const db = fakeDb({
    all: async () => ({ results: [{ id: 7, created_at: 1, is_stream: 0 }, { id: 6, created_at: 1, is_stream: 0 }] })
  })
  const result = await queryRequestLogs(db, { limit: 5 })
  assert.equal(result.items.length, 2)
  assert.equal(result.nextBefore, null)
})

test('cleanupRequestLogs computes cutoff with retention days and returns deleted count', async () => {
  const db = fakeDb({ run: async () => ({ meta: { changes: 4 } }) })
  const before = nowSec()
  const result = await cleanupRequestLogs(db, 7)
  const after = nowSec()
  assert.deepEqual(result, { deleted: 4 })
  assert.equal(db.calls[0].sql, 'DELETE FROM request_logs WHERE created_at < ?')
  const cutoff = db.calls[0].args[0]
  assert.ok(cutoff >= before - 7 * 86400 && cutoff <= after - 7 * 86400)
})

test('cleanupRequestLogs falls back to 7 days for invalid retention', async () => {
  const db = fakeDb({ run: async () => ({ meta: { changes: 1 } }) })
  const before = nowSec()
  await cleanupRequestLogs(db, 0)
  await cleanupRequestLogs(db, NaN)
  await cleanupRequestLogs(db, undefined)
  const after = nowSec()
  for (const call of db.calls) {
    const cutoff = call.args[0]
    assert.ok(cutoff >= before - 7 * 86400 && cutoff <= after - 7 * 86400)
  }
})

test('cleanupRequestLogs returns deleted 0 without DB', async () => {
  assert.deepEqual(await cleanupRequestLogs(null, 7), { deleted: 0 })
  assert.deepEqual(await cleanupRequestLogs({}, 7), { deleted: 0 })
})

test('requestLogIpSummary groups by ip and maps rows', async () => {
  const db = fakeDb({
    all: async () => ({
      results: [
        { ip: '1.1.1.1', requests: 5, chars: 100, first_seen: 1000, last_seen: 2000 },
        { ip: '2.2.2.2', requests: 2, chars: 40, first_seen: 900, last_seen: 1500 }
      ]
    })
  })
  const rows = await requestLogIpSummary(db, 'key_1', 50)
  assert.equal(db.calls[0].sql.includes('GROUP BY ip'), true)
  assert.equal(db.calls[0].sql.includes('ORDER BY last_seen DESC'), true)
  assert.deepEqual(db.calls[0].args, ['key_1', 50])
  assert.deepEqual(rows, [
    { ip: '1.1.1.1', requests: 5, chars: 100, firstSeen: 1000, lastSeen: 2000 },
    { ip: '2.2.2.2', requests: 2, chars: 40, firstSeen: 900, lastSeen: 1500 }
  ])
})

test('requestLogIpSummary uses default limit 100', async () => {
  const db = fakeDb()
  await requestLogIpSummary(db, 'key_1')
  assert.deepEqual(db.calls[0].args, ['key_1', 100])
})

test('requestLogIpSummary returns empty array without DB', async () => {
  assert.deepEqual(await requestLogIpSummary(null, 'key_1'), [])
  assert.deepEqual(await requestLogIpSummary({}, 'key_1'), [])
})

test('writeRequestLog ignores missing DB', async () => {
  await assert.doesNotReject(writeRequestLog(null, null, { ip: '1.2.3.4' }))
  await assert.doesNotReject(writeRequestLog({}, null, { ip: '1.2.3.4' }))
})

test('writeRequestLog registers a guarded promise with ctx.waitUntil and swallows DB errors', async () => {
  const db = fakeDb({ run: async () => ({ meta: { changes: 1 } }) })
  let waited = null
  await writeRequestLog(db, { waitUntil: (p) => { waited = p } }, {
    createdAt: 1700000000,
    keyId: 'key_1',
    ip: '1.2.3.4',
    model: 'gpt-x',
    status: 200,
    outputTokens: 7,
    isStream: true
  })
  assert.ok(waited && typeof waited.then === 'function')
  await assert.doesNotReject(waited)
  assert.ok(db.calls[0].sql.startsWith('INSERT INTO request_logs'))
  assert.deepEqual(db.calls[0].args, [
    1700000000, 'key_1', '1.2.3.4', 'gpt-x', null, 200, null, 0, 7, 0, 0, 1
  ])

  const failing = fakeDb({ run: async () => { throw new Error('db down') } })
  let failed = null
  await writeRequestLog(failing, { waitUntil: (p) => { failed = p } }, { createdAt: 1 })
  await assert.doesNotReject(failed)
})

test('writeRequestLog awaits and swallows errors without ctx', async () => {
  const db = fakeDb({ run: async () => { throw new Error('db down') } })
  await assert.doesNotReject(writeRequestLog(db, null, { createdAt: 1, ip: '1.2.3.4' }))
  const syncing = fakeDb({ run: async () => ({ meta: { changes: 1 } }) })
  await writeRequestLog(syncing, null, { createdAt: 1 })
  assert.equal(syncing.calls.length, 1)
})
