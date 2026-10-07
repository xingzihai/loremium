import test from 'node:test'
import assert from 'node:assert/strict'

import worker from '../src/index.js'

function fakeEnv(extra = {}) {
  return {
    DB: {
      prepare() {
        const statement = {
          bind() {
            return statement
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } })
        }
        return statement
      }
    },
    ...extra
  }
}

function adminRequest(host, init = {}) {
  return new Request(`https://${host}/admin/api/config`, { method: 'GET', ...init })
}

test('admin api rejects unknown hosts', async () => {
  const res = await worker.fetch(adminRequest('evil.example.com'), fakeEnv({ ADMIN_HOST: 'admin.example.com' }), {})
  assert.equal(res.status, 403)
})

test('admin api rejects when ACCESS_AUD is missing', async () => {
  const res = await worker.fetch(adminRequest('admin.example.com'), fakeEnv({ ADMIN_HOST: 'admin.example.com' }), {})
  assert.equal(res.status, 403)
})

test('admin api rejects a request without an Access JWT', async () => {
  const res = await worker.fetch(
    adminRequest('admin.example.com'),
    fakeEnv({ ADMIN_HOST: 'admin.example.com', ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: 'team' }),
    {}
  )
  assert.equal(res.status, 403)
})

test('DEV_BYPASS_ADMIN works on localhost or without Access configured', async () => {
  const allowed = await worker.fetch(
    adminRequest('admin.example.com'),
    fakeEnv({ ADMIN_HOST: 'admin.example.com', DEV_BYPASS_ADMIN: 'true' }),
    {}
  )
  assert.equal(allowed.status, 200)
  const localWithAccess = await worker.fetch(
    new Request('http://127.0.0.1/admin/api/config', { method: 'GET' }),
    fakeEnv({ ADMIN_HOST: 'admin.example.com', ACCESS_AUD: 'aud-1', DEV_BYPASS_ADMIN: 'true' }),
    {}
  )
  assert.equal(localWithAccess.status, 200)
  const blocked = await worker.fetch(
    adminRequest('admin.example.com'),
    fakeEnv({ ADMIN_HOST: 'admin.example.com', ACCESS_AUD: 'aud-1', DEV_BYPASS_ADMIN: 'true' }),
    {}
  )
  assert.equal(blocked.status, 403)
})

test('admin api rejects cross-site origins and non-json writes', async () => {
  const env = fakeEnv({ ADMIN_HOST: 'admin.example.com', ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: 'team' })
  const crossOrigin = await worker.fetch(
    adminRequest('admin.example.com', { headers: { Origin: 'https://evil.example.com' } }),
    env,
    {}
  )
  assert.equal(crossOrigin.status, 403)
  const formPost = await worker.fetch(
    new Request('https://admin.example.com/admin/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://admin.example.com' },
      body: 'window_seconds=60'
    }),
    env,
    {}
  )
  assert.equal(formPost.status, 403)
})
