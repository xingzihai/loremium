import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, validateProgram, collectRotateKeys, interpret, truncateUtf16 } from '../public/js/interpreter.js'
import { estimatePromptTokens, generateContent } from '../src/generator.js'

function seededRng(seed) {
  let a = seed >>> 0
  return {
    getRandomValues(buffer) {
      for (let i = 0; i < buffer.length; i++) {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        buffer[i] = (t ^ (t >>> 14)) >>> 0
      }
      return buffer
    }
  }
}

function nest(depth, inner) {
  let node = inner
  for (let i = 1; i < depth; i++) node = { type: 'sequence', children: [node] }
  return node
}

const validProgram = {
  type: 'sequence',
  children: [
    { type: 'text', value: 'Hello ' },
    { type: 'random', options: ['a', 'b'] },
    { type: 'weighted', options: [{ value: 'x', weight: 3 }, { value: 'y', weight: 1 }] },
    { type: 'charset', pool: 'ascii-noise', min: 1, max: 3 },
    { type: 'lorem', words: { min: 1, max: 2 }, capitalize: true },
    { type: 'repeat', times: { min: 1, max: 2 }, children: [{ type: 'text', value: '!' }] },
    { type: 'rotate', key: 'greeting', mode: 'cycle', scope: 'ip', options: ['A', 'B'] }
  ]
}

test('valid program passes validation', () => {
  const result = validateProgram(validProgram)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('PRESETS expose the required shapes', () => {
  assert.equal(typeof PRESETS['unicode-garbage'], 'string')
  for (const ch of '▓▒░█▄▀■□▪▫◘◙◆◇○●') assert.ok(PRESETS['unicode-garbage'].includes(ch))
  assert.equal(PRESETS['unicode-garbage'].length > 20, true)
  assert.equal(PRESETS['zero-width'], '\u200B\u200C\u200D\u2060\uFEFF')
  assert.deepEqual(PRESETS['private-use'], { range: ['U+E000', 'U+F8FF'] })
  assert.deepEqual(PRESETS['combining'], { range: ['U+0300', 'U+036F'] })
  assert.equal(typeof PRESETS['ascii-noise'], 'string')
  assert.ok(PRESETS['ascii-noise'].includes('!'))
  assert.ok(PRESETS['ascii-noise'].includes('`'))
})

test('validation accepts max depth 16 and rejects depth 17', () => {
  assert.equal(validateProgram(nest(16, { type: 'text', value: 'x' })).ok, true)
  const result = validateProgram(nest(17, { type: 'text', value: 'x' }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('depth')))
})

test('validation enforces the node count limit', () => {
  const okChildren = Array.from({ length: 9999 }, (_, i) => ({ type: 'text', value: String(i) }))
  assert.equal(validateProgram({ type: 'sequence', children: okChildren }).ok, true)
  const tooMany = Array.from({ length: 10000 }, (_, i) => ({ type: 'text', value: String(i) }))
  const result = validateProgram({ type: 'sequence', children: tooMany })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('node count')))
})

test('validation enforces the repeat limit with field paths', () => {
  assert.equal(validateProgram({ type: 'repeat', times: 1000000, children: [] }).ok, true)
  assert.equal(validateProgram({ type: 'repeat', times: { min: 1, max: 1000000 }, children: [] }).ok, true)
  const over = validateProgram({ type: 'repeat', times: 1000001, children: [] })
  assert.equal(over.ok, false)
  assert.ok(over.errors.some((e) => e.startsWith('root.times')))
  const range = validateProgram({
    type: 'sequence',
    children: [{ type: 'repeat', times: { min: 1, max: 1000001 }, children: [] }]
  })
  assert.equal(range.ok, false)
  assert.ok(range.errors.some((e) => e.includes('root.children[0].times')))
})

test('validation bounds random and weighted options to 1-1024', () => {
  assert.equal(validateProgram({ type: 'random', options: new Array(1024).fill('x') }).ok, true)
  assert.equal(validateProgram({ type: 'random', options: [] }).ok, false)
  assert.equal(validateProgram({ type: 'random', options: new Array(1025).fill('x') }).ok, false)
  assert.equal(validateProgram({ type: 'weighted', options: [] }).ok, false)
  const weighted = new Array(1025).fill({ value: 'x', weight: 1 })
  assert.equal(validateProgram({ type: 'weighted', options: weighted }).ok, false)
  const badWeight = validateProgram({ type: 'weighted', options: [{ value: 'x', weight: 0 }] })
  assert.ok(badWeight.errors.some((e) => e.includes('root.options[0].weight')))
  assert.equal(validateProgram({ type: 'rotate', key: 'k', mode: 'cycle', scope: 'ip', options: new Array(1025).fill('x') }).ok, false)
})

test('validation checks charset pools', () => {
  assert.equal(validateProgram({ type: 'charset', pool: 'zero-width', min: 1, max: 2 }).ok, true)
  assert.equal(validateProgram({ type: 'charset', pool: { range: ['U+E000', 'U+F8FF'] }, min: 1, max: 2 }).ok, true)
  assert.equal(validateProgram({ type: 'charset', pool: '▓▒░', min: 1, max: 2 }).ok, true)
  assert.equal(validateProgram({ type: 'charset', pool: '', min: 1, max: 2 }).ok, false)
  assert.equal(validateProgram({ type: 'charset', pool: 'x'.repeat(16384), min: 1, max: 2 }).ok, true)
  assert.equal(validateProgram({ type: 'charset', pool: 'x'.repeat(16385), min: 1, max: 2 }).ok, false)
  assert.equal(validateProgram({ type: 'charset', pool: { range: ['U+ZZZZ', 'U+F8FF'] }, min: 1, max: 2 }).ok, false)
  assert.equal(validateProgram({ type: 'charset', pool: { range: ['U+0100', 'U+0000'] }, min: 1, max: 2 }).ok, false)
  assert.equal(validateProgram({ type: 'charset', pool: { range: ['U+E000', 'U+F8FF'] }, min: 5, max: 2 }).ok, false)
})

test('validation reports missing and mistyped fields', () => {
  assert.equal(validateProgram(null).ok, false)
  assert.equal(validateProgram({ type: 'nope' }).ok, false)
  assert.equal(validateProgram({ type: 'text', value: 3 }).ok, false)
  assert.equal(validateProgram({ type: 'lorem', words: 'many' }).ok, false)
  assert.equal(validateProgram({ type: 'repeat', times: 1 }).ok, false)
  const badRotate = validateProgram({ type: 'rotate', key: '', mode: 'x', scope: 'y', options: ['a'] })
  assert.ok(badRotate.errors.some((e) => e.includes('root.key')))
  assert.ok(badRotate.errors.some((e) => e.includes('root.mode')))
  assert.ok(badRotate.errors.some((e) => e.includes('root.scope')))
})

test('collectRotateKeys gathers unique keys with shape', () => {
  const program = {
    type: 'sequence',
    children: [
      { type: 'rotate', key: 'a', mode: 'cycle', scope: 'ip', options: ['1', '2', '3'] },
      { type: 'rotate', key: 'b', mode: 'random', scope: 'global', options: ['x'] },
      { type: 'rotate', key: 'a', mode: 'cycle', scope: 'ip', options: ['1', '2', '3'] }
    ]
  }
  const keys = collectRotateKeys(program)
  assert.equal(keys.length, 2)
  assert.deepEqual(keys[0], { key: 'a', mode: 'cycle', scope: 'ip', count: 3, options: ['1', '2', '3'] })
  assert.deepEqual(keys[1], { key: 'b', mode: 'random', scope: 'global', count: 1, options: ['x'] })
})

test('interpret concatenates sequence and text', () => {
  const result = interpret({ type: 'sequence', children: [{ type: 'text', value: 'ab' }, { type: 'text', value: 'cd' }] })
  assert.deepEqual(result, { text: 'abcd', truncated: false })
})

test('interpret echo outputs the full input by default', () => {
  const program = { type: 'echo' }
  assert.equal(interpret(program, { inputs: { all: '甲\n乙', last: '乙' } }).text, '甲\n乙')
  assert.equal(interpret(program, { input: '甲\n乙' }).text, '甲\n乙')
})

test('interpret echo source last outputs the last input', () => {
  const program = { type: 'echo', source: 'last' }
  assert.equal(interpret(program, { inputs: { all: '甲\n乙', last: '乙' } }).text, '乙')
  assert.equal(interpret(program, { input: '甲\n乙' }).text, '甲\n乙')
})

test('interpret echo falls back to an empty string for missing or non-string inputs', () => {
  assert.equal(interpret({ type: 'echo' }).text, '')
  assert.equal(interpret({ type: 'echo', source: 'last' }).text, '')
  assert.equal(interpret({ type: 'echo' }, { inputs: { all: 5, last: null } }).text, '')
  assert.equal(interpret({ type: 'echo', source: 'last' }, { inputs: { all: 'a', last: 9 } }).text, '')
  assert.equal(interpret({ type: 'echo' }, { input: 42 }).text, '')
})

test('validation accepts echo sources all, last, and omitted', () => {
  assert.equal(validateProgram({ type: 'echo' }).ok, true)
  assert.equal(validateProgram({ type: 'echo', source: 'all' }).ok, true)
  assert.equal(validateProgram({ type: 'echo', source: 'last' }).ok, true)
  const result = validateProgram({ type: 'echo', source: 'other' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.startsWith('root.source')))
})

test('interpret preserves newlines in text blocks', () => {
  assert.equal(interpret({ type: 'text', value: 'a\nb' }).text, 'a\nb')
})

test('interpret truncates on budget without splitting surrogate pairs', () => {
  const plain = interpret({ type: 'sequence', children: [{ type: 'text', value: 'abcdef' }, { type: 'text', value: 'ghij' }] }, { budget: 4 })
  assert.deepEqual(plain, { text: 'abcd', truncated: true })
  const emoji = interpret({ type: 'sequence', children: [{ type: 'text', value: '😀😀' }, { type: 'text', value: 'Z' }] }, { budget: 3 })
  assert.equal(emoji.text, '😀')
  assert.equal(emoji.truncated, true)
  assert.equal(/[\uD800-\uDBFF]$/.test(emoji.text), false)
  const tight = interpret({ type: 'text', value: '😀😀' }, { budget: 1 })
  assert.deepEqual(tight, { text: '', truncated: true })
  const exact = interpret({ type: 'text', value: 'abc' }, { budget: 3 })
  assert.deepEqual(exact, { text: 'abc', truncated: false })
  const exactThenMore = interpret({ type: 'sequence', children: [{ type: 'text', value: 'abc' }, { type: 'text', value: 'd' }] }, { budget: 3 })
  assert.deepEqual(exactThenMore, { text: 'abc', truncated: true })
  const shorter = interpret({ type: 'text', value: 'abc' }, { budget: 10 })
  assert.deepEqual(shorter, { text: 'abc', truncated: false })
  const unlimited = interpret({ type: 'text', value: 'abc' }, {})
  assert.deepEqual(unlimited, { text: 'abc', truncated: false })
})

test('truncateUtf16 never cuts a surrogate pair', () => {
  assert.equal(truncateUtf16('abcdef', 3), 'abc')
  assert.equal(truncateUtf16('abc', 5), 'abc')
  assert.equal(truncateUtf16('abc', 0), '')
  assert.equal(truncateUtf16('😀😀', 3), '😀')
  assert.equal(truncateUtf16('😀', 1), '')
})

test('interpret supports charset presets and ranges', () => {
  const zeroWidth = interpret({ type: 'charset', pool: 'zero-width', min: 8, max: 8 }, { rng: seededRng(1) })
  assert.equal(Array.from(zeroWidth.text).length, 8)
  for (const ch of zeroWidth.text) assert.ok(PRESETS['zero-width'].includes(ch))

  const garbage = interpret({ type: 'charset', pool: 'unicode-garbage', min: 40, max: 40 }, { rng: seededRng(2) })
  assert.equal(Array.from(garbage.text).length, 40)
  const garbageSet = new Set(Array.from(PRESETS['unicode-garbage']))
  for (const ch of garbage.text) assert.ok(garbageSet.has(ch))

  const letters = interpret({ type: 'charset', pool: { range: ['U+0041', 'U+005A'] }, min: 50, max: 50 }, { rng: seededRng(3) })
  assert.equal(letters.text.length, 50)
  for (const ch of letters.text) {
    const cp = ch.codePointAt(0)
    assert.ok(cp >= 0x41 && cp <= 0x5a)
  }

  const emoji = interpret({ type: 'charset', pool: { range: ['U+1F600', 'U+1F60F'] }, min: 12, max: 12 }, { rng: seededRng(4) })
  assert.equal(Array.from(emoji.text).length, 12)
  for (const ch of emoji.text) {
    const cp = ch.codePointAt(0)
    assert.ok(cp >= 0x1f600 && cp <= 0x1f60f)
  }

  const literal = interpret({ type: 'charset', pool: '▓▒░', min: 20, max: 20 }, { rng: seededRng(5) })
  assert.equal(literal.text.length, 20)
  for (const ch of literal.text) assert.ok('▓▒░'.includes(ch))
})

test('interpret lorem produces the requested word count', () => {
  assert.equal(interpret({ type: 'lorem', words: 5 }).text.split(' ').length, 5)
  assert.equal(interpret({ type: 'lorem', words: { min: 7, max: 7 } }).text.split(' ').length, 7)
  const capitalized = interpret({ type: 'lorem', words: 3, capitalize: true }).text
  assert.match(capitalized, /^[A-Z]/)
  const lower = interpret({ type: 'lorem', words: 3 }).text
  assert.match(lower, /^[a-z]/)
})

test('interpret repeat honours integer and range times', () => {
  assert.equal(interpret({ type: 'repeat', times: 4, children: [{ type: 'text', value: 'x' }] }).text, 'xxxx')
  const ranged = interpret({ type: 'repeat', times: { min: 3, max: 3 }, children: [{ type: 'text', value: 'ab' }] })
  assert.equal(ranged.text, 'ababab')
})

test('interpret stops runaway empty repeats within the step limit', () => {
  const program = { type: 'repeat', times: 10000, children: [{ type: 'repeat', times: 10000, children: [] }] }
  const started = performance.now()
  const result = interpret(program)
  const elapsed = performance.now() - started
  assert.equal(result.text, '')
  assert.equal(result.truncated, true)
  assert.ok(elapsed < 5000, `elapsed=${elapsed}ms`)
})

test('interpret still truncates chatty programs at the budget', () => {
  const program = { type: 'repeat', times: 10000, children: [{ type: 'text', value: 'a' }] }
  const result = interpret(program, { budget: 5000 })
  assert.equal(result.text.length, 5000)
  assert.equal(result.text, 'a'.repeat(5000))
  assert.equal(result.truncated, true)
})

test('interpret leaves small programs unchanged under the step limit', () => {
  const program = {
    type: 'sequence',
    children: [
      { type: 'text', value: 'Hello ' },
      { type: 'repeat', times: 3, children: [{ type: 'text', value: 'ab' }] },
      { type: 'text', value: '!' }
    ]
  }
  assert.deepEqual(interpret(program), { text: 'Hello ababab!', truncated: false })
})

test('interpret rotate uses provided value and falls back to first option', () => {
  const program = { type: 'rotate', key: 'g', mode: 'cycle', scope: 'ip', options: ['A', 'B'] }
  assert.equal(interpret(program, { rotations: {} }).text, 'A')
  assert.equal(interpret(program, { rotations: { g: 'B' } }).text, 'B')
  assert.equal(interpret(program).text, 'A')
})

test('interpret weighted respects weights roughly', () => {
  const program = { type: 'weighted', options: [{ value: 'common', weight: 9 }, { value: 'rare', weight: 1 }] }
  const rng = seededRng(12345)
  let rare = 0
  const samples = 4000
  for (let i = 0; i < samples; i++) {
    const result = interpret(program, { rng, budget: 64 })
    assert.ok(result.text === 'common' || result.text === 'rare')
    if (result.text === 'rare') rare += 1
  }
  assert.ok(rare > 100 && rare < 800, `rare=${rare}`)
})

test('interpret throws on malformed nodes', () => {
  assert.throws(() => interpret({ type: 'nope' }))
  assert.throws(() => interpret(null))
  assert.throws(() => interpret({ type: 'random', options: [] }))
  assert.throws(() => interpret({ type: 'rotate', key: 'k', options: [] }))
})

test('generator estimates tokens and delegates to interpret', () => {
  const messages = [{ role: 'user', content: 'hello world' }]
  assert.equal(estimatePromptTokens(messages), Math.ceil(JSON.stringify(messages).length / 4))
  assert.deepEqual(generateContent({ type: 'text', value: 'hi' }, { budget: 10, rotations: {} }), { text: 'hi', truncated: false })
  assert.deepEqual(generateContent({ type: 'text', value: 'abcdef' }, { budget: 3, rotations: {} }), { text: 'abc', truncated: true })
})
