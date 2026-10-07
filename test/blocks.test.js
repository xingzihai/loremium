import test from 'node:test'
import assert from 'node:assert/strict'

import { compileToProgram } from '../public/js/blocks.js'

// blocks.js only touches the DOM inside loadBlockly/mountBlocklyEditor, so the
// pure compiler can be driven in Node with a minimal fake Blockly workspace.
function block(type, fields = {}, { next = null, doBlock = null } = {}) {
  return {
    type,
    getFieldValue: (name) => fields[name],
    getNextBlock: () => next,
    getInputTargetBlock: () => doBlock
  }
}

function ws(...tops) {
  return { getTopBlocks: () => tops }
}

test('compileToProgram throws without a workspace', () => {
  assert.throws(() => compileToProgram(null), /workspace_required/)
  assert.throws(() => compileToProgram(undefined), /workspace_required/)
})

test('compileToProgram walks chained top blocks into a sequence', () => {
  const second = block('loremium_text', { VALUE: 'B' })
  const first = block('loremium_text', { VALUE: 'A' }, { next: second })
  const program = compileToProgram(ws(first))
  assert.deepEqual(program, {
    type: 'sequence',
    children: [
      { type: 'text', value: 'A' },
      { type: 'text', value: 'B' }
    ]
  })
})

test('compileToProgram parses weighted options (weight, default and bare line)', () => {
  const program = compileToProgram(
    ws(block('loremium_weighted', { OPTIONS: '3 正常文本\n1 ▓▒░\nbare line' }))
  )
  assert.deepEqual(program.children, [
    {
      type: 'weighted',
      options: [
        { value: '正常文本', weight: 3 },
        { value: '▓▒░', weight: 1 },
        { value: 'bare line', weight: 1 }
      ]
    }
  ])
})

test('compileToProgram falls back to a single empty weighted option', () => {
  const program = compileToProgram(ws(block('loremium_weighted', { OPTIONS: '' })))
  assert.deepEqual(program.children[0].options, [{ value: '', weight: 1 }])
})

test('compileToProgram normalizes charset code point ranges', () => {
  const program = compileToProgram(
    ws(
      block('loremium_charset', {
        POOL: 'range',
        RANGE_START: 'u+e000',
        RANGE_END: '0XF8FF',
        MIN: 4,
        MAX: 8
      })
    )
  )
  assert.deepEqual(program.children, [
    { type: 'charset', pool: { range: ['U+E000', 'U+F8FF'] }, min: 4, max: 8 }
  ])
})

test('compileToProgram maps invalid and out-of-range code points to U+0000', () => {
  const invalid = compileToProgram(
    ws(block('loremium_charset', { POOL: 'range', RANGE_START: 'not-hex', RANGE_END: '110000' }))
  )
  assert.deepEqual(invalid.children[0].pool, { range: ['U+0000', 'U+0000'] })

  const padded = compileToProgram(
    ws(block('loremium_charset', { POOL: 'range', RANGE_START: '1f600', RANGE_END: '0' }))
  )
  assert.deepEqual(padded.children[0].pool, { range: ['U+1F600', 'U+0000'] })
})

test('compileToProgram compiles nested repeat children', () => {
  const child = block('loremium_text', { VALUE: 'inner' })
  const rep = block('loremium_repeat', { MIN: 2, MAX: 3 }, { doBlock: child })
  const program = compileToProgram(ws(rep))
  assert.deepEqual(program.children, [
    {
      type: 'repeat',
      times: { min: 2, max: 3 },
      children: [{ type: 'text', value: 'inner' }]
    }
  ])
})
