const API_BASE = '/admin/api'
const CONFIG_KEYS = [
  'first_delay_ms',
  'chars_per_second',
  'chunk_size',
  'max_duration_s',
  'max_output_chars',
  'concurrency_limit',
  'over_limit_behavior',
  'default_model',
  'strict_model',
  'cors_origin',
  'auth_mode',
  'unlisted_ip_policy',
  'stats_tz_offset',
  'request_log_enabled',
  'request_log_retention_days'
]

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }
const RULE_PRESETS = [
  { label: '5 分钟 / 5000 字符', seconds: 300, value: 5, unit: 'minutes', limitChars: 5000 },
  { label: '15 分钟 / 1 万字符', seconds: 900, value: 15, unit: 'minutes', limitChars: 10000 },
  { label: '1 小时 / 2 万字符', seconds: 3600, value: 1, unit: 'hours', limitChars: 20000 },
  { label: '1 天 / 10 万字符', seconds: 86400, value: 1, unit: 'days', limitChars: 100000 }
]
const TABS = ['dashboard', 'limits', 'keys', 'content', 'behavior', 'ip']
const CONFIG_NUMBER_FIELDS = [
  { key: 'first_delay_ms', label: '首字延迟', min: 0, max: 60000, integer: true },
  { key: 'chars_per_second', label: '输出速度', min: 0.5, max: 1000, integer: false },
  { key: 'chunk_size', label: '分块大小', min: 1, max: 256, integer: true },
  { key: 'max_duration_s', label: '时长上限', min: 1, max: null, integer: true },
  { key: 'max_output_chars', label: '单次输出字符上限', min: 1, max: null, integer: true },
  { key: 'concurrency_limit', label: '每 IP 并发上限', min: 1, max: null, integer: true },
  { key: 'stats_tz_offset', label: '统计时区偏移', min: -720, max: 840, integer: true },
  { key: 'request_log_retention_days', label: '日志保留天数', min: 1, max: 90, integer: true }
]
const ZERO_WIDTH_MAP = { '\u200B': 'U+200B', '\u200C': 'U+200C', '\u200D': 'U+200D', '\u2060': 'U+2060', '\uFEFF': 'U+FEFF' }
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g
const QUOTA_MODE_LABELS = { unlimited: '不限', per_ip: '按 IP 独立', total: '总额度' }
const ERROR_MAP = {
  'invalid json': '提交的数据格式有误，请刷新页面后重试',
  invalid_program: '内容方案未通过校验，请查看校验结果',
  not_found: '目标不存在或已被删除，请刷新列表后重试',
  key_not_found: '该 Key 不存在或已被删除，请刷新列表',
  group_not_found: '该 IP 组不存在或已被删除，请刷新列表',
  'missing ip': '缺少 IP 参数，请检查输入',
  Forbidden: '没有权限执行该操作（管理员登录可能已失效，请重新登录）',
  'Internal server error': '服务器内部错误，请稍后重试',
  'cannot delete default profile': '默认方案不能删除，请先把其他方案设为默认',
  invalid_rule_window: '规则窗口必须大于 0，请检查后重试',
  invalid_rule_limit: '规则限额必须大于等于 0，请检查后重试'
}

const NETWORK_ERROR_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i

function humanizeError(message) {
  const text = String(message == null ? '' : message)
  if (!text) return '操作失败，请重试'
  if (NETWORK_ERROR_RE.test(text)) return '网络连接失败，请检查网络后重试'
  return ERROR_MAP[text] || text
}

function humanizeDetail(text) {
  return String(text == null ? '' : text)
    .replace(/^root\.children\[(\d+)\]\.type/, (m, i) => `第 ${Number(i) + 1} 个顶层积木`)
    .replace(/^root\.children\[(\d+)\]/, (m, i) => `第 ${Number(i) + 1} 个顶层积木`)
    .replace(/unknown block type ("[^"]*")/, '未知积木类型 $1')
    .replace(/must be an array of strings/g, '必须是字符串数组')
    .replace(/must be a string/g, '必须是字符串')
    .replace(/must be a boolean/g, '必须是布尔值')
    .replace(/must be a positive integer/g, '必须是正整数')
    .replace(/must be a non-negative integer/g, '必须是非负整数')
    .replace(/must be an integer between (\d+) and (\d+)/g, '必须是 $1 到 $2 之间的整数')
    .replace(/must be an integer or \{min,max\}/g, '必须是整数或 {min,max} 对象')
    .replace(/must be >=/g, '必须大于等于 ')
    .replace(/must be <=/g, '必须小于等于 ')
    .replace(/must be 'cycle' or 'random'/g, "必须是 'cycle' 或 'random'")
    .replace(/must be 'ip' or 'global'/g, "必须是 'ip' 或 'global'")
    .replace(/must be 'all' or 'last'/g, "必须是 'all' 或 'last'")
    .replace(/must be a preset name, literal string, or \{range:\[start,end\]\}/g, '必须是预设名、字面量字符串或 {range:[start,end]} 对象')
    .replace(/must be a U\+XXXX code point/g, '必须是 U+XXXX 形式的码点')
    .replace(/literal charset length must be 1-(\d+) code points/g, '字符池长度必须在 1-$1 个码点之间')
    .replace(/end must be >= start/g, '结束码点不能小于起始码点')
}

let blocksModule = null
let blocklyHandle = null

async function request(method, path, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(API_BASE + path, init)
  let payload = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  if (!res.ok || !payload || payload.ok !== true) {
    const message = payload && payload.error ? payload.error : `请求失败(HTTP ${res.status})`
    const error = new Error(message)
    error.status = res.status
    error.payload = payload
    throw error
  }
  return payload.data
}

function bestWindowUnit(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return { unit: 'seconds', factor: 1 }
  if (value % 86400 === 0) return { unit: 'days', factor: 86400 }
  if (value % 3600 === 0) return { unit: 'hours', factor: 3600 }
  if (value % 60 === 0) return { unit: 'minutes', factor: 60 }
  return { unit: 'seconds', factor: 1 }
}

function humanWindowText(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return `${seconds} 秒`
  const best = bestWindowUnit(value)
  const labels = { seconds: '秒', minutes: '分钟', hours: '小时', days: '天' }
  return `${value / best.factor} ${labels[best.unit]}`
}

function formatNum(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return value == null ? '' : String(value)
  return String(num)
}

function humanRuleText(rule) {
  if (!rule || typeof rule !== 'object') return ''
  const windowSeconds = rule.windowSeconds != null ? rule.windowSeconds : rule.window_seconds
  const limitChars = rule.limitChars != null ? rule.limitChars : rule.limit_chars
  if (windowSeconds == null && limitChars == null) return '未限制'
  const parts = []
  if (windowSeconds != null) parts.push(`每 ${humanWindowText(windowSeconds)}`)
  if (limitChars != null) parts.push(`最多 ${formatNum(limitChars)} 字符`)
  return parts.join('')
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return { windowSeconds: 300, limitChars: 10000, enabled: true, note: '' }
  const windowSeconds = rule.windowSeconds != null ? rule.windowSeconds : rule.window_seconds
  const limitChars = rule.limitChars != null ? rule.limitChars : rule.limit_chars
  return {
    windowSeconds: windowSeconds == null ? null : Number(windowSeconds),
    limitChars: limitChars == null ? null : Number(limitChars),
    enabled: rule.enabled !== false,
    note: rule.note || ''
  }
}

function ruleDraft(rule) {
  const normalized = normalizeRule(rule)
  const hasWindow = Number.isFinite(normalized.windowSeconds) && normalized.windowSeconds > 0
  const best = bestWindowUnit(hasWindow ? normalized.windowSeconds : 300)
  return {
    id: rule && rule.id != null ? rule.id : null,
    value: hasWindow ? normalized.windowSeconds / best.factor : 5,
    unit: hasWindow ? best.unit : 'minutes',
    limitChars: Number.isFinite(normalized.limitChars) ? normalized.limitChars : 10000,
    enabled: normalized.enabled,
    note: normalized.note
  }
}

function ruleToApi(draft, keepId) {
  const factor = UNIT_SECONDS[draft.unit] || 1
  const windowSeconds = Math.max(1, Math.round(Number(draft.value) * factor))
  const limitChars = Math.max(0, Math.round(Number(draft.limitChars)))
  const rule = {
    windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : 300,
    limitChars: Number.isFinite(limitChars) ? limitChars : 0,
    enabled: draft.enabled !== false,
    note: draft.note || ''
  }
  if (keepId && draft.id != null) rule.id = draft.id
  return rule
}

function stripRuleId(rule) {
  return { windowSeconds: rule.windowSeconds, limitChars: rule.limitChars, enabled: rule.enabled, note: rule.note }
}

function emptyProfile() {
  return {
    id: null,
    name: '',
    modelId: '',
    isDefault: false,
    enabled: true,
    firstDelayMs: '',
    charsPerSecond: '',
    programText: '{\n  "type": "sequence",\n  "children": []\n}'
  }
}

function emptyOverride() {
  return { ip: '', concurrency: '', rules: [], expires_at: '', note: '', editing: false }
}

function emptyGroup() {
  return { id: null, name: '', priority: 100, concurrency: '', enabled: true, note: '', rules: [], open: false }
}

function emptyKey() {
  return {
    id: null,
    name: '',
    quota_mode: 'unlimited',
    quotaRules: [{ windowSeconds: 3600, limitChars: 20000, enabled: true, note: '' }],
    expires_at: '',
    note: ''
  }
}

const admin = {
  tab: 'dashboard',
  error: '',
  needsLogin: false,
  toasts: [],
  _toastSeq: 0,

  overviewRange: '24',
  overview: { requests: 0, chars: 0, errors: 0, activeIps: 0, series: [] },

  config: {},
  fieldErrors: {},
  savingConfig: false,

  profiles: [],
  profileForm: emptyProfile(),
  profileSnapshot: null,
  profileMode: 'json',
  savingProfile: false,
  blockly: { loading: false, error: '' },
  validateResult: null,
  preview: null,

  rules: [],

  overrides: [],
  overrideForm: emptyOverride(),
  savingOverride: false,

  ipGroups: [],
  groupForm: emptyGroup(),
  savingGroup: false,
  membersPanel: { open: false, groupId: null, groupName: '', list: [], text: '', invalid: [], addedCount: 0, loading: false, saving: false },

  ruleEditor: { open: false, kind: '', title: '', targetId: null, rules: [] },
  ruleEditorError: '',
  savingRules: false,
  rulePresets: RULE_PRESETS,

  ipQuery: { ip: '' },
  ipResolve: null,
  ipStatus: null,

  keys: [],
  openKeyMenu: null,
  keyForm: emptyKey(),
  savingKey: false,
  keyDetail: { open: false, tab: 'usage', keyId: null, keyName: '' },
  detailSeq: 0,
  keyUsage: null,
  keyIps: [],
  keyIpsOpen: false,
  keyStatus: null,
  logPanel: { open: false, mode: 'key', keyId: null, keyName: '', ip: '', items: [], nextBefore: null, loading: false },
  createdKey: null,
  async init() {
    const hashTab = (location.hash || '').replace(/^#/, '')
    if (TABS.includes(hashTab)) this.tab = hashTab
    window.addEventListener('hashchange', () => {
      const tab = (location.hash || '').replace(/^#/, '')
      if (TABS.includes(tab)) this.tab = tab
    })
    window.addEventListener('beforeunload', (event) => {
      if (this.profileIsDirty() || this.ruleEditorIsDirty()) {
        event.preventDefault()
        event.returnValue = ''
      }
    })
    await Promise.all([
      this.loadOverview(),
      this.loadConfig(),
      this.loadProfiles(),
      this.loadRules(),
      this.loadOverrides(),
      this.loadIpGroups(),
      this.loadKeys()
    ])
  },

  setTab(tab) {
    if (!TABS.includes(tab)) return
    this.tab = tab
    if (location.hash !== `#${tab}`) location.hash = tab
  },

  notify(message) {
    const id = ++this._toastSeq
    this.toasts.push({ id, message })
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    }, 3200)
  },

  showError(err) {
    const message = err && err.message ? err.message : String(err)
    this.error = humanizeError(message)
    if (NETWORK_ERROR_RE.test(message)) this.needsLogin = true
  },

  async guard(fn) {
    try {
      await fn()
      this.needsLogin = false
    } catch (err) {
      this.showError(err)
    }
  },

  async loadOverview() {
    const seq = (this.overviewSeq = (this.overviewSeq || 0) + 1)
    await this.guard(async () => {
      const range = String(this.overviewRange)
      const path = range === 'today' ? '/overview?range=today' : `/overview?hours=${encodeURIComponent(range)}`
      const data = await request('GET', path)
      if (seq !== this.overviewSeq) return
      this.overview = {
        requests: data && data.requests != null ? data.requests : 0,
        chars: data && data.chars != null ? data.chars : 0,
        errors: data && data.errors != null ? data.errors : 0,
        activeIps: data && data.activeIps != null ? data.activeIps : 0,
        series: data && Array.isArray(data.series) ? data.series : [],
        unavailable: !!(data && data.unavailable),
        note: data && data.note ? data.note : ''
      }
    })
  },

  barHeight(value) {
    return Math.max(4, Math.round(((value || 0) / this.seriesMax(this.overview.series)) * 120))
  },

  usageBarHeight(value) {
    const series = this.keyUsage && this.keyUsage.series ? this.keyUsage.series : []
    return Math.max(4, Math.round(((value || 0) / this.seriesMax(series)) * 100))
  },

  seriesMax(series) {
    const list = Array.isArray(series) ? series : []
    return Math.max(1, ...list.map((s) => s.requests || 0))
  },

  overviewMax() {
    return this.seriesMax(this.overview.series)
  },

  usageMax() {
    return this.seriesMax(this.keyUsage && this.keyUsage.series ? this.keyUsage.series : [])
  },

  tickEvery(total) {
    if (!Number.isFinite(total) || total <= 24) return 1
    return Math.ceil(total / 12)
  },

  timeTickLabel(t, hours) {
    if (!t) return ''
    const date = new Date(t)
    if (Number.isNaN(date.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    if (Number.isFinite(hours) && hours > 24) return `${date.getMonth() + 1}/${date.getDate()}`
    return `${p(date.getHours())}:00`
  },

  chartTickLabel(t) {
    const range = String(this.overviewRange)
    const hours = range === 'today' ? 24 : Number(range)
    return this.timeTickLabel(t, Number.isFinite(hours) ? hours : 24)
  },

  usageTickLabel(t) {
    return this.timeTickLabel(t, 168)
  },

  fmtTime(sec) {
    if (!sec) return ''
    const date = new Date(sec * 1000)
    if (Number.isNaN(date.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
  },

  fmtTimeAny(value) {
    if (value == null || value === '') return ''
    let numeric = null
    if (typeof value === 'number' && Number.isFinite(value)) numeric = value
    else if (/^\d+$/.test(String(value))) numeric = Number(value)
    if (numeric != null) return this.fmtTime(numeric >= 1e12 ? numeric / 1000 : numeric)
    const str = String(value)
    const date = new Date(str)
    if (Number.isNaN(date.getTime())) return str
    const p = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
  },

  toLocalInput(sec) {
    if (!sec) return ''
    const date = new Date(sec * 1000)
    const p = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`
  },

  fromLocalInput(value) {
    if (!value) return null
    const t = Date.parse(value)
    return Number.isFinite(t) ? Math.floor(t / 1000) : null
  },

  async loadConfig() {
    await this.guard(async () => {
      const data = await request('GET', '/config')
      this.config = data && typeof data === 'object' ? data : {}
      this.fieldErrors = {}
      if (this.config.auth_mode !== 'off' && this.config.auth_mode !== 'optional' && this.config.auth_mode !== 'required') {
        this.config.auth_mode = 'optional'
      }
      if (this.config.unlisted_ip_policy !== 'deny') this.config.unlisted_ip_policy = 'allow'
      if (this.config.stats_tz_offset == null || this.config.stats_tz_offset === '') this.config.stats_tz_offset = 480
      const logEnabled = this.config.request_log_enabled
      this.config.request_log_enabled = logEnabled === true || logEnabled === 'true'
      if (this.config.request_log_retention_days == null || this.config.request_log_retention_days === '') {
        this.config.request_log_retention_days = 7
      }
    })
  },

  authModeHint() {
    switch (this.config.auth_mode) {
      case 'off':
        return '⚠ 危险：所有人无需 Key 即可调用，仅建议内网或自测时使用；提供了无效 Key 仍会拒绝。'
      case 'required':
        return '必须：没有有效 Key 的请求返回 401。'
      default:
        return '可选：无 Key 也能用（仅受 IP 限流）；带有效 Key 则叠加 Key 配额。'
    }
  },

  validateConfigFields() {
    const errors = {}
    for (const field of CONFIG_NUMBER_FIELDS) {
      const raw = this.config[field.key]
      if (raw === '' || raw == null) {
        errors[field.key] = `请填写${field.label}`
        continue
      }
      const num = Number(raw)
      if (!Number.isFinite(num)) {
        errors[field.key] = `${field.label}必须是数字`
        continue
      }
      if (field.integer && !Number.isInteger(num)) {
        errors[field.key] = `${field.label}必须是整数`
        continue
      }
      if (num < field.min) {
        errors[field.key] = `${field.label}不能小于 ${field.min}`
        continue
      }
      if (field.max != null && num > field.max) {
        errors[field.key] = `${field.label}不能大于 ${field.max}`
      }
    }
    this.fieldErrors = errors
    return Object.keys(errors)
  },

  async saveConfig() {
    if (this.savingConfig) return
    if (this.validateConfigFields().length) {
      this.showError(new Error('配置中有无效项，请检查标红的输入框'))
      return
    }
    this.savingConfig = true
    try {
      await this.guard(async () => {
        const body = {}
        for (const key of CONFIG_KEYS) body[key] = String(this.config[key] == null ? '' : this.config[key])
        this.config = await request('PUT', '/config', body)
        this.notify('配置已保存')
      })
    } finally {
      this.savingConfig = false
    }
  },

  async loadProfiles() {
    await this.guard(async () => {
      const data = await request('GET', '/profiles')
      this.profiles = Array.isArray(data) ? data : []
      const untouched = !this.profileForm.id && !this.profileForm.name && this.profileForm.programText === emptyProfile().programText
      if (untouched && this.profiles.length > 0) {
        this.editProfile(this.profiles[0])
      }
    })
  },

  profileExamples: [
    { key: 'echo', label: '回显请求输入', program: { type: 'sequence', children: [{ type: 'echo', source: 'last' }] } },
    {
      key: 'random',
      label: '随机中文乱码',
      program: { type: 'sequence', children: [{ type: 'charset', pool: { range: ['U+4E00', 'U+9FA5'] }, min: 30, max: 120 }] }
    },
    { key: 'lorem', label: 'Lorem 占位', program: { type: 'sequence', children: [{ type: 'lorem', words: 80, capitalize: true }] } },
    {
      key: 'cycle',
      label: '轮换问候语',
      program: {
        type: 'sequence',
        children: [{ type: 'rotate', key: 'greeting', mode: 'cycle', scope: 'global', options: ['你好', 'Hello', 'こんにちは'] }]
      }
    }
  ],

  insertProfileExample(kind) {
    const example = this.profileExamples.find((e) => e.key === kind)
    if (!example) return
    if (!this.confirmDiscardProfile()) return
    this.profileForm.programText = JSON.stringify(example.program, null, 2)
    if (this.profileMode === 'blocks') this.applyProgramToBlocks(example.program)
    this.validateResult = null
    this.preview = null
  },

  newProfile() {
    if (!this.confirmDiscardProfile()) return
    this.profileForm = emptyProfile()
    this.validateResult = null
    this.preview = null
    this.applyProgramToBlocks(null)
    this.syncProfileSnapshot()
  },

  editProfile(profile) {
    if (!this.confirmDiscardProfile()) return
    this.profileForm = {
      id: profile.id,
      name: profile.name,
      modelId: profile.modelId,
      isDefault: !!profile.isDefault,
      enabled: profile.enabled !== false,
      firstDelayMs: profile.firstDelayMs == null ? '' : profile.firstDelayMs,
      charsPerSecond: profile.charsPerSecond == null ? '' : profile.charsPerSecond,
      programText: JSON.stringify(profile.program || {}, null, 2)
    }
    this.validateResult = null
    this.preview = null
    this.applyProgramToBlocks(profile.program)
    this.syncProfileSnapshot()
  },

  profileSnapshotValue() {
    const form = this.profileForm
    return JSON.stringify({
      name: form.name,
      modelId: form.modelId,
      isDefault: form.isDefault,
      enabled: form.enabled,
      firstDelayMs: form.firstDelayMs,
      charsPerSecond: form.charsPerSecond,
      programText: form.programText
    })
  },

  profilePacingText(profile) {
    const parts = []
    if (profile && profile.firstDelayMs != null) parts.push(`延迟 ${profile.firstDelayMs}ms`)
    if (profile && profile.charsPerSecond != null) parts.push(`${profile.charsPerSecond} 字/秒`)
    return parts.join(' · ')
  },

  syncProfileSnapshot() {
    this.profileSnapshot = this.profileSnapshotValue()
  },

  profileIsDirty() {
    if (!this.profileSnapshot) return false
    return this.profileSnapshotValue() !== this.profileSnapshot
  },

  confirmDiscardProfile() {
    return !this.profileIsDirty() || confirm('当前方案有未保存的修改，确定放弃吗？')
  },

  trapFocus(event) {
    const container = event.currentTarget
    if (!container || typeof container.querySelectorAll !== 'function') return
    const nodes = Array.from(
      container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.disabled && el.offsetParent !== null)
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  },

  confirmCloseCreatedKey() {
    if (confirm('明文仅显示这一次，关闭后将无法再查看，确认关闭吗？')) this.createdKey = null
  },

  parseProgram() {
    try {
      return { ok: true, program: JSON.parse(this.profileForm.programText) }
    } catch (err) {
      return { ok: false, error: `JSON 解析失败:${err.message}` }
    }
  },

  applyProgramToBlocks(program) {
    if (!blocklyHandle || typeof blocklyHandle.setProgram !== 'function') return
    try {
      blocklyHandle.setProgram(program || null)
    } catch (err) {
      this.blockly.error = `积木内容载入失败:${err && err.message ? err.message : err}`
    }
  },

  syncBlocksToText() {
    if (!blocklyHandle || typeof blocklyHandle.getProgram !== 'function') return
    try {
      const program = blocklyHandle.getProgram()
      if (program !== undefined) this.profileForm.programText = JSON.stringify(program, null, 2)
    } catch (err) {
      this.blockly.error = `读取积木内容失败:${err && err.message ? err.message : err}`
    }
  },

  disposeBlocks() {
    if (blocklyHandle && typeof blocklyHandle.dispose === 'function') {
      try {
        blocklyHandle.dispose()
      } catch (err) {}
    }
    blocklyHandle = null
  },

  async ensureBlockly() {
    if (blocksModule) return true
    this.blockly.loading = true
    this.blockly.error = ''
    try {
      const mod = await import('/js/blocks.js')
      if (!mod || typeof mod.mountBlocklyEditor !== 'function') throw new Error('blocks.js 未提供编辑器接口')
      if (typeof mod.loadBlockly === 'function') await mod.loadBlockly()
      blocksModule = mod
      return true
    } catch (err) {
      this.blockly.error = '积木编辑器加载失败,已回退到 JSON 编辑'
      return false
    } finally {
      this.blockly.loading = false
    }
  },

  async mountBlocks() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const host = document.getElementById('blockly-host')
    if (!host || !blocksModule) return
    let initial = null
    try {
      initial = JSON.parse(this.profileForm.programText)
    } catch (err) {
      this.profileMode = 'json'
      this.showError(new Error('JSON 解析失败，已留在 JSON 模式，请先修正内容'))
      return
    }
    this.disposeBlocks()
    try {
      blocklyHandle = await blocksModule.mountBlocklyEditor(host, {
        initial,
        onChange: (program) => {
          try {
            this.profileForm.programText = typeof program === 'string' ? program : JSON.stringify(program, null, 2)
          } catch (err) {}
        }
      })
      this.syncBlocksToText()
    } catch (err) {
      blocklyHandle = null
      this.blockly.error = '积木编辑器初始化失败,已回退到 JSON 编辑'
      this.profileMode = 'json'
      this.showError(new Error(this.blockly.error))
    }
  },

  async setProfileMode(mode) {
    if (mode === this.profileMode) return
    if (mode === 'blocks') {
      const parsed = this.parseProgram()
      if (!parsed.ok) {
        this.showError(new Error(`${parsed.error}；已留在 JSON 模式，请先修正后再切换到积木编辑`))
        return
      }
      const ready = await this.ensureBlockly()
      if (!ready) {
        this.profileMode = 'json'
        this.showError(new Error(this.blockly.error || '积木编辑器加载失败'))
        return
      }
      this.profileMode = 'blocks'
      await this.mountBlocks()
      return
    }
    this.syncBlocksToText()
    this.disposeBlocks()
    this.profileMode = 'json'
  },

  async validateProfile() {
    if (this.profileMode === 'blocks') this.syncBlocksToText()
    await this.guard(async () => {
      const parsed = this.parseProgram()
      if (!parsed.ok) {
        this.validateResult = { ok: false, errors: [parsed.error] }
        return
      }
      this.validateResult = await request('POST', '/profiles/validate', { program: parsed.program })
    })
  },

  async previewProfile() {
    if (this.profileMode === 'blocks') this.syncBlocksToText()
    await this.guard(async () => {
      const parsed = this.parseProgram()
      if (!parsed.ok) throw new Error(parsed.error)
      const mod = await import('/js/interpreter.js')
      const result = mod.interpret(parsed.program, {
        budget: 2000,
        inputs: { all: '示例输入第一行\n示例输入第二行', last: '示例输入第一行\n示例输入第二行' }
      })
      this.preview = {
        text: result && typeof result.text === 'string' ? result.text : '',
        truncated: !!(result && result.truncated)
      }
    })
  },

  previewDisplay() {
    if (!this.preview) return ''
    return String(this.preview.text || '').replace(ZERO_WIDTH_RE, (ch) => `[${ZERO_WIDTH_MAP[ch] || ch}]`)
  },

  async saveProfile() {
    if (this.profileMode === 'blocks') this.syncBlocksToText()
    if (this.savingProfile) return
    this.savingProfile = true
    try {
      await this.guard(async () => {
        const parsed = this.parseProgram()
        if (!parsed.ok) {
          this.validateResult = { ok: false, errors: [parsed.error] }
          throw new Error('程序解析失败,已阻止保存')
        }
        const validation = await request('POST', '/profiles/validate', { program: parsed.program })
        this.validateResult = validation
        if (!validation || validation.ok !== true) {
          throw new Error('方案未通过校验,已阻止保存')
        }
        const delayRaw = this.profileForm.firstDelayMs
        if (delayRaw !== '' && delayRaw != null) {
          const delay = Number(delayRaw)
          if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
            throw new Error('首字延迟覆盖必须是 0–60000 的数字，或留空继承全局')
          }
        }
        const speedRaw = this.profileForm.charsPerSecond
        if (speedRaw !== '' && speedRaw != null) {
          const speed = Number(speedRaw)
          if (!Number.isFinite(speed) || speed < 0.5 || speed > 1000) {
            throw new Error('输出速度覆盖必须是 0.5–1000 的数字，或留空继承全局')
          }
        }
        const body = {
          name: this.profileForm.name,
          model_id: this.profileForm.modelId,
          program: parsed.program,
          is_default: this.profileForm.isDefault,
          enabled: this.profileForm.enabled,
          first_delay_ms: delayRaw === '' || delayRaw == null ? null : Number(delayRaw),
          chars_per_second: speedRaw === '' || speedRaw == null ? null : Number(speedRaw)
        }
        try {
          if (this.profileForm.id) {
            await request('PUT', `/profiles/${encodeURIComponent(this.profileForm.id)}`, body)
          } else {
            await request('POST', '/profiles', body)
          }
        } catch (err) {
          const details = err && err.payload && Array.isArray(err.payload.details) ? err.payload.details : null
          if (details) {
            this.validateResult = { ok: false, errors: details, details }
            err.message = '后端校验未通过,详情见校验结果'
          }
          throw err
        }
      this.notify('方案已保存')
      this.profileSnapshot = null
      await this.loadProfiles()
      this.newProfile()
    })
    } finally {
      this.savingProfile = false
    }
  },

  async deleteProfile() {
    if (!this.profileForm.id) return
    if (!confirm('确认删除该方案?')) return
    await this.guard(async () => {
      await request('DELETE', `/profiles/${encodeURIComponent(this.profileForm.id)}`)
      this.notify('方案已删除')
      this.profileSnapshot = null
      await this.loadProfiles()
      this.newProfile()
    })
  },
  async reloadLimits() {
    await Promise.all([this.loadRules(), this.loadOverrides(), this.loadIpGroups()])
  },

  humanRule(rule) {
    return humanRuleText(rule)
  },

  humanWindowText(seconds) {
    return humanWindowText(seconds)
  },

  humanizeDetail(text) {
    return humanizeDetail(text)
  },

  rulePreview(draft) {
    return humanRuleText(ruleToApi(draft, false))
  },

  rulesSummary(rules) {
    if (!Array.isArray(rules) || !rules.length) return '继承全局规则'
    return rules.map((r) => humanRuleText(r)).filter(Boolean).join(';')
  },

  async loadRules() {
    await this.guard(async () => {
      const data = await request('GET', '/rules')
      this.rules = Array.isArray(data) ? data : []
    })
  },

  openGlobalRulesEditor() {
    this.ruleEditor = {
      open: true,
      kind: 'global-all',
      title: '编辑全局规则',
      targetId: null,
      rules: this.rules.map((r) => ruleDraft(r))
    }
    this.ruleEditorError = ''
    this._ruleEditorSnapshot = JSON.stringify(this.ruleEditor.rules)
  },

  openGlobalRuleEditor(rule) {
    this.ruleEditor = {
      open: true,
      kind: 'global-one',
      title: '编辑规则',
      targetId: rule.id,
      rules: [ruleDraft(rule)]
    }
    this.ruleEditorError = ''
    this._ruleEditorSnapshot = JSON.stringify(this.ruleEditor.rules)
  },

  openRuleEditorFor(kind) {
    const sources = {
      group: { title: '编辑 IP 组规则', rules: this.groupForm.rules },
      override: { title: '编辑单 IP 专属规则', rules: this.overrideForm.rules },
      key: { title: '编辑 Key 配额规则', rules: this.keyForm.quotaRules }
    }
    const source = sources[kind]
    if (!source) return
    this.ruleEditor = {
      open: true,
      kind,
      title: source.title,
      targetId: null,
      rules: (Array.isArray(source.rules) ? source.rules : []).map((r) => ruleDraft(r))
    }
    this.ruleEditorError = ''
    this._ruleEditorSnapshot = JSON.stringify(this.ruleEditor.rules)
  },

  addRuleRow() {
    this.ruleEditor.rules.push(ruleDraft(null))
  },

  removeRuleRow(index) {
    this.ruleEditor.rules.splice(index, 1)
  },

  applyRulePreset(row, secondsStr) {
    const preset = RULE_PRESETS.find((p) => String(p.seconds) === String(secondsStr))
    if (!preset) return
    row.value = preset.value
    row.unit = preset.unit
    if (preset.limitChars != null) row.limitChars = preset.limitChars
  },

  validateRuleRows(rows) {
    for (let i = 0; i < rows.length; i++) {
      const rawValue = rows[i].value
      const rawLimit = rows[i].limitChars
      const value = Number(rawValue)
      const limit = Number(rawLimit)
      if (rawValue === '' || rawValue == null || !Number.isFinite(value) || value <= 0) {
        return `第 ${i + 1} 条规则：窗口数值必须大于 0`
      }
      if (rawLimit === '' || rawLimit == null || !Number.isFinite(limit) || limit < 0) {
        return `第 ${i + 1} 条规则：限额必须是大于等于 0 的数字`
      }
    }
    return ''
  },

  requestCloseRuleEditor() {
    if (this.savingRules) return
    if (this.ruleEditorIsDirty() && !confirm('规则有未保存的修改，确定放弃吗？')) return
    this.closeRuleEditor()
  },

  ruleEditorIsDirty() {
    if (!this.ruleEditor.open) return false
    return JSON.stringify(this.ruleEditor.rules) !== this._ruleEditorSnapshot
  },

  closeRuleEditor() {
    this.ruleEditor = { open: false, kind: '', title: '', targetId: null, rules: [] }
    this.ruleEditorError = ''
    this._ruleEditorSnapshot = null
  },

  confirmRuleEditor() {
    const rows = this.ruleEditor.rules
    const problem = this.validateRuleRows(rows)
    if (problem) {
      this.ruleEditorError = problem
      return
    }
    const kind = this.ruleEditor.kind
    if (kind === 'global-one' || kind === 'global-all') {
      this.saveGlobalRuleRows(rows, kind === 'global-one' ? this.ruleEditor.targetId : null)
      return
    }
    const payload = rows.map((r) => stripRuleId(ruleToApi(r, false)))
    if (kind === 'group') {
      this.groupForm.rules = payload
      this.notify('规则已写入表单,保存 IP 组后生效')
      this.closeRuleEditor()
      return
    }
    if (kind === 'override') {
      this.overrideForm.rules = payload
      this.notify('规则已写入表单,保存后生效')
      this.closeRuleEditor()
      return
    }
    if (kind === 'key') {
      this.keyForm.quotaRules = payload
      this.notify('规则已写入表单,保存 Key 后生效')
      this.closeRuleEditor()
      return
    }
    this.closeRuleEditor()
  },

  ruleBody(draft) {
    const api = ruleToApi(draft, false)
    return { window_seconds: api.windowSeconds, limit_chars: api.limitChars, enabled: api.enabled, note: api.note }
  },

  async saveGlobalRuleRows(rows, singleId) {
    if (this.savingRules) return
    this.savingRules = true
    try {
      if (singleId != null) {
        await request('PUT', `/rules/${encodeURIComponent(singleId)}`, this.ruleBody(rows[0]))
      } else {
        const rules = rows.map((row) => {
          const api = ruleToApi(row, true)
          return {
            id: api.id == null ? null : api.id,
            window_seconds: api.windowSeconds,
            limit_chars: api.limitChars,
            enabled: api.enabled,
            note: api.note
          }
        })
        await request('PUT', '/rules', { rules })
      }
      this.notify('规则已保存')
      await this.loadRules()
      this.closeRuleEditor()
    } catch (err) {
      this.ruleEditorError = humanizeError(err && err.message ? err.message : String(err))
    } finally {
      this.savingRules = false
    }
  },

  async deleteRule(rule) {
    if (!confirm('确认删除该全局规则?')) return
    await this.guard(async () => {
      await request('DELETE', `/rules/${encodeURIComponent(rule.id)}`)
      this.notify('规则已删除')
      await this.loadRules()
    })
  },
  async loadIpGroups() {
    await this.guard(async () => {
      const data = await request('GET', '/ip-groups')
      this.ipGroups = Array.isArray(data) ? data : []
    })
  },

  groupMemberCount(group) {
    if (!group) return 0
    if (group.memberCount != null) return group.memberCount
    if (Array.isArray(group.members)) return group.members.length
    return 0
  },

  newGroup() {
    this.groupForm = emptyGroup()
    this.groupForm.open = true
  },

  editGroup(group) {
    this.groupForm = {
      id: group.id,
      name: group.name,
      priority: group.priority == null ? 100 : group.priority,
      concurrency: group.concurrency == null ? '' : group.concurrency,
      enabled: group.enabled !== false,
      note: group.note || '',
      rules: (Array.isArray(group.rules) ? group.rules : []).map(normalizeRule),
      open: true
    }
  },

  resetGroupForm() {
    this.groupForm = emptyGroup()
  },

  async saveGroup() {
    if (this.savingGroup) return
    this.savingGroup = true
    try {
      await this.guard(async () => {
        const name = (this.groupForm.name || '').trim()
        if (!name) throw new Error('请填写组名称')
        const rawPriority = this.groupForm.priority
        const priority = rawPriority === '' || rawPriority == null ? 100 : Number(rawPriority)
        const body = {
          name,
          priority: Number.isFinite(priority) ? priority : 100,
          concurrency: this.groupForm.concurrency === '' || this.groupForm.concurrency == null
            ? null
            : Number(this.groupForm.concurrency),
          rules: (this.groupForm.rules || []).map((r) => stripRuleId(normalizeRule(r))),
          enabled: this.groupForm.enabled !== false,
          note: this.groupForm.note || ''
        }
        if (this.groupForm.id) {
          await request('PUT', `/ip-groups/${encodeURIComponent(this.groupForm.id)}`, body)
          this.notify('IP 组已保存')
        } else {
          await request('POST', '/ip-groups', body)
          this.notify('IP 组已创建')
        }
        await this.loadIpGroups()
        this.resetGroupForm()
      })
    } finally {
      this.savingGroup = false
    }
  },

  async deleteGroup(group) {
    if (!confirm(`确认删除 IP 组「${group.name}」?组内成员关系将一并删除。`)) return
    await this.guard(async () => {
      await request('DELETE', `/ip-groups/${encodeURIComponent(group.id)}`)
      this.notify('IP 组已删除')
      if (this.membersPanel.groupId === group.id) this.closeMembers()
      await this.loadIpGroups()
    })
  },

  closeMembers() {
    this.membersPanel.open = false
    this.membersPanel.invalid = []
    this.membersPanel.addedCount = 0
  },

  async openMembers(group) {
    this.membersPanel = {
      open: true,
      groupId: group.id,
      groupName: group.name,
      list: [],
      text: '',
      invalid: [],
      addedCount: 0,
      loading: true
    }
    await this.guard(async () => {
      const rows = await request('GET', `/ip-groups/${encodeURIComponent(group.id)}/members`)
      if (this.membersPanel.groupId !== group.id) return
      this.membersPanel.list = Array.isArray(rows) ? rows : []
    })
    if (this.membersPanel.groupId === group.id) this.membersPanel.loading = false
  },

  async submitMembers() {
    if (!this.membersPanel.groupId) return
    if (this.membersPanel.saving) return
    const values = String(this.membersPanel.text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (!values.length) {
      this.showError(new Error('请输入至少一个 IP 或 CIDR(每行一个)'))
      return
    }
    this.membersPanel.saving = true
    try {
      await this.guard(async () => {
        const result = await request('POST', `/ip-groups/${encodeURIComponent(this.membersPanel.groupId)}/members`, { values })
        const added = result && Array.isArray(result.added) ? result.added : []
        const invalid = result && Array.isArray(result.invalid) ? result.invalid : []
        this.membersPanel.addedCount = added.length
        this.membersPanel.invalid = invalid.map((item) => {
          if (item == null) return ''
          if (typeof item === 'string') return item
          return item.value || item.input || item.line || JSON.stringify(item)
        }).filter(Boolean)
        if (invalid.length) this.showError(new Error(`有 ${invalid.length} 行无效,已跳过`))
        this.membersPanel.text = ''
        const rows = await request('GET', `/ip-groups/${encodeURIComponent(this.membersPanel.groupId)}/members`)
        this.membersPanel.list = Array.isArray(rows) ? rows : []
        await this.loadIpGroups()
      })
    } finally {
      this.membersPanel.saving = false
    }
  },

  async deleteMember(member) {
    if (!this.membersPanel.groupId) return
    if (!confirm(`确认从该组删除成员 ${member.value}?`)) return
    await this.guard(async () => {
      await request(
        'DELETE',
        `/ip-groups/${encodeURIComponent(this.membersPanel.groupId)}/members/${encodeURIComponent(member.value)}`
      )
      this.notify('成员已删除')
      const rows = await request('GET', `/ip-groups/${encodeURIComponent(this.membersPanel.groupId)}/members`)
      this.membersPanel.list = Array.isArray(rows) ? rows : []
      await this.loadIpGroups()
    })
  },

  async loadOverrides() {
    await this.guard(async () => {
      const data = await request('GET', '/ip-overrides')
      this.overrides = Array.isArray(data) ? data : []
    })
  },

  resetOverrideForm() {
    this.overrideForm = emptyOverride()
  },

  editOverride(override) {
    this.overrideForm = {
      ip: override.ip,
      concurrency: override.concurrency == null ? '' : override.concurrency,
      rules: (Array.isArray(override.rules) ? override.rules : []).map(normalizeRule),
      expires_at: this.toLocalInput(override.expiresAt),
      note: override.note || '',
      editing: true
    }
  },

  async saveOverride() {
    if (this.savingOverride) return
    this.savingOverride = true
    try {
      await this.guard(async () => {
        const ip = (this.overrideForm.ip || '').trim()
        if (!ip) throw new Error('请填写 IP 地址')
        const body = {
          concurrency: this.overrideForm.concurrency === '' || this.overrideForm.concurrency == null
            ? null
            : Number(this.overrideForm.concurrency),
          rules: this.overrideForm.rules && this.overrideForm.rules.length
            ? this.overrideForm.rules.map((r) => stripRuleId(normalizeRule(r)))
            : null,
          expires_at: this.fromLocalInput(this.overrideForm.expires_at),
          note: this.overrideForm.note || ''
        }
        await request('PUT', `/ip-overrides/${encodeURIComponent(ip)}`, body)
        this.notify('单 IP 专属规则已保存')
        await this.loadOverrides()
        this.resetOverrideForm()
      })
    } finally {
      this.savingOverride = false
    }
  },

  async deleteOverride(override) {
    if (!confirm(`确认删除 IP ${override.ip} 的专属规则?`)) return
    await this.guard(async () => {
      await request('DELETE', `/ip-overrides/${encodeURIComponent(override.ip)}`)
      this.notify('单 IP 专属规则已删除')
      await this.loadOverrides()
    })
  },

  resolveRules() {
    const resolve = this.ipResolve
    return resolve && Array.isArray(resolve.rules) ? resolve.rules : []
  },

  resolveWindows() {
    const resolve = this.ipResolve
    const status = resolve && resolve.status
    return status && Array.isArray(status.windows) ? status.windows : []
  },

  ipInflight() {
    const resolve = this.ipResolve
    if (resolve && resolve.status && resolve.status.inflight != null) return resolve.status.inflight
    return 0
  },

  ipRetryText() {
    const resolve = this.ipResolve
    const ms = resolve && resolve.status ? resolve.status.retryAfterMs : null
    if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return ''
    return `预计 ${Math.ceil(Number(ms) / 1000)} 秒后可重试`
  },

  resolveSourceText(resolve) {
    if (!resolve) return ''
    const source = String(resolve.source || resolve.layer || '').toLowerCase()
    const allowed = resolve.allowed !== false
    if (/override|special|exact|whitelist/.test(source)) return '命中单 IP 专属规则'
    if (/group/.test(source)) return resolve.groupName ? `命中 IP 组：${resolve.groupName}` : '命中 IP 组'
    if (/unlisted|unknown|none|default|unregistered/.test(source)) {
      return allowed ? '未登记，按全局规则' : '未登记，已禁止'
    }
    if (/global/.test(source)) return '未登记，按全局规则'
    return allowed ? '允许(按匹配规则)' : '禁止(未命中允许策略)'
  },

  scopeLabel(scope) {
    const text = String(scope == null ? '' : scope)
    if (text.startsWith('key:')) return 'Key 配额'
    if (text.startsWith('ip:')) return 'IP 限流'
    return text
  },

  statusWindowRows(status) {
    const scopes = status && Array.isArray(status.scopes) ? status.scopes : []
    const rows = []
    for (const item of scopes) {
      const windows = item && Array.isArray(item.windows) ? item.windows : []
      for (const window of windows) {
        rows.push({ scope: this.scopeLabel(item.scope), windowSeconds: window.windowSeconds, used: window.used })
      }
    }
    return rows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  },

  statusInflightRows(status) {
    const map = status && status.inflight && typeof status.inflight === 'object' ? status.inflight : {}
    return Object.entries(map).map(([scope, count]) => ({ scope: this.scopeLabel(scope), count }))
  },

  statusRotationRows(status) {
    const map = status && status.rotations && typeof status.rotations === 'object' ? status.rotations : {}
    return Object.entries(map).map(([key, count]) => ({ key, count }))
  },

  windowText(window) {
    if (!window || typeof window !== 'object') return String(window == null ? '' : window)
    const windowSeconds = window.windowSeconds != null ? window.windowSeconds : window.window_seconds
    let limitChars = window.limitChars != null ? window.limitChars : window.limit_chars != null ? window.limit_chars : window.limit
    if (limitChars == null && windowSeconds != null) {
      const match = this.resolveRules().find((r) => Number(r.windowSeconds != null ? r.windowSeconds : r.window_seconds) === Number(windowSeconds))
      if (match) limitChars = match.limitChars != null ? match.limitChars : match.limit_chars
    }
    const used = window.used != null ? window.used : window.usedChars != null ? window.usedChars : window.used_chars
    let remaining = window.remaining != null ? window.remaining : window.remainingChars != null ? window.remainingChars : window.remaining_chars
    if (remaining == null && limitChars != null && used != null) remaining = Number(limitChars) - Number(used)
    const parts = []
    if (windowSeconds != null) parts.push(`每 ${humanWindowText(windowSeconds)}`)
    if (limitChars != null) parts.push(`最多 ${formatNum(limitChars)} 字符`)
    if (used != null) parts.push(`已用 ${formatNum(used)}`)
    if (remaining != null) parts.push(`剩余 ${formatNum(remaining)}`)
    return parts.length ? parts.join(' · ') : JSON.stringify(window)
  },

  async resolveIpPolicy() {
    const ip = (this.ipQuery.ip || '').trim()
    if (!ip) {
      this.showError(new Error('请输入 IP 地址'))
      return
    }
    await this.guard(async () => {
      this.ipResolve = await request('GET', `/ip-policy/resolve?ip=${encodeURIComponent(ip)}`)
    })
  },
  quotaModeText(key) {
    const mode = key && key.quotaMode != null ? key.quotaMode : key && key.quota_mode
    return QUOTA_MODE_LABELS[mode] || mode || ''
  },

  async loadKeys() {
    await this.guard(async () => {
      const data = await request('GET', '/api-keys')
      this.keys = Array.isArray(data) ? data : []
    })
  },

  resetKeyForm() {
    this.keyForm = emptyKey()
  },

  editKey(key) {
    const rules = Array.isArray(key.quotaRules) ? key.quotaRules : Array.isArray(key.quota_rules) ? key.quota_rules : []
    this.keyForm = {
      id: key.id,
      name: key.name,
      quota_mode: key.quotaMode != null ? key.quotaMode : key.quota_mode,
      quotaRules: rules.map(normalizeRule),
      expires_at: this.toLocalInput(key.expiresAt),
      note: key.note || ''
    }
  },

  keyRulesPayload() {
    if (this.keyForm.quota_mode === 'unlimited') return null
    return this.keyForm.quotaRules.map((r) => {
      const api = ruleToApi(ruleDraft(r), false)
      return { window_seconds: api.windowSeconds, limit_chars: api.limitChars, enabled: api.enabled, note: api.note }
    })
  },

  async saveKey() {
    if (this.savingKey) return
    this.savingKey = true
    try {
      await this.guard(async () => {
        if (!(this.keyForm.name || '').trim()) throw new Error('请填写 Key 名称')
        if (this.keyForm.quota_mode !== 'unlimited') {
          const problem = this.validateRuleRows((this.keyForm.quotaRules || []).map((r) => ruleDraft(r)))
          if (problem) throw new Error(problem)
        }
        const quotaRules = this.keyRulesPayload()
        if (this.keyForm.quota_mode !== 'unlimited' && (!quotaRules || !quotaRules.length)) {
          throw new Error('该配额模式至少需要一条规则')
        }
        const body = {
          name: this.keyForm.name,
          quota_mode: this.keyForm.quota_mode,
          quota_rules: quotaRules,
          expires_at: this.fromLocalInput(this.keyForm.expires_at),
          note: this.keyForm.note || ''
        }
        if (this.keyForm.id) {
          await request('PUT', `/api-keys/${encodeURIComponent(this.keyForm.id)}`, body)
          this.notify('Key 已更新')
          await this.loadKeys()
          this.resetKeyForm()
        } else {
          const created = await request('POST', '/api-keys', body)
          this.createdKey = created
          await this.loadKeys()
          this.resetKeyForm()
        }
      })
    } finally {
      this.savingKey = false
    }
  },

  async toggleKey(key) {
    if (key.enabled && !confirm(`确认停用 Key「${key.name}」?停用后使用该 Key 的请求会被拒绝。`)) return
    await this.guard(async () => {
      await request('PUT', `/api-keys/${encodeURIComponent(key.id)}`, { enabled: !key.enabled })
      this.notify(key.enabled ? 'Key 已停用' : 'Key 已启用')
      await this.loadKeys()
    })
  },

  async deleteKey(key) {
    if (!confirm(`确认删除 Key ${key.name}?此操作不可撤销。`)) return
    await this.guard(async () => {
      await request('DELETE', `/api-keys/${encodeURIComponent(key.id)}`)
      this.notify('Key 已删除')
      if (this.keyDetail.keyId === key.id) this.closeKeyDetail()
      await this.loadKeys()
    })
  },

  openKeyDetail(key, tab) {
    this.openKeyMenu = null
    if (this.keyDetail.keyId !== key.id) {
      this.keyUsage = null
      this.keyIps = []
      this.keyIpsOpen = false
      this.keyStatus = null
      this.logPanel = { open: false, mode: 'key', keyId: null, keyName: '', ip: '', items: [], nextBefore: null, loading: false, seq: 0 }
    }
    this.detailSeq = (this.detailSeq || 0) + 1
    this.keyDetail = { open: true, tab, keyId: key.id, keyName: key.name }
    return this.detailSeq
  },

  switchKeyDetail(tab) {
    if (!this.keyDetail.open) return
    if (this.keyDetail.tab === tab) {
      const loaded =
        (tab === 'usage' && this.keyUsage) ||
        (tab === 'ips' && this.keyIpsOpen) ||
        (tab === 'status' && this.keyStatus) ||
        (tab === 'logs' && this.logPanel.open)
      if (loaded) return
    }
    this.keyDetail.tab = tab
    const key = { id: this.keyDetail.keyId, name: this.keyDetail.keyName }
    if (tab === 'usage' && !this.keyUsage) this.loadKeyUsage(key)
    else if (tab === 'ips' && !this.keyIpsOpen) this.loadKeyIps(key)
    else if (tab === 'status' && !this.keyStatus) this.loadKeyStatus(key)
    else if (tab === 'logs' && !this.logPanel.open) this.openKeyLogs(key)
  },

  closeKeyDetail() {
    this.detailSeq = (this.detailSeq || 0) + 1
    this.keyDetail = { open: false, tab: 'usage', keyId: null, keyName: '' }
    this.keyUsage = null
    this.keyIps = []
    this.keyIpsOpen = false
    this.keyStatus = null
    this.logPanel = { open: false, mode: 'key', keyId: null, keyName: '', ip: '', items: [], nextBefore: null, loading: false, seq: 0 }
  },

  async loadKeyUsage(key) {
    const seq = this.openKeyDetail(key, 'usage')
    await this.guard(async () => {
      this.keyIps = []
      this.keyIpsOpen = false
      this.keyStatus = null
      this.keyUsage = null
      const data = await request('GET', `/api-keys/${encodeURIComponent(key.id)}/usage?days=7`)
      if (seq !== this.detailSeq) return
      this.keyUsage = data
    })
  },

  async loadKeyIps(key) {
    const seq = this.openKeyDetail(key, 'ips')
    await this.guard(async () => {
      this.keyUsage = null
      this.keyStatus = null
      this.keyIps = []
      this.keyIpsOpen = false
      const rows = await request('GET', `/api-keys/${encodeURIComponent(key.id)}/ips`)
      if (seq !== this.detailSeq) return
      this.keyIps = Array.isArray(rows) ? rows : []
      this.keyIpsOpen = true
    })
  },

  keyIpLastSeen(row) {
    if (!row) return ''
    if (row.lastSeen) return this.fmtTimeAny(row.lastSeen)
    if (row.recentSeen) return this.fmtTimeAny(row.recentSeen)
    return ''
  },

  async loadKeyStatus(key) {
    const seq = this.openKeyDetail(key, 'status')
    await this.guard(async () => {
      this.keyUsage = null
      this.keyIps = []
      this.keyIpsOpen = false
      this.keyStatus = null
      const data = await request('GET', `/api-keys/${encodeURIComponent(key.id)}/status`)
      if (seq !== this.detailSeq) return
      this.keyStatus = data
    })
  },

  async openKeyLogs(key) {
    const seq = this.openKeyDetail(key, 'logs')
    this.logPanel = { open: true, mode: 'key', keyId: key.id, keyName: key.name, ip: '', items: [], nextBefore: null, loading: true, seq }
    await this.guard(async () => {
      await this.loadLogs(true)
    })
  },

  async openIpLogs(ip) {
    if (this.keyDetail.open) this.keyDetail.tab = 'logs'
    this.detailSeq = (this.detailSeq || 0) + 1
    this.logPanel = { open: true, mode: 'ip', keyId: this.logPanel.keyId, keyName: this.logPanel.keyName, ip, items: [], nextBefore: null, loading: true, seq: this.detailSeq }
    await this.guard(async () => {
      await this.loadLogs(true)
    })
  },

  async loadLogs(reset) {
    const panel = this.logPanel
    if (panel.loading && !reset) return
    const params = new URLSearchParams()
    if (panel.mode === 'key' && panel.keyId) params.set('key_id', panel.keyId)
    if (panel.mode === 'ip' && panel.ip) params.set('ip', panel.ip)
    params.set('limit', '50')
    if (!reset && panel.nextBefore) params.set('before', String(panel.nextBefore))
    panel.loading = true
    try {
      const data = await request('GET', '/logs?' + params.toString())
      if (panel.seq !== this.detailSeq) return
      const items = data && Array.isArray(data.items) ? data.items : []
      panel.items = reset ? items : panel.items.concat(items)
      panel.nextBefore = data && data.nextBefore ? data.nextBefore : null
    } finally {
      panel.loading = false
    }
  },

  backToKeyLogs() {
    this.openKeyLogs({ id: this.logPanel.keyId, name: this.logPanel.keyName })
  },

  logTokenText(item) {
    if (!item) return ''
    return `${item.inputTokens == null ? 0 : item.inputTokens} / ${item.outputTokens == null ? 0 : item.outputTokens}`
  },

  async resetKey(key) {
    const mode = key.quotaMode != null ? key.quotaMode : key.quota_mode
    if (mode === 'unlimited') {
      this.showError(new Error('该 Key 为不限模式，没有可重置的配额窗口'))
      return
    }
    if (!confirm(`确认重置 Key ${key.name} 的所有窗口?`)) return
    await this.guard(async () => {
      await request('POST', `/api-keys/${encodeURIComponent(key.id)}/reset`)
      this.notify('Key 窗口已重置')
    })
  },

  copyKey(value) {
    if (!value) return
    if (navigator.clipboard) {
      navigator.clipboard.writeText(value).then(
        () => this.notify('已复制到剪贴板'),
        () => this.showError(new Error('复制失败,请手动选择复制'))
      )
    } else {
      this.showError(new Error('当前环境不支持自动复制'))
    }
  },

  async loadIpStatus() {
    const ip = (this.ipQuery.ip || '').trim()
    if (!ip) {
      this.showError(new Error('请输入 IP 地址'))
      return
    }
    await this.guard(async () => {
      this.ipStatus = await request('GET', `/ip/${encodeURIComponent(ip)}/status`)
    })
  },

  async reloadIpTab() {
    await this.loadIpStatus()
    await this.resolveIpPolicy()
  },

  async resetIp() {
    const ip = (this.ipQuery.ip || '').trim()
    if (!ip) {
      this.showError(new Error('请输入 IP 地址'))
      return
    }
    if (!confirm(`确认重置 IP ${ip} 的窗口与并发?`)) return
    await this.guard(async () => {
      await request('POST', `/ip/${encodeURIComponent(ip)}/reset`)
      this.notify('该 IP 已重置')
      await this.loadIpStatus()
    })
  }
}

window.__loremiumAdmin = admin
