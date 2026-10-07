import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8')

function loadAdmin() {
  const sandbox = { window: {}, location: { hash: '' }, setTimeout, clearTimeout, console }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'app.js' })
  return sandbox.window.__loremiumAdmin
}

const admin = loadAdmin()

test('humanizeError maps server error codes and network failures', () => {
  admin.error = ''
  admin.needsLogin = false
  admin.showError(new Error('key_not_found'))
  assert.equal(admin.error, '该 Key 不存在或已被删除，请刷新列表')
  assert.equal(admin.needsLogin, false)
  admin.showError(new Error('invalid_rule_window'))
  assert.match(admin.error, /规则窗口/)
  admin.showError(new Error('Failed to fetch'))
  assert.equal(admin.error, '网络连接失败，请检查网络后重试')
  assert.equal(admin.needsLogin, true)
  admin.showError(new Error('something else'))
  assert.equal(admin.error, 'something else')
})

test('humanizeDetail translates interpreter paths and messages', () => {
  assert.equal(admin.humanizeDetail('root.children[0].type: unknown block type "foo"'), '第 1 个顶层积木: 未知积木类型 "foo"')
  assert.equal(admin.humanizeDetail('root.children[1].children: must be an array of strings'), '第 2 个顶层积木.children: 必须是字符串数组')
})

test('validateRuleRows rejects blank and invalid values', () => {
  assert.match(admin.validateRuleRows([{ value: '', unit: 'minutes', limitChars: 5 }]), /窗口数值/)
  assert.match(admin.validateRuleRows([{ value: 5, unit: 'minutes', limitChars: '' }]), /限额/)
  assert.equal(admin.validateRuleRows([{ value: 5, unit: 'minutes', limitChars: 0 }]), '')
})

test('validateConfigFields flags every invalid numeric field', () => {
  admin.fieldErrors = {}
  admin.config = {
    first_delay_ms: 'abc',
    chars_per_second: '-1',
    chunk_size: '4',
    max_duration_s: '120',
    max_output_chars: '',
    concurrency_limit: '2',
    stats_tz_offset: '480',
    request_log_retention_days: '7'
  }
  const keys = admin.validateConfigFields()
  assert.deepEqual([...keys].sort(), ['chars_per_second', 'first_delay_ms', 'max_output_chars'].sort())
})

test('rulePreview renders human readable rule text', () => {
  assert.equal(admin.rulePreview({ value: 5, unit: 'minutes', limitChars: 1000 }), '每 5 分钟最多 1000 字符')
})

test('notify keeps a stack of toasts and expires them', async () => {
  admin.toasts = []
  admin.notify('first')
  admin.notify('second')
  assert.equal(admin.toasts.length, 2)
})
