import test from 'node:test'
import assert from 'node:assert/strict'

import { replaceRules, createRule } from '../src/config.js'

function fakeDb(rows = []) {
  const batches = []
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          statement.args = args
          return statement
        },
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: rows }),
        first: async () => null
      }
      return statement
    },
    batch(statements) {
      batches.push(statements)
      return Promise.resolve(statements.map(() => ({ success: true })))
    }
  }
  return { DB: db, batches }
}

test('replaceRules deletes and reinserts rules in one batch', async () => {
  const { DB, batches } = fakeDb()
  await replaceRules({ DB }, [
    { id: 7, windowSeconds: 3600, limitChars: 1000, enabled: false, note: '每小时' },
    { windowSeconds: 60, limitChars: 5 }
  ])
  assert.equal(batches.length, 1)
  const [del, ...inserts] = batches[0]
  assert.match(del.sql, /DELETE FROM rules/)
  assert.equal(inserts.length, 2)
  assert.match(inserts[0].sql, /INSERT INTO rules/)
  assert.deepEqual(inserts[0].args, [7, 3600, 1000, 0, '每小时'])
  assert.deepEqual(inserts[1].args, [60, 5, 1, null])
})

test('replaceRules accepts an empty list (clears all rules)', async () => {
  const { DB, batches } = fakeDb()
  await replaceRules({ DB }, [])
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 1)
  assert.match(batches[0][0].sql, /DELETE FROM rules/)
})

test('replaceRules accepts the snake_case payload sent by the panel', async () => {
  const { DB, batches } = fakeDb()
  await replaceRules({ DB }, [
    { id: null, window_seconds: 300, limit_chars: 5000, enabled: true, note: '面板' }
  ])
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0][1].args, [300, 5000, 1, '面板'])
})

test('createRule rejects invalid windows and limits', async () => {
  const { DB } = fakeDb()
  await assert.rejects(() => createRule({ DB }, { window_seconds: 0, limit_chars: 1 }), /invalid_rule_window/)
  await assert.rejects(() => createRule({ DB }, { window_seconds: 60, limit_chars: -1 }), /invalid_rule_limit/)
  await assert.rejects(() => createRule({ DB }, { window_seconds: 'abc', limit_chars: 1 }), /invalid_rule_window/)
  const created = await createRule({ DB }, { window_seconds: 60, limit_chars: 5 })
  assert.equal(created.windowSeconds, 60)
  assert.equal(created.limitChars, 5)
})

test('replaceRules rejects invalid rows before writing', async () => {
  const { DB, batches } = fakeDb()
  await assert.rejects(() => replaceRules({ DB }, [{ windowSeconds: 0, limitChars: 1 }]), /invalid_rule_window/)
  await assert.rejects(() => replaceRules({ DB }, [{ windowSeconds: 60, limitChars: -1 }]), /invalid_rule_limit/)
  await assert.rejects(() => replaceRules({ DB }, [{ windowSeconds: 60, limitChars: Number.NaN }]), /invalid_rule_limit/)
  assert.equal(batches.length, 0)
})
