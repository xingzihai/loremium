import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePacing } from '../src/generator.js'
import { createProfile, updateProfile } from '../src/config.js'

const config = { firstDelayMs: 300, charsPerSecond: 30, chunkSize: 4, maxDurationMs: 120000 }

function fakeDb(handlers = {}) {
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
        run: async () => {
          calls.push(statement)
          return handlers.run ? handlers.run(sql, statement.args) : { meta: { changes: 1 } }
        },
        all: async () => {
          calls.push(statement)
          return handlers.all ? handlers.all(sql, statement.args) : { results: [] }
        },
        first: async () => {
          calls.push(statement)
          return handlers.first ? handlers.first(sql, statement.args) : null
        }
      }
      return statement
    }
  }
  return { DB, calls }
}

test('resolvePacing inherits global values when there is no override', () => {
  assert.deepEqual(resolvePacing(config, null), { firstDelayMs: 300, charsPerSecond: 30, chunkSize: 4, maxDurationMs: 120000 })
  assert.deepEqual(resolvePacing(config, { firstDelayMs: null, charsPerSecond: null }), {
    firstDelayMs: 300,
    charsPerSecond: 30,
    chunkSize: 4,
    maxDurationMs: 120000
  })
})

test('resolvePacing applies per-profile overrides including zero delay', () => {
  const pacing = resolvePacing(config, { firstDelayMs: 0, charsPerSecond: 5.5 })
  assert.equal(pacing.firstDelayMs, 0)
  assert.equal(pacing.charsPerSecond, 5.5)
  const partial = resolvePacing(config, { firstDelayMs: 1000 })
  assert.equal(partial.firstDelayMs, 1000)
  assert.equal(partial.charsPerSecond, 30)
  const fallback = resolvePacing(config, { firstDelayMs: 'abc', charsPerSecond: -1 })
  assert.equal(fallback.firstDelayMs, 300)
  assert.equal(fallback.charsPerSecond, 30)
})

test('createProfile persists pacing columns', async () => {
  const { DB, calls } = fakeDb()
  const created = await createProfile(
    { DB },
    { name: 'm', modelId: 'model-x', program: {}, first_delay_ms: 250, chars_per_second: 12.5 }
  )
  assert.equal(created.firstDelayMs, 250)
  assert.equal(created.charsPerSecond, 12.5)
  const insert = calls.find((call) => call.sql.includes('INSERT INTO profiles'))
  assert.ok(insert.args.includes(250))
  assert.ok(insert.args.includes(12.5))
})

test('updateProfile can set and clear pacing overrides', async () => {
  const existing = { id: 'p_1', name: 'm', model_id: 'model-x', program: '{}', is_default: 0, enabled: 1, first_delay_ms: 100, chars_per_second: 10, updated_at: 0 }
  const set = fakeDb({ first: () => existing })
  await updateProfile({ DB: set.DB }, 'p_1', { firstDelayMs: 500, charsPerSecond: 20 })
  const updateSet = set.calls.find((call) => call.sql.includes('UPDATE profiles'))
  assert.ok(updateSet.args.includes(500))
  assert.ok(updateSet.args.includes(20))

  const clear = fakeDb({ first: () => existing })
  await updateProfile({ DB: clear.DB }, 'p_1', { firstDelayMs: '', charsPerSecond: null })
  const updateClear = clear.calls.find((call) => call.sql.includes('UPDATE profiles'))
  assert.equal(updateClear.args.filter((value) => value === null).length, 2)
})
