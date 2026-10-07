import test from 'node:test'
import assert from 'node:assert/strict'

import { handleAdminApi } from '../src/admin-api.js'

function makeEnv(extra = {}) {
  const calls = []
  const DB = {
    calls,
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
          return { meta: { changes: 1, last_row_id: 1 } }
        },
        all: async () => {
          calls.push(statement)
          return { results: [] }
        },
        first: async () => {
          calls.push(statement)
          return null
        }
      }
      return statement
    }
  }
  return { DB, ...extra }
}

function request(method, path, body) {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request(`https://admin.example.com${path}`, init)
}

test('POST /admin/api/api-keys maps snake_case quota fields into createKey', async () => {
  const env = makeEnv()
  const res = await handleAdminApi(
    request('POST', '/admin/api/api-keys', {
      name: 'panel key',
      quota_mode: 'total',
      quota_rules: [{ window_seconds: 60, limit_chars: 10 }]
    }),
    env,
    {}
  )
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.data.quotaMode, 'total')
  assert.deepEqual(payload.data.quotaRules, [
    { windowSeconds: 60, limitChars: 10, enabled: true, note: '' }
  ])
  assert.equal(typeof payload.data.key, 'string')
  assert.ok(payload.data.key.startsWith('sk-lorem-'), 'plaintext key should be returned')
  assert.ok(payload.data.key.length > 'sk-lorem-'.length)

  const insert = env.DB.calls.find((c) => c.sql.includes('INSERT INTO api_keys'))
  assert.ok(insert, 'api key insert should run')
  assert.equal(insert.args[4], 'total', 'quota_mode should be bound as the third mapped column')
  assert.equal(insert.args[5], JSON.stringify([{ windowSeconds: 60, limitChars: 10, enabled: true, note: '' }]))
})

test('POST /admin/api/rules rejects invalid window and limit with specific errors', async () => {
  const env = makeEnv()
  const badWindow = await handleAdminApi(
    request('POST', '/admin/api/rules', { window_seconds: 0, limit_chars: 10 }),
    env,
    {}
  )
  assert.equal(badWindow.status, 400)
  assert.equal((await badWindow.json()).error, 'invalid_rule_window')

  const badLimit = await handleAdminApi(
    request('POST', '/admin/api/rules', { window_seconds: 60, limit_chars: -1 }),
    env,
    {}
  )
  assert.equal(badLimit.status, 400)
  assert.equal((await badLimit.json()).error, 'invalid_rule_limit')

  const nanWindow = await handleAdminApi(
    request('POST', '/admin/api/rules', { window_seconds: 'abc', limit_chars: 10 }),
    env,
    {}
  )
  assert.equal(nanWindow.status, 400)
  assert.equal((await nanWindow.json()).error, 'invalid_rule_window')
})

test('PUT /admin/api/rules requires an array rules payload', async () => {
  const env = makeEnv()
  const stringRules = await handleAdminApi(
    request('PUT', '/admin/api/rules', { rules: 'nope' }),
    env,
    {}
  )
  assert.equal(stringRules.status, 400)
  assert.equal((await stringRules.json()).error, 'invalid json')

  const missingRules = await handleAdminApi(
    request('PUT', '/admin/api/rules', { window_seconds: 60, limit_chars: 10 }),
    env,
    {}
  )
  assert.equal(missingRules.status, 400)
  assert.equal((await missingRules.json()).error, 'invalid json')

  const notAnObject = await handleAdminApi(
    request('PUT', '/admin/api/rules', [1, 2, 3]),
    env,
    {}
  )
  assert.equal(notAnObject.status, 400)
  assert.equal((await notAnObject.json()).error, 'invalid json')
})

test('unknown admin route returns 404 not_found', async () => {
  const env = makeEnv()
  const res = await handleAdminApi(request('GET', '/admin/api/does-not-exist'), env, {})
  assert.equal(res.status, 404)
  const payload = await res.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'not_found')
})

test('GET /admin/api/stats returns request log rows from D1', async () => {
  const env = makeEnv()
  const res = await handleAdminApi(request('GET', '/admin/api/stats?limit=5'), env, {})
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.data, [])
})
