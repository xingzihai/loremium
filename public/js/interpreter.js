export const PRESETS = {
  'unicode-garbage': '▓▒░█▄▀■□▪▫◘◙◆◇○●─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▔▕▏▎▍▌▋▊▉',
  'zero-width': '\u200B\u200C\u200D\u2060\uFEFF',
  'private-use': { range: ['U+E000', 'U+F8FF'] },
  'combining': { range: ['U+0300', 'U+036F'] },
  'ascii-noise': '!@#$%^&*()_+-=[]{}|;:,.<>?/~`'
}

const LOREM_WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ')

const MAX_DEPTH = 16
const MAX_NODES = 10000
const MAX_REPEAT = 1000000
const MAX_OPTIONS = 1024
const MAX_POOL = 16384
const MAX_STEPS = 50000000
const STOP = Symbol('budget')

export function truncateUtf16(text, maxChars) {
  if (!(maxChars > 0)) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

function parseUPlus(value) {
  if (typeof value !== 'string') return null
  const m = /^U\+([0-9A-Fa-f]{1,6})$/.exec(value)
  if (!m) return null
  const codePoint = parseInt(m[1], 16)
  if (codePoint > 0x10ffff) return null
  return codePoint
}

function validateOptions(options, path, add) {
  if (!Array.isArray(options)) {
    add(`${path}.options`, 'must be an array of strings')
    return
  }
  if (options.length < 1 || options.length > MAX_OPTIONS) {
    add(`${path}.options`, `must contain 1-${MAX_OPTIONS} items`)
  }
  for (let i = 0; i < options.length; i++) {
    if (typeof options[i] !== 'string') add(`${path}.options[${i}]`, 'must be a string')
  }
}

function validateWeighted(options, path, add) {
  if (!Array.isArray(options)) {
    add(`${path}.options`, 'must be an array of {value,weight}')
    return
  }
  if (options.length < 1 || options.length > MAX_OPTIONS) {
    add(`${path}.options`, `must contain 1-${MAX_OPTIONS} items`)
  }
  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      add(`${path}.options[${i}]`, 'must be an object {value,weight}')
      continue
    }
    if (typeof option.value !== 'string') add(`${path}.options[${i}].value`, 'must be a string')
    if (!Number.isInteger(option.weight) || option.weight <= 0) add(`${path}.options[${i}].weight`, 'must be a positive integer')
  }
}

function validateCount(value, path, add, label, max) {
  if (Number.isInteger(value)) {
    if (value < 0 || value > max) add(path, `${label} must be an integer between 0 and ${max}`)
    return
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const min = value.min
    const maxValue = value.max
    if (!Number.isInteger(min) || min < 0) add(`${path}.min`, `${label} min must be a non-negative integer`)
    if (!Number.isInteger(maxValue) || maxValue < 0) add(`${path}.max`, `${label} max must be a non-negative integer`)
    if (Number.isInteger(min) && Number.isInteger(maxValue) && maxValue < min) add(path, `${label} max must be >= min`)
    if (Number.isInteger(maxValue) && maxValue > max) add(`${path}.max`, `${label} max must be <= ${max}`)
    if (Number.isInteger(min) && min > max) add(`${path}.min`, `${label} min must be <= ${max}`)
    return
  }
  add(path, `${label} must be an integer or {min,max}`)
}

function validateIntRange(min, max, path, add, label) {
  if (!Number.isInteger(min) || min < 0) add(`${path}.min`, `${label} min must be a non-negative integer`)
  if (!Number.isInteger(max) || max < 0) add(`${path}.max`, `${label} max must be a non-negative integer`)
  if (Number.isInteger(min) && Number.isInteger(max) && max < min) add(path, `${label} max must be >= min`)
}

function validatePool(pool, path, add) {
  if (typeof pool === 'string') {
    if (Object.prototype.hasOwnProperty.call(PRESETS, pool)) return
    const length = Array.from(pool).length
    if (length < 1 || length > MAX_POOL) add(path, `literal charset length must be 1-${MAX_POOL} code points`)
    return
  }
  if (pool && typeof pool === 'object' && !Array.isArray(pool) && Array.isArray(pool.range)) {
    const start = parseUPlus(pool.range[0])
    const end = parseUPlus(pool.range[1])
    if (start === null) add(`${path}.range[0]`, 'must be a U+XXXX code point')
    if (end === null) add(`${path}.range[1]`, 'must be a U+XXXX code point')
    if (start !== null && end !== null && end < start) add(`${path}.range`, 'end must be >= start')
    return
  }
  add(path, 'must be a preset name, literal string, or {range:[start,end]}')
}

export function validateProgram(program) {
  const errors = []
  let count = 0
  const add = (path, message) => errors.push(`${path}: ${message}`)

  const walk = (node, path, depth) => {
    count += 1
    if (count > MAX_NODES) {
      if (count === MAX_NODES + 1) add('root', `node count exceeds ${MAX_NODES}`)
      return
    }
    if (depth > MAX_DEPTH) {
      add(path, `depth exceeds ${MAX_DEPTH}`)
      return
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      add(path, 'block must be an object')
      return
    }
    if (typeof node.type !== 'string') {
      add(path, 'block must have a string type')
      return
    }
    switch (node.type) {
      case 'text':
        if (typeof node.value !== 'string') add(`${path}.value`, 'must be a string')
        break
      case 'random':
        validateOptions(node.options, path, add)
        break
      case 'weighted':
        validateWeighted(node.options, path, add)
        break
      case 'charset':
        validatePool(node.pool, `${path}.pool`, add)
        validateIntRange(node.min, node.max, path, add, 'length')
        break
      case 'lorem':
        validateCount(node.words, `${path}.words`, add, 'word count', Infinity)
        if (node.capitalize !== undefined && typeof node.capitalize !== 'boolean') add(`${path}.capitalize`, 'must be a boolean')
        break
      case 'repeat':
        validateCount(node.times, `${path}.times`, add, 'times', MAX_REPEAT)
        walkChildren(node.children, path, depth, walk, add)
        break
      case 'sequence':
        walkChildren(node.children, path, depth, walk, add)
        break
      case 'rotate':
        if (typeof node.key !== 'string' || node.key.length === 0) add(`${path}.key`, 'must be a non-empty string')
        if (node.mode !== 'cycle' && node.mode !== 'random') add(`${path}.mode`, "must be 'cycle' or 'random'")
        if (node.scope !== 'ip' && node.scope !== 'global') add(`${path}.scope`, "must be 'ip' or 'global'")
        validateOptions(node.options, path, add)
        break
      case 'echo':
        if (node.source !== undefined && node.source !== 'all' && node.source !== 'last') {
          add(`${path}.source`, "must be 'all' or 'last'")
        }
        break
      default:
        add(`${path}.type`, `unknown block type ${JSON.stringify(node.type)}`)
    }
  }

  const walkChildren = (children, path, depth, visit, report) => {
    if (!Array.isArray(children)) {
      report(`${path}.children`, 'must be an array')
      return
    }
    for (let i = 0; i < children.length; i++) {
      visit(children[i], `${path}.children[${i}]`, depth + 1)
    }
  }

  walk(program, 'root', 1)
  return { ok: errors.length === 0, errors }
}

export function collectRotateKeys(program) {
  const result = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return
    if (node.type === 'rotate' && typeof node.key === 'string' && !seen.has(node.key)) {
      seen.add(node.key)
      result.push({
        key: node.key,
        mode: node.mode,
        scope: node.scope,
        count: Array.isArray(node.options) ? node.options.length : 0,
        options: node.options
      })
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1)
    }
  }
  walk(program, 1)
  return result
}

function randInt(min, max, rng) {
  min = Math.ceil(min)
  max = Math.floor(max)
  if (!(max >= min)) throw new Error('invalid random range')
  if (max === min) return min
  const span = max - min + 1
  const buffer = new Uint32Array(1)
  rng.getRandomValues(buffer)
  return min + (buffer[0] % span)
}

function resolvePool(pool, path) {
  if (typeof pool === 'string') {
    if (Object.prototype.hasOwnProperty.call(PRESETS, pool)) return resolvePool(PRESETS[pool], path)
    const chars = Array.from(pool)
    if (chars.length === 0) throw new Error(`${path}: empty charset pool`)
    return { kind: 'list', chars }
  }
  if (pool && typeof pool === 'object' && Array.isArray(pool.range)) {
    const start = parseUPlus(pool.range[0])
    const end = parseUPlus(pool.range[1])
    if (start === null || end === null || end < start) throw new Error(`${path}: invalid code point range`)
    return { kind: 'range', start, end }
  }
  throw new Error(`${path}: invalid charset pool`)
}

function resolveCount(value, rng, path) {
  if (Number.isInteger(value)) return value
  if (value && typeof value === 'object' && Number.isInteger(value.min) && Number.isInteger(value.max)) {
    return randInt(value.min, value.max, rng)
  }
  throw new Error(`${path}: invalid count`)
}

function append(state, chunk) {
  if (typeof chunk !== 'string') throw new Error('block produced a non-string value')
  if (chunk.length === 0) return
  const room = state.budget - state.out.length
  if (room <= 0) {
    state.truncated = true
    throw STOP
  }
  if (chunk.length > room) {
    state.out += truncateUtf16(chunk, room)
    state.truncated = true
    throw STOP
  }
  state.out += chunk
}

function emitCharset(node, state, path) {
  const pool = resolvePool(node.pool, path)
  const length = randInt(node.min, node.max, state.rng)
  if (pool.kind === 'range') {
    for (let i = 0; i < length; i++) append(state, String.fromCodePoint(randInt(pool.start, pool.end, state.rng)))
  } else {
    for (let i = 0; i < length; i++) append(state, pool.chars[randInt(0, pool.chars.length - 1, state.rng)])
  }
}

function emitLorem(node, state, path) {
  const count = resolveCount(node.words, state.rng, `${path}.words`)
  const capitalize = node.capitalize === true
  for (let i = 0; i < count; i++) {
    if (i > 0) append(state, ' ')
    let word = LOREM_WORDS[randInt(0, LOREM_WORDS.length - 1, state.rng)]
    if (capitalize && i === 0) word = word.charAt(0).toUpperCase() + word.slice(1)
    append(state, word)
  }
}

function pickWeighted(options, rng, path) {
  if (!Array.isArray(options) || options.length === 0) throw new Error(`${path}: weighted options must not be empty`)
  let total = 0
  for (const option of options) {
    const weight = option && Number.isInteger(option.weight) ? option.weight : 0
    if (weight <= 0) throw new Error(`${path}: invalid weight`)
    total += weight
  }
  let pick = randInt(0, total - 1, rng)
  for (const option of options) {
    pick -= option.weight
    if (pick < 0) return option.value
  }
  return options[options.length - 1].value
}

function rotationFor(key, rotations) {
  if (rotations instanceof Map) return rotations.get(key)
  if (rotations && typeof rotations === 'object') return rotations[key]
  return undefined
}

function countStep(state) {
  state.steps += 1
  if (state.steps > MAX_STEPS) {
    state.truncated = true
    throw STOP
  }
}

function evalNode(node, state, path) {
  countStep(state)
  if (!node || typeof node !== 'object') throw new Error(`${path}: invalid block`)
  switch (node.type) {
    case 'text':
      if (typeof node.value !== 'string') throw new Error(`${path}: text value must be a string`)
      append(state, node.value)
      break
    case 'random': {
      if (!Array.isArray(node.options) || node.options.length === 0) throw new Error(`${path}: random options must not be empty`)
      append(state, node.options[randInt(0, node.options.length - 1, state.rng)])
      break
    }
    case 'weighted':
      append(state, pickWeighted(node.options, state.rng, path))
      break
    case 'charset':
      emitCharset(node, state, path)
      break
    case 'lorem':
      emitLorem(node, state, path)
      break
    case 'repeat': {
      const times = resolveCount(node.times, state.rng, `${path}.times`)
      for (let i = 0; i < times; i++) {
        countStep(state)
        if (!Array.isArray(node.children)) throw new Error(`${path}: repeat children must be an array`)
        for (let j = 0; j < node.children.length; j++) evalNode(node.children[j], state, `${path}.children[${j}]`)
      }
      break
    }
    case 'sequence': {
      if (!Array.isArray(node.children)) throw new Error(`${path}: sequence children must be an array`)
      for (let i = 0; i < node.children.length; i++) evalNode(node.children[i], state, `${path}.children[${i}]`)
      break
    }
    case 'rotate': {
      if (!Array.isArray(node.options) || node.options.length === 0) throw new Error(`${path}: rotate options must not be empty`)
      const value = rotationFor(node.key, state.rotations)
      append(state, value === undefined || value === null ? node.options[0] : String(value))
      break
    }
    case 'echo':
      append(state, node.source === 'last' ? state.inputs.last : state.inputs.all)
      break
    default:
      throw new Error(`${path}: unknown block type ${JSON.stringify(node.type)}`)
  }
}

function normalizeInputs(opts) {
  const inputs = opts.inputs
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    return {
      all: typeof inputs.all === 'string' ? inputs.all : '',
      last: typeof inputs.last === 'string' ? inputs.last : ''
    }
  }
  if (typeof opts.input === 'string') return { all: opts.input, last: opts.input }
  return { all: '', last: '' }
}

export function interpret(program, opts = {}) {
  const budget = opts.budget === undefined ? Infinity : opts.budget
  const rotations = opts.rotations === undefined ? {} : opts.rotations
  const rng = opts.rng === undefined ? globalThis.crypto : opts.rng
  const inputs = normalizeInputs(opts)
  const state = { out: '', budget, rotations, rng, truncated: false, steps: 0, inputs }
  try {
    evalNode(program, state, 'root')
  } catch (error) {
    if (error !== STOP) throw error
  }
  return { text: state.out, truncated: state.truncated }
}
