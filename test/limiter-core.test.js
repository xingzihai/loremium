import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pickRotation,
  remainingForRules,
  retryAfterForRules,
  sumWindow,
  truncateUtf16
} from '../src/limiter-core.js'

test('sumWindow sums entries inside the window', () => {
  const now = 100000
  assert.equal(sumWindow([], now, 60000), 0)
  assert.equal(sumWindow(undefined, now, 60000), 0)
  assert.equal(sumWindow([{ ts: now - 1000, chars: 3 }, { ts: now - 59000, chars: 4 }], now, 60000), 7)
})

test('sumWindow drops entries at or past the window edge', () => {
  const now = 100000
  assert.equal(sumWindow([{ ts: now - 60000, chars: 5 }], now, 60000), 0)
  assert.equal(sumWindow([{ ts: now - 60001, chars: 5 }], now, 60000), 0)
  assert.equal(sumWindow([{ ts: now - 59999, chars: 5 }], now, 60000), 5)
})

test('remainingForRules returns Infinity without rules', () => {
  assert.equal(remainingForRules({}, [], 0), Infinity)
  assert.equal(remainingForRules({}, undefined, 0), Infinity)
  assert.equal(remainingForRules({}, [{ windowSeconds: 60, limitChars: 10 }], 0), 10)
})

test('remainingForRules takes the minimum across rules', () => {
  const now = 100000
  const windows = {
    60: [{ ts: now - 1000, chars: 10 }],
    300: [{ ts: now - 1000, chars: 70 }]
  }
  const rules = [
    { windowSeconds: 60, limitChars: 15 },
    { windowSeconds: 300, limitChars: 100 }
  ]
  assert.equal(remainingForRules(windows, rules, now), 5)
})

test('remainingForRules treats missing windows as unused and can go negative', () => {
  const now = 100000
  const rules = [{ windowSeconds: 60, limitChars: 10 }]
  assert.equal(remainingForRules({}, rules, now), 10)
  assert.equal(remainingForRules({ 60: [{ ts: now - 1, chars: 25 }] }, rules, now), -15)
})

test('retryAfterForRules waits for the slowest exhausted rule', () => {
  const now = 100000
  const windows = {
    60: [{ ts: now - 1000, chars: 5 }],
    300: [{ ts: now - 10000, chars: 5 }]
  }
  const rules = [
    { windowSeconds: 60, limitChars: 5 },
    { windowSeconds: 300, limitChars: 5 }
  ]
  assert.equal(retryAfterForRules(windows, rules, now), 290000)
})

test('retryAfterForRules accumulates released chars until quota frees up', () => {
  const now = 100000
  const windows = { 60: [{ ts: now - 1000, chars: 1 }, { ts: now - 59000, chars: 12 }] }
  const rules = [{ windowSeconds: 60, limitChars: 10 }]
  assert.equal(retryAfterForRules(windows, rules, now), 1000)
})

test('retryAfterForRules returns 0 when usage is under the limit', () => {
  const now = 100000
  assert.equal(retryAfterForRules({ 60: [{ ts: now - 1000, chars: 3 }] }, [{ windowSeconds: 60, limitChars: 10 }], now), 0)
})

test('retryAfterForRules returns 0 without entries or rules', () => {
  const now = 100000
  assert.equal(retryAfterForRules({}, [], now), 0)
  assert.equal(retryAfterForRules({ 60: [] }, [{ windowSeconds: 60, limitChars: 5 }], now), 0)
  assert.equal(retryAfterForRules({ 60: [{ ts: now - 60000, chars: 5 }] }, [{ windowSeconds: 60, limitChars: 5 }], now), 0)
})

test('truncateUtf16 never splits surrogate pairs', () => {
  assert.equal(truncateUtf16('abcdef', 3), 'abc')
  assert.equal(truncateUtf16('abcdef', 10), 'abcdef')
  assert.equal(truncateUtf16('a😀b', 2), 'a')
  assert.equal(truncateUtf16('a😀b', 3), 'a😀')
  assert.equal(truncateUtf16('😀😀', 1), '')
  assert.equal(truncateUtf16('😀😀', 2), '😀')
  assert.equal(truncateUtf16('abc', 0), '')
  assert.equal(truncateUtf16('abc', -1), '')
})

test('pickRotation cycles with the counter', () => {
  const options = ['a', 'b', 'c']
  assert.equal(pickRotation('cycle', options.length, options, 0), 'a')
  assert.equal(pickRotation('cycle', options.length, options, 1), 'b')
  assert.equal(pickRotation('cycle', options.length, options, 2), 'c')
  assert.equal(pickRotation('cycle', options.length, options, 3), 'a')
})

test('pickRotation random stays within options', () => {
  const options = ['x', 'y', 'z']
  for (let i = 0; i < 100; i++) {
    assert.ok(options.includes(pickRotation('random', options.length, options, i)))
  }
})

test('pickRotation random uses the crypto source', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (array) => { array[0] = 7; return array } }
  })
  try {
    assert.equal(pickRotation('random', 3, ['a', 'b', 'c'], 0), 'b')
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('pickRotation handles empty options', () => {
  assert.equal(pickRotation('cycle', 0, [], 0), undefined)
  assert.equal(pickRotation('random', 0, undefined, 0), undefined)
})
