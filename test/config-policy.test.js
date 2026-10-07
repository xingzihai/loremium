import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveIpPolicy } from '../src/config.js'

// listRules has CACHE_TTL_MS = 0, so every resolveIpPolicy call re-queries the DB.
// Dispatch on the SQL text: rules list, override lookup and the group/member join.
function fakeDb({ rules = [], override = null, groups = [] } = {}) {
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
          return { meta: { changes: 1 } }
        },
        all: async () => {
          calls.push(s)
          if (sql.includes('ip_group_members')) return { results: groups }
          if (sql.includes('FROM rules')) return { results: rules }
          return { results: [] }
        },
        first: async () => {
          calls.push(s)
          if (sql.includes('FROM ip_overrides')) return override
          return null
        }
      }
      return s
    }
  }
  return { DB: db, calls }
}

const ruleRow = (id, windowSeconds, limitChars, enabled = 1) => ({
  id,
  window_seconds: windowSeconds,
  limit_chars: limitChars,
  enabled,
  note: null
})

const cfg = (over = {}) => ({ unlistedIpPolicy: 'allow', concurrencyLimit: 2, ...over })

const groupRow = (over) => ({
  priority: 100,
  concurrency: null,
  rules: null,
  created_at: 0,
  kind: 'ip',
  ...over
})

test('resolveIpPolicy: override wins over a matching group and global rules', async () => {
  const db = fakeDb({
    rules: [ruleRow(1, 60, 1000)],
    override: {
      ip: '10.0.0.1',
      concurrency: 7,
      rules: JSON.stringify([{ window_seconds: 30, limit_chars: 5 }]),
      expires_at: null,
      note: null
    },
    groups: [
      groupRow({ id: 'g1', name: 'G1', priority: 1, concurrency: 4, value: '10.0.0.1' })
    ]
  })
  const policy = await resolveIpPolicy(db, '10.0.0.1', cfg())
  assert.equal(policy.allowed, true)
  assert.equal(policy.source, 'override')
  assert.deepEqual(policy.rules, [{ windowSeconds: 30, limitChars: 5 }])
  assert.equal(policy.concurrency, 7)
  assert.equal(policy.unlistedPolicy, 'allow')
  assert.ok(
    !db.calls.some((c) => c.sql.includes('ip_group_members')),
    'override must short-circuit before querying groups'
  )
})

test('resolveIpPolicy: group match picks the lowest priority group first', async () => {
  const groups = [
    groupRow({
      id: 'g_low',
      name: 'low',
      priority: 1,
      concurrency: 4,
      rules: JSON.stringify([{ window_seconds: 10, limit_chars: 100 }]),
      value: '10.0.0.1'
    }),
    groupRow({
      id: 'g_high',
      name: 'high',
      priority: 2,
      concurrency: 9,
      rules: JSON.stringify([{ window_seconds: 20, limit_chars: 200 }]),
      value: '10.0.0.1'
    })
  ]
  const db = fakeDb({ rules: [ruleRow(1, 60, 1000)], groups })
  const policy = await resolveIpPolicy(db, '10.0.0.1', cfg())
  assert.equal(policy.allowed, true)
  assert.equal(policy.source, 'group')
  assert.equal(policy.groupId, 'g_low')
  assert.equal(policy.groupName, 'low')
  assert.deepEqual(policy.rules, [{ windowSeconds: 10, limitChars: 100 }])
  assert.equal(policy.concurrency, 4)
  const join = db.calls.find((c) => c.sql.includes('ip_group_members'))
  assert.ok(join, 'group join query should run')
  assert.ok(join.sql.includes('ORDER BY g.priority ASC'), 'join must order by ascending priority')
})

test('resolveIpPolicy: skips non-matching groups and inherits global rules when the group has none', async () => {
  const groups = [
    groupRow({ id: 'g_other', name: 'other', priority: 1, value: '192.168.0.1' }),
    groupRow({ id: 'g_hit', name: 'hit', priority: 2, concurrency: null, value: '10.9.9.9/32', kind: 'cidr' })
  ]
  const db = fakeDb({ rules: [ruleRow(1, 60, 1000), ruleRow(2, 120, 2000, 0)], groups })
  const policy = await resolveIpPolicy(db, '10.9.9.9', cfg())
  assert.equal(policy.source, 'group')
  assert.equal(policy.groupId, 'g_hit')
  assert.deepEqual(policy.rules, [{ windowSeconds: 60, limitChars: 1000 }])
  assert.equal(policy.concurrency, 2, 'null group concurrency falls back to config.concurrencyLimit')
})

test('resolveIpPolicy: deny policy rejects an ip that matches no layer', async () => {
  const db = fakeDb({ rules: [ruleRow(1, 60, 1000)], override: null, groups: [] })
  const policy = await resolveIpPolicy(db, '203.0.113.7', cfg({ unlistedIpPolicy: 'deny' }))
  assert.equal(policy.allowed, false)
  assert.equal(policy.source, 'unlisted')
  assert.deepEqual(policy.rules, [])
  assert.equal(policy.concurrency, 2)
  assert.equal(policy.unlistedPolicy, 'deny')
})

test('resolveIpPolicy: allow policy falls back to enabled global rules', async () => {
  const db = fakeDb({
    rules: [ruleRow(1, 60, 1000, 1), ruleRow(2, 120, 2000, 0)],
    groups: []
  })
  const policy = await resolveIpPolicy(db, '203.0.113.8', cfg())
  assert.equal(policy.allowed, true)
  assert.equal(policy.source, 'global')
  assert.deepEqual(policy.rules, [{ windowSeconds: 60, limitChars: 1000 }])
  assert.equal(policy.concurrency, 2)
})

test('resolveIpPolicy: empty override rules inherit global rules and concurrency falls back', async () => {
  const global = [ruleRow(1, 60, 1000, 1)]
  const inherit = fakeDb({
    rules: global,
    override: { ip: '10.1.1.1', concurrency: null, rules: null, expires_at: null, note: null }
  })
  const p1 = await resolveIpPolicy(inherit, '10.1.1.1', cfg())
  assert.equal(p1.source, 'override')
  assert.deepEqual(p1.rules, [{ windowSeconds: 60, limitChars: 1000 }])
  assert.equal(p1.concurrency, 2)

  const withConcurrency = fakeDb({
    rules: global,
    override: { ip: '10.1.1.1', concurrency: 9, rules: JSON.stringify([]), expires_at: null, note: null }
  })
  const p2 = await resolveIpPolicy(withConcurrency, '10.1.1.1', cfg())
  assert.equal(p2.source, 'override')
  assert.deepEqual(p2.rules, [{ windowSeconds: 60, limitChars: 1000 }])
  assert.equal(p2.concurrency, 9)
})
