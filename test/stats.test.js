import test from 'node:test'
import assert from 'node:assert/strict'

import { nowSec } from '../src/util.js'
import { overview, overviewToday, queryStats, keyUsage, cleanup } from '../src/stats.js'

function fakeStatsDb(handlers = {}) {
  const calls = []
  const DB = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          statement.args = args
          return statement
        },
        all: async () => {
          calls.push(statement)
          return handlers.all ? handlers.all(sql, statement.args) : { results: [] }
        },
        first: async () => {
          calls.push(statement)
          return handlers.first ? handlers.first(sql, statement.args) : null
        },
        run: async () => {
          calls.push(statement)
          return handlers.run ? handlers.run(sql, statement.args) : { meta: { changes: 1 } }
        }
      }
      return statement
    }
  }
  return { DB, calls }
}

test('overview aggregates request logs and fills hourly series', async () => {
  const now = nowSec()
  const bucket = Math.floor(now / 3600) * 3600
  const db = fakeStatsDb({
    all: (sql) => (sql.includes('GROUP BY bucket') ? { results: [{ bucket, requests: 3, chars: 30, errors: 1 }] } : { results: [] }),
    first: () => ({ active_ips: 2 })
  })
  const data = await overview({ DB: db.DB }, 3)
  assert.equal(data.requests, 3)
  assert.equal(data.chars, 30)
  assert.equal(data.errors, 1)
  assert.equal(data.activeIps, 2)
  assert.ok(data.series.length >= 3)
  const hit = data.series.find((s) => Date.parse(s.t) / 1000 === bucket)
  assert.equal(hit.requests, 3)
  assert.equal(hit.chars, 30)
  const missing = data.series.find((s) => Date.parse(s.t) / 1000 !== bucket)
  assert.equal(missing.requests, 0)
})

test('overviewToday starts at the configured local midnight', async () => {
  const db = fakeStatsDb({ all: () => ({ results: [] }), first: () => ({ active_ips: 0 }) })
  const tz = 480
  const data = await overviewToday({ DB: db.DB }, tz)
  const first = Date.parse(data.series[0].t) / 1000
  const now = nowSec()
  const local = now + tz * 60
  const expectedStart = Math.floor(local / 86400) * 86400 - tz * 60
  assert.equal(first, expectedStart)
  assert.equal(data.series.length <= 24, true)
})

test('queryStats maps rows and clamps the limit', async () => {
  const db = fakeStatsDb({
    all: () => ({
      results: [
        {
          created_at: 1700000000,
          key_id: 'key_1',
          ip: '1.2.3.4',
          model: 'm',
          profile: 'p',
          status: 200,
          finish_reason: 'stop',
          input_tokens: 1,
          output_tokens: 2,
          duration_ms: 3,
          ttft_ms: 4,
          is_stream: 1
        }
      ]
    })
  })
  const rows = await queryStats({ DB: db.DB }, { keyId: 'key_1', status: '200', limit: 99999, from: '2026-01-01T00:00:00Z' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chars, 2)
  assert.equal(rows[0].inputTokens, 1)
  assert.equal(rows[0].isStream, true)
  assert.equal(rows[0].keyId, 'key_1')
  assert.match(rows[0].timestamp, /^\d{4}-\d{2}-\d{2}T/)
  const statement = db.calls[0]
  assert.equal(statement.args[statement.args.length - 1], 1000)
  assert.equal(statement.sql.includes('key_1'), false)
  assert.equal(statement.args.includes('key_1'), true)
})

test('keyUsage filters by key and fills series', async () => {
  const now = nowSec()
  const bucket = Math.floor(now / 3600) * 3600
  const db = fakeStatsDb({
    all: (sql) => (sql.includes('GROUP BY bucket') ? { results: [{ bucket, requests: 5, chars: 50, errors: 0 }] } : { results: [] })
  })
  const data = await keyUsage({ DB: db.DB }, 'key_9', 7)
  assert.equal(data.requests, 5)
  assert.equal(data.chars, 50)
  assert.ok(data.series.length > 100)
  const statement = db.calls[0]
  assert.equal(statement.args.length, 3)
  assert.equal(statement.args[2], 'key_9')
})

test('cleanup deletes only expired ip overrides', async () => {
  const db = fakeStatsDb({ run: () => ({ meta: { changes: 4 } }) })
  const result = await cleanup({ DB: db.DB })
  assert.deepEqual(result, { deleted: 4 })
  assert.match(db.calls[0].sql, /DELETE FROM ip_overrides/)
  assert.equal(db.calls[0].args[0] <= nowSec(), true)
})
