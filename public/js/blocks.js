const VENDOR_BASE = new URL('../vendor/blockly/', import.meta.url)
const CORE_SRC = new URL('blockly.min.js', VENDOR_BASE).href
const MSG_SRC = new URL('msg/zh-hans.js', VENDOR_BASE).href
const MEDIA_PATH = new URL('media/', VENDOR_BASE).href

const MULTILINE_FIELD = 'field_multilinetext'

const PRESETS = ['unicode-garbage', 'zero-width', 'private-use', 'combining', 'ascii-noise']

const BLOCK_TYPE = {
  text: 'loremium_text',
  echo: 'loremium_echo',
  random: 'loremium_random',
  weighted: 'loremium_weighted',
  charset: 'loremium_charset',
  lorem: 'loremium_lorem',
  repeat: 'loremium_repeat',
  rotate: 'loremium_rotate'
}

const PROGRAM_TYPE = Object.fromEntries(
  Object.entries(BLOCK_TYPE).map(([programType, blockType]) => [blockType, programType])
)

const COLOUR = {
  content: 210,
  random: 160,
  loop: 120,
  advanced: 330
}

const TRIGGER_EVENTS = new Set(['create', 'delete', 'change', 'move'])

const BLOCK_DEFINITIONS = [
  {
    type: BLOCK_TYPE.text,
    message0: '文本 %1',
    args0: [{ type: MULTILINE_FIELD, name: 'VALUE', text: 'Hello ' }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.content,
    tooltip: '原样输出固定文本,支持换行'
  },
  {
    type: BLOCK_TYPE.echo,
    message0: '原样输出请求输入 %1',
    args0: [
      {
        type: 'field_dropdown',
        name: 'SOURCE',
        options: [
          ['全部输入', 'all'],
          ['最后一条用户消息', 'last']
        ]
      }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.content,
    tooltip: '把客户端本次请求的输入文本原样输出(仍受额度与预算截断)'
  },
  {
    type: BLOCK_TYPE.lorem,
    message0: 'Lorem 词数 %1 至 %2',
    args0: [
      { type: 'field_number', name: 'MIN', value: 5, min: 0, precision: 1 },
      { type: 'field_number', name: 'MAX', value: 20, min: 0, precision: 1 }
    ],
    message1: '首字母大写 %1',
    args1: [{ type: 'field_checkbox', name: 'CAPITALIZE', checked: true }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.content,
    tooltip: '从内置拉丁词表随机取词'
  },
  {
    type: BLOCK_TYPE.random,
    message0: '随机选择(每行一项) %1',
    args0: [{ type: MULTILINE_FIELD, name: 'OPTIONS', text: '▓\n▒\n░' }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.random,
    tooltip: '每行一个候选项,均匀随机取一项'
  },
  {
    type: BLOCK_TYPE.weighted,
    message0: '加权选择(每行“权重 内容”) %1',
    args0: [{ type: MULTILINE_FIELD, name: 'OPTIONS', text: '3 正常文本\n1 ▓▒░' }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.random,
    tooltip: '每行“权重 内容”,权重为正整数,按比例随机'
  },
  {
    type: BLOCK_TYPE.charset,
    message0: '字符池 %1',
    args0: [
      {
        type: 'field_dropdown',
        name: 'POOL',
        options: [
          ['乱码符号 unicode-garbage', 'unicode-garbage'],
          ['零宽字符 zero-width', 'zero-width'],
          ['私用区 private-use', 'private-use'],
          ['组合符号 combining', 'combining'],
          ['ASCII 噪音 ascii-noise', 'ascii-noise'],
          ['自定义字符', 'custom'],
          ['码点范围 U+XXXX', 'range']
        ]
      }
    ],
    message1: '长度 %1 至 %2',
    args1: [
      { type: 'field_number', name: 'MIN', value: 8, min: 0, precision: 1 },
      { type: 'field_number', name: 'MAX', value: 24, min: 0, precision: 1 }
    ],
    message2: '自定义字符 %1',
    args2: [{ type: 'field_input', name: 'CUSTOM', text: '▓▒░' }],
    message3: '码点范围 %1 至 %2',
    args3: [
      { type: 'field_input', name: 'RANGE_START', text: 'U+E000' },
      { type: 'field_input', name: 'RANGE_END', text: 'U+F8FF' }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.random,
    tooltip: '在指定字符池中随机生成指定长度的字符序列'
  },
  {
    type: BLOCK_TYPE.repeat,
    message0: '重复 %1 至 %2 次',
    args0: [
      { type: 'field_number', name: 'MIN', value: 1, min: 0, precision: 1 },
      { type: 'field_number', name: 'MAX', value: 5, min: 0, precision: 1 }
    ],
    message1: '执行 %1',
    args1: [{ type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.loop,
    tooltip: '重复执行内部积木随机次数'
  },
  {
    type: BLOCK_TYPE.rotate,
    message0: '轮换组 %1',
    args0: [{ type: 'field_input', name: 'KEY', text: 'greeting' }],
    message1: '模式 %1 范围 %2',
    args1: [
      {
        type: 'field_dropdown',
        name: 'MODE',
        options: [
          ['按次序轮转', 'cycle'],
          ['随机', 'random']
        ]
      },
      {
        type: 'field_dropdown',
        name: 'SCOPE',
        options: [
          ['每 IP', 'ip'],
          ['全局', 'global']
        ]
      }
    ],
    message2: '选项(每行一项) %1',
    args2: [{ type: MULTILINE_FIELD, name: 'OPTIONS', text: 'A\nB\nC' }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOUR.advanced,
    tooltip: '跨请求轮换输出,同 key 共享计数'
  }
]

const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: '内容',
      colour: String(COLOUR.content),
      contents: [
        { kind: 'block', type: BLOCK_TYPE.text },
        { kind: 'block', type: BLOCK_TYPE.echo },
        { kind: 'block', type: BLOCK_TYPE.lorem }
      ]
    },
    {
      kind: 'category',
      name: '随机',
      colour: String(COLOUR.random),
      contents: [
        { kind: 'block', type: BLOCK_TYPE.random },
        { kind: 'block', type: BLOCK_TYPE.weighted },
        { kind: 'block', type: BLOCK_TYPE.charset }
      ]
    },
    {
      kind: 'category',
      name: '循环',
      colour: String(COLOUR.loop),
      contents: [{ kind: 'block', type: BLOCK_TYPE.repeat }]
    },
    {
      kind: 'category',
      name: '高级',
      colour: String(COLOUR.advanced),
      contents: [{ kind: 'block', type: BLOCK_TYPE.rotate }]
    }
  ]
}

let blocklyPromise = null
let blocksRegistered = false

function injectScript(src, attr, value) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[${attr}="${value}"]`)
    if (existing) {
      if (existing.dataset.blocklyDone === '1') {
        resolve(existing)
        return
      }
      existing.addEventListener('load', () => resolve(existing), { once: true })
      existing.addEventListener('error', () => reject(new Error(`blockly_load_failed:${src}`)), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.setAttribute(attr, value)
    script.addEventListener(
      'load',
      () => {
        script.dataset.blocklyDone = '1'
        resolve(script)
      },
      { once: true }
    )
    script.addEventListener('error', () => reject(new Error(`blockly_load_failed:${src}`)), { once: true })
    document.head.appendChild(script)
  })
}

function createMultilineField(Blockly) {
  return class FieldMultilineText extends Blockly.FieldTextInput {
    constructor(value, validator, config) {
      super(value === undefined || value === null ? '' : value, validator, config)
    }

    static fromJson(options) {
      return new FieldMultilineText(options.text, undefined, options)
    }

    getText_() {
      if (this.isBeingEdited_) return super.getText_()
      const value = this.getValue()
      return typeof value === 'string' ? value.replace(/\n/g, ' ↵ ') : ''
    }

    widgetCreate_() {
      const textarea = document.createElement('textarea')
      textarea.setAttribute('spellcheck', 'false')
      textarea.className = 'blocklyHtmlInput blocklyMultilineInput'
      textarea.rows = 3
      textarea.style.resize = 'vertical'
      textarea.style.minHeight = '3em'
      return textarea
    }

    onHtmlInputKeyDown_(e) {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) return
      super.onHtmlInputKeyDown_(e)
    }
  }
}

function registerBlocks() {
  if (blocksRegistered) return
  const Blockly = globalThis.Blockly
  if (!Blockly || !Blockly.fieldRegistry || !Blockly.defineBlocksWithJsonArray) return
  Blockly.fieldRegistry.register(MULTILINE_FIELD, createMultilineField(Blockly))
  Blockly.defineBlocksWithJsonArray(BLOCK_DEFINITIONS)
  blocksRegistered = true
}

export function isBlocklyLoaded() {
  return !!globalThis.Blockly
}

export async function loadBlockly() {
  if (isBlocklyLoaded()) {
    registerBlocks()
    return globalThis.Blockly
  }
  if (!blocklyPromise) {
    blocklyPromise = (async () => {
      await injectScript(CORE_SRC, 'data-blockly', '1')
      if (!isBlocklyLoaded()) throw new Error('blockly_load_failed')
      try {
        await injectScript(MSG_SRC, 'data-blockly-msg', '1')
      } catch (error) {
        console.warn('[loremium] blockly messages failed to load', error)
      }
      registerBlocks()
      return globalThis.Blockly
    })().catch((error) => {
      blocklyPromise = null
      throw error
    })
  }
  return blocklyPromise
}

function intOr(value, fallback) {
  const num = typeof value === 'number' ? value : parseInt(value, 10)
  return Number.isFinite(num) ? num : fallback
}

function stringOr(value, fallback) {
  return value === undefined || value === null ? fallback : String(value)
}

function isChecked(value) {
  return value === true || value === 'TRUE' || value === 'true'
}

function splitLines(text) {
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function ensureOptions(options) {
  const list = Array.isArray(options) ? options.map((item) => String(item)) : []
  return list.length ? list : ['']
}

function linesText(options) {
  return Array.isArray(options) ? options.map((item) => String(item)).join('\n') : ''
}

function weightedText(options) {
  if (!Array.isArray(options)) return ''
  return options
    .map((option) => {
      const weight = intOr(option && option.weight, 1)
      const value = option && typeof option.value === 'string' ? option.value : ''
      return `${Math.max(1, weight)} ${value}`
    })
    .join('\n')
}

function parseWeighted(text) {
  const options = []
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, '')
    if (!trimmed) continue
    const match = /^(\d+)(?:\s+(.*))?$/.exec(trimmed)
    if (match) {
      options.push({
        value: match[2] === undefined ? '' : match[2],
        weight: Math.max(1, parseInt(match[1], 10))
      })
    } else {
      options.push({ value: trimmed, weight: 1 })
    }
  }
  return options.length ? options : [{ value: '', weight: 1 }]
}

function normalizeCodePoint(value) {
  const match = /^(?:U\+|u\+|0x|0X)?([0-9A-Fa-f]{1,6})$/.exec(String(value === undefined || value === null ? '' : value).trim())
  if (!match) return 'U+0000'
  const code = parseInt(match[1], 16)
  if (!Number.isFinite(code) || code > 0x10ffff) return 'U+0000'
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function flattenNodes(nodes) {
  const out = []
  if (!Array.isArray(nodes)) return out
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    if (node.type === 'sequence') {
      out.push(...flattenNodes(node.children))
    } else {
      out.push(node)
    }
  }
  return out
}

function applyCharsetFields(block, node) {
  const pool = node.pool
  if (pool && typeof pool === 'object' && Array.isArray(pool.range)) {
    block.setFieldValue('range', 'POOL')
    block.setFieldValue(String(pool.range[0] === undefined ? 'U+E000' : pool.range[0]), 'RANGE_START')
    block.setFieldValue(String(pool.range[1] === undefined ? 'U+F8FF' : pool.range[1]), 'RANGE_END')
  } else if (typeof pool === 'string' && PRESETS.includes(pool)) {
    block.setFieldValue(pool, 'POOL')
  } else if (typeof pool === 'string') {
    block.setFieldValue('custom', 'POOL')
    block.setFieldValue(pool, 'CUSTOM')
  } else {
    block.setFieldValue('unicode-garbage', 'POOL')
  }
  block.setFieldValue(intOr(node.min, 8), 'MIN')
  block.setFieldValue(intOr(node.max, 24), 'MAX')
}

function buildChain(workspace, connection, nodes) {
  let previous = null
  for (const node of nodes) {
    const block = buildBlock(workspace, node)
    if (!block) continue
    if (previous) {
      previous.nextConnection.connect(block.previousConnection)
    } else if (connection) {
      connection.connect(block.previousConnection)
    }
    previous = block
  }
  return previous
}

function buildBlock(workspace, node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'sequence') return null
  const blockType = BLOCK_TYPE[node.type]
  if (!blockType) return null
  let block
  try {
    block = workspace.newBlock(blockType)
  } catch (error) {
    console.warn('[loremium] cannot create block', node.type, error)
    return null
  }
  switch (node.type) {
    case 'text':
      block.setFieldValue(typeof node.value === 'string' ? node.value : '', 'VALUE')
      break
    case 'echo':
      block.setFieldValue(node.source === 'last' ? 'last' : 'all', 'SOURCE')
      break
    case 'random':
      block.setFieldValue(linesText(node.options), 'OPTIONS')
      break
    case 'weighted':
      block.setFieldValue(weightedText(node.options), 'OPTIONS')
      break
    case 'charset':
      applyCharsetFields(block, node)
      break
    case 'lorem': {
      const words = node.words
      const min = Number.isInteger(words) ? words : intOr(words && words.min, 5)
      const max = Number.isInteger(words) ? words : intOr(words && words.max, 20)
      block.setFieldValue(min, 'MIN')
      block.setFieldValue(max, 'MAX')
      block.setFieldValue(node.capitalize === true, 'CAPITALIZE')
      break
    }
    case 'repeat': {
      const times = node.times
      const min = Number.isInteger(times) ? times : intOr(times && times.min, 1)
      const max = Number.isInteger(times) ? times : intOr(times && times.max, 5)
      block.setFieldValue(min, 'MIN')
      block.setFieldValue(max, 'MAX')
      break
    }
    case 'rotate':
      block.setFieldValue(typeof node.key === 'string' ? node.key : 'group', 'KEY')
      block.setFieldValue(node.mode === 'random' ? 'random' : 'cycle', 'MODE')
      block.setFieldValue(node.scope === 'global' ? 'global' : 'ip', 'SCOPE')
      block.setFieldValue(linesText(node.options), 'OPTIONS')
      break
    default:
      return null
  }
  block.initSvg()
  block.render()
  if (node.type === 'repeat') {
    const input = block.getInput('DO')
    if (input && input.connection) buildChain(workspace, input.connection, flattenNodes(node.children))
  }
  return block
}

function compileChain(first) {
  const children = []
  let block = first
  while (block) {
    const node = compileBlock(block)
    if (node) children.push(node)
    block = block.getNextBlock()
  }
  return children
}

function compileCharset(block) {
  const mode = block.getFieldValue('POOL')
  let pool
  if (mode === 'custom') {
    const custom = stringOr(block.getFieldValue('CUSTOM'), '')
    pool = custom.length ? custom : 'unicode-garbage'
  } else if (mode === 'range') {
    pool = { range: [normalizeCodePoint(block.getFieldValue('RANGE_START')), normalizeCodePoint(block.getFieldValue('RANGE_END'))] }
  } else if (PRESETS.includes(mode)) {
    pool = mode
  } else {
    pool = 'unicode-garbage'
  }
  return {
    type: 'charset',
    pool,
    min: intOr(block.getFieldValue('MIN'), 8),
    max: intOr(block.getFieldValue('MAX'), 24)
  }
}

function compileBlock(block) {
  const programType = PROGRAM_TYPE[block.type]
  if (!programType) return null
  switch (programType) {
    case 'text':
      return { type: 'text', value: stringOr(block.getFieldValue('VALUE'), '') }
    case 'echo':
      return { type: 'echo', source: block.getFieldValue('SOURCE') === 'last' ? 'last' : 'all' }
    case 'random':
      return { type: 'random', options: ensureOptions(splitLines(block.getFieldValue('OPTIONS'))) }
    case 'weighted':
      return { type: 'weighted', options: parseWeighted(block.getFieldValue('OPTIONS')) }
    case 'charset':
      return compileCharset(block)
    case 'lorem': {
      const words = {
        min: intOr(block.getFieldValue('MIN'), 5),
        max: intOr(block.getFieldValue('MAX'), 20)
      }
      return { type: 'lorem', words, capitalize: isChecked(block.getFieldValue('CAPITALIZE')) }
    }
    case 'repeat': {
      const times = {
        min: intOr(block.getFieldValue('MIN'), 1),
        max: intOr(block.getFieldValue('MAX'), 5)
      }
      return { type: 'repeat', times, children: compileChain(block.getInputTargetBlock('DO')) }
    }
    case 'rotate':
      return {
        type: 'rotate',
        key: stringOr(block.getFieldValue('KEY'), ''),
        mode: block.getFieldValue('MODE') === 'random' ? 'random' : 'cycle',
        scope: block.getFieldValue('SCOPE') === 'global' ? 'global' : 'ip',
        options: ensureOptions(splitLines(block.getFieldValue('OPTIONS')))
      }
    default:
      return null
  }
}

export function compileToProgram(workspace) {
  if (!workspace) throw new Error('workspace_required')
  const children = []
  for (const top of workspace.getTopBlocks(true)) {
    children.push(...compileChain(top))
  }
  return { type: 'sequence', children }
}

export async function mountBlocklyEditor(container, options = {}) {
  const Blockly = await loadBlockly()
  if (!container) throw new Error('container_required')
  const workspace = Blockly.inject(container, {
    toolbox: TOOLBOX,
    media: MEDIA_PATH,
    renderer: 'geras',
    grid: { spacing: 24, length: 3, colour: '#d8dee9', snap: true },
    zoom: { controls: true, wheel: true, startScale: 1, maxScale: 2.5, minScale: 0.4 },
    trashcan: true,
    sounds: false,
    move: { scrollbars: true, drag: true, wheel: true }
  })

  let timer = null
  let disposed = false

  const listener = (event) => {
    if (disposed || !event || event.isUiEvent || !TRIGGER_EVENTS.has(event.type)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed || typeof options.onChange !== 'function') return
      try {
        options.onChange(compileToProgram(workspace))
      } catch (error) {
        console.error('[loremium] blockly onChange failed', error)
      }
    }, 300)
  }
  workspace.addChangeListener(listener)

  const load = (program) => {
    Blockly.Events.disable()
    try {
      workspace.clear()
      if (program && typeof program === 'object') {
        const nodes = flattenNodes(program.type === 'sequence' ? program.children : [program])
        buildChain(workspace, null, nodes)
        workspace.cleanUp()
      }
    } finally {
      Blockly.Events.enable()
    }
    Blockly.svgResize(workspace)
  }

  if (options.initial !== undefined && options.initial !== null) load(options.initial)

  let observer = null
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => Blockly.svgResize(workspace))
    observer.observe(container)
  }
  setTimeout(() => {
    if (!disposed) Blockly.svgResize(workspace)
  }, 0)

  return {
    getProgram() {
      return compileToProgram(workspace)
    },
    setProgram(program) {
      if (!disposed) load(program)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      if (observer) observer.disconnect()
      workspace.removeChangeListener(listener)
      workspace.dispose()
    }
  }
}
