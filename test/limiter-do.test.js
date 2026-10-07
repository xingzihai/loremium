import test from 'node:test'
import assert from 'node:assert/strict'

import { Limiter } from '../src/limiter-do.js'

function makeLimiter() {
  const limiter = Object.create(Limiter.prototype)
  limiter.ctx = { storage: { setAlarm: async () => {} } }
  limiter.sql = { exec: () => {} }
  limiter.buckets = new Map()
  limiter.leases = new Map()
  limiter.reservations = new Map()
  limiter.reservationSeq = 0
  limiter.rotations = new Map()
  limiter.liveKeyIps = new Map()
  limiter.keyIpsCount = new Map()
  limiter.dirtyBuckets = new Map()
  limiter.dirtyRotations = new Set()
  limiter.dirtyInflight = new Set()
  limiter.dirtyKeyIps = new Set()
  limiter.deletedKeyIps = new Set()
  limiter.lastInflightWrite = 0
  limiter.alarmAt = null
  return limiter
}

function rulesScopes() {
  return [{ scope: 'ip:1.2.3.4', rules: [{ windowSeconds: 60, limitChars: 100 }] }]
}

test('acquire reserves quota and settle records only the used amount', async () => {
  const limiter = makeLimiter()
  const acq = await limiter.acquire({
    ip: '1.2.3.4',
    concurrencyLimit: 2,
    reserveCap: 100,
    maxDurationMs: 1000,
    scopes: rulesScopes()
  })
  assert.equal(acq.ok, true)
  assert.equal(acq.reserved, 100)
  const entries = limiter.buckets.get('ip:1.2.3.4')['60']
  assert.equal(entries.length, 1)
  assert.equal(entries[0].pending, acq.reservationId)
  await limiter.settle({ ip: '1.2.3.4', used: 10, reservationId: acq.reservationId })
  assert.equal(entries[0].chars, 10)
  assert.equal('pending' in entries[0], false)
  assert.equal(limiter.leases.get('1.2.3.4').length, 0)
})

test('settle recovers pending reservations after a DO restart', async () => {
  const limiter = makeLimiter()
  limiter.buckets.set('ip:1.2.3.4', { 60: [{ ts: Date.now(), chars: 100, pending: 'res-x' }] })
  limiter.leases.set('1.2.3.4', [Date.now() + 60000])
  await limiter.settle({ ip: '1.2.3.4', used: 7, reservationId: 'res-x' })
  const entry = limiter.buckets.get('ip:1.2.3.4')['60'][0]
  assert.equal(entry.chars, 7)
  assert.equal('pending' in entry, false)
  assert.equal(limiter.leases.get('1.2.3.4').length, 0)
})

test('settle releases the lease even when no reservation can be matched', async () => {
  const limiter = makeLimiter()
  limiter.leases.set('1.2.3.4', [Date.now() + 60000])
  await limiter.settle({ ip: '1.2.3.4', used: 0, reservationId: 'missing' })
  assert.equal(limiter.leases.get('1.2.3.4').length, 0)
})

test('repeated settle for the same reservation does not double count', async () => {
  const limiter = makeLimiter()
  const acq = await limiter.acquire({
    ip: '1.2.3.4',
    concurrencyLimit: 2,
    reserveCap: 100,
    maxDurationMs: 1000,
    scopes: rulesScopes()
  })
  await limiter.settle({ ip: '1.2.3.4', used: 10, reservationId: acq.reservationId })
  await limiter.settle({ ip: '1.2.3.4', used: 999, reservationId: acq.reservationId })
  const entries = limiter.buckets.get('ip:1.2.3.4')['60']
  assert.equal(entries.length, 1)
  assert.equal(entries[0].chars, 10)
})

test('acquire rejects when concurrency is exhausted', async () => {
  const limiter = makeLimiter()
  limiter.leases.set('1.2.3.4', [Date.now() + 60000])
  const acq = await limiter.acquire({
    ip: '1.2.3.4',
    concurrencyLimit: 1,
    reserveCap: 100,
    maxDurationMs: 1000,
    scopes: rulesScopes()
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'concurrency')
})

test('acquire rejects when quota is exhausted and reports a positive retry', async () => {
  const limiter = makeLimiter()
  limiter.buckets.set('ip:1.2.3.4', { 60: [{ ts: Date.now() - 1000, chars: 100 }] })
  const acq = await limiter.acquire({
    ip: '1.2.3.4',
    concurrencyLimit: 2,
    reserveCap: 100,
    maxDurationMs: 1000,
    scopes: rulesScopes()
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'quota')
  assert.ok(acq.retryAfterMs > 0 && acq.retryAfterMs <= 60000)
})

test('reset with keyId clears live key ips for that key only', async () => {
  const limiter = makeLimiter()
  limiter.liveKeyIps.set('k1\u0000a', { keyId: 'k1', ip: 'a', firstSeen: 1, lastSeen: 2, requests: 1 })
  limiter.liveKeyIps.set('k2\u0000b', { keyId: 'k2', ip: 'b', firstSeen: 1, lastSeen: 2, requests: 1 })
  limiter.keyIpsCount.set('k1', 1)
  limiter.keyIpsCount.set('k2', 1)
  await limiter.reset({ scopes: [], keyId: 'k1' })
  assert.equal(limiter.liveKeyIps.size, 1)
  assert.equal(limiter.liveKeyIps.has('k2\u0000b'), true)
  assert.equal(limiter.keyIpsCount.has('k1'), false)
  assert.equal(limiter.keyIpsCount.has('k2'), true)
})
