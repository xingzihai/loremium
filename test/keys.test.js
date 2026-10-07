import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KEY_PREFIX,
  hashKey,
  generateKeyMaterial,
  keyScopes,
  parseBearer,
  createKey
} from '../src/keys.js'

test('hashKey is deterministic and matches SHA-256', async () => {
  const a = await hashKey('abc')
  const b = await hashKey('abc')
  assert.equal(a, b)
  assert.equal(a, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(a.length, 64)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(await hashKey('abcd'), a)
})

test('generateKeyMaterial format and length', async () => {
  const { plaintext, hash, prefix } = await generateKeyMaterial()
  assert.ok(plaintext.startsWith(KEY_PREFIX))
  assert.equal(plaintext.length, KEY_PREFIX.length + 48)
  assert.match(plaintext.slice(KEY_PREFIX.length), /^[0-9A-Za-z]{48}$/)
  assert.equal(prefix, `${plaintext.slice(0, 15)}…`)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, await hashKey(plaintext))
  const other = await generateKeyMaterial()
  assert.notEqual(other.plaintext, plaintext)
})

test('keyScopes covers unlimited, total and per_ip', () => {
  const rules = [{ windowSeconds: 3600, limitChars: 1000 }]
  assert.deepEqual(keyScopes({ id: 'key_1', quotaMode: 'unlimited', quotaRules: rules }, '1.2.3.4'), [])
  assert.deepEqual(keyScopes({ id: 'key_1', quotaMode: 'total', quotaRules: rules }, '1.2.3.4'), [
    { scope: 'key:key_1', rules }
  ])
  assert.deepEqual(keyScopes({ id: 'key_1', quotaMode: 'per_ip', quotaRules: rules }, '1.2.3.4'), [
    { scope: 'key:key_1:1.2.3.4', rules }
  ])
  assert.deepEqual(keyScopes({ id: 'key_1', quotaMode: 'total', quotaRules: null }, '1.2.3.4'), [
    { scope: 'key:key_1', rules: [] }
  ])
  assert.deepEqual(keyScopes({ id: 'key_2', quotaMode: 'per_ip', quotaRules: null }, '5.6.7.8'), [
    { scope: 'key:key_2:5.6.7.8', rules: [] }
  ])
})

test('keyScopes filters disabled quota rules', () => {
  const rules = [
    { windowSeconds: 60, limitChars: 100, enabled: true, note: '' },
    { windowSeconds: 3600, limitChars: 1000, enabled: false, note: '停用' }
  ]
  const [scope] = keyScopes({ id: 'key_1', quotaMode: 'total', quotaRules: rules }, '1.2.3.4')
  assert.deepEqual(scope.rules, [rules[0]])
})

test('createKey normalizes quota rules and drops invalid ones', async () => {
  const DB = {
    prepare() {
      const statement = {
        bind() {
          return statement
        },
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
        first: async () => null
      }
      return statement
    }
  }
  const { key } = await createKey({ DB }, {
    name: 'k',
    quota_mode: 'total',
    quota_rules: [
      { window_seconds: 60, limit_chars: 10, enabled: false, note: 'off' },
      { window_seconds: 0, limit_chars: 5 },
      { window_seconds: 60, limit_chars: -1 }
    ]
  })
  assert.deepEqual(key.quotaRules, [{ windowSeconds: 60, limitChars: 10, enabled: false, note: 'off' }])
  assert.deepEqual(keyScopes(key, '1.2.3.4'), [{ scope: `key:${key.id}`, rules: [] }])
})

test('createKey treats string "false" enabled as disabled', async () => {
  const DB = {
    prepare() {
      const statement = {
        bind() {
          return statement
        },
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
        first: async () => null
      }
      return statement
    }
  }
  const { key } = await createKey({ DB }, { name: 'k', enabled: 'false' })
  assert.equal(key.enabled, false)
})

test('parseBearer parses Authorization header', () => {
  const withHeader = (value) => new Request('https://example.com/', { headers: { Authorization: value } })
  assert.equal(parseBearer(withHeader('Bearer sk-lorem-abc')), 'sk-lorem-abc')
  assert.equal(parseBearer(withHeader('bearer sk-lorem-abc')), 'sk-lorem-abc')
  assert.equal(parseBearer(withHeader('Bearer   sk-lorem-abc  ')), 'sk-lorem-abc')
  assert.equal(parseBearer(new Request('https://example.com/')), null)
  assert.equal(parseBearer(withHeader('sk-lorem-abc')), null)
  assert.equal(parseBearer(withHeader('Bearer ')), null)
  assert.equal(parseBearer(withHeader('Basic abc')), null)
})
