function parseIpv4(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i]
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.charCodeAt(0) === 48) return null
    const n = Number(part)
    if (n > 255) return null
    bytes[i] = n
  }
  return bytes
}

function parseIpv6(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('%')) return null
  let text = value
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':')
    if (colon < 0) return null
    const v4 = parseIpv4(text.slice(colon + 1))
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`
  }
  const doubleAt = text.indexOf('::')
  if (doubleAt !== -1 && text.indexOf('::', doubleAt + 1) !== -1) return null
  let groups
  if (doubleAt === -1) {
    groups = text.split(':')
    if (groups.length !== 8) return null
  } else {
    const left = text.slice(0, doubleAt)
    const right = text.slice(doubleAt + 2)
    const leftGroups = left === '' ? [] : left.split(':')
    const rightGroups = right === '' ? [] : right.split(':')
    const missing = 8 - leftGroups.length - rightGroups.length
    if (missing < 1) return null
    groups = leftGroups.concat(new Array(missing).fill('0'), rightGroups)
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const group = groups[i]
    if (typeof group !== 'string' || !/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const n = parseInt(group, 16)
    bytes[i * 2] = (n >> 8) & 0xff
    bytes[i * 2 + 1] = n & 0xff
  }
  return bytes
}

function formatIpv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`
}

function formatIpv6(bytes) {
  const groups = []
  for (let i = 0; i < 8; i++) groups.push(((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16))
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      if (runStart === -1) runStart = i
      runLen += 1
      if (runLen > bestLen) {
        bestLen = runLen
        bestStart = runStart
      }
    } else {
      runStart = -1
      runLen = 0
    }
  }
  if (bestLen < 2) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLen).join(':')
  return `${head}::${tail}`
}

function parseIp(value) {
  if (typeof value !== 'string') return null
  const v4 = parseIpv4(value)
  if (v4) return v4
  return parseIpv6(value)
}

function maskBytes(bytes, prefix) {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const remaining = prefix - i * 8
    if (remaining >= 8) out[i] = bytes[i]
    else if (remaining <= 0) out[i] = 0
    else out[i] = bytes[i] & ((0xff << (8 - remaining)) & 0xff)
  }
  return out
}

function parseCidr(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash !== value.lastIndexOf('/')) return null
  const prefixText = value.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixText)) return null
  if (prefixText.length > 1 && prefixText.charCodeAt(0) === 48) return null
  const baseText = value.slice(0, slash)
  const v4 = parseIpv4(baseText)
  const v6 = v4 ? null : parseIpv6(baseText)
  const bytes = v4 || v6
  if (!bytes) return null
  const bits = bytes.length * 8
  const prefix = Number(prefixText)
  if (prefix > bits) return null
  const masked = maskBytes(bytes, prefix)
  const canonical = bytes.length === 4 ? formatIpv4(masked) : formatIpv6(masked)
  return { kind: 'cidr', value: `${canonical}/${prefix}` }
}

export function isValidIp(str) {
  if (typeof str !== 'string') return false
  const value = str.trim()
  if (!value || /\s/.test(value)) return false
  return parseIpv4(value) !== null || parseIpv6(value) !== null
}

export function parseIpEntry(str) {
  if (typeof str !== 'string') return null
  const value = str.trim()
  if (!value || /\s/.test(value)) return null
  const cidr = parseCidr(value)
  if (cidr) return cidr
  const v4 = parseIpv4(value)
  if (v4) return { kind: 'ip', value: formatIpv4(v4) }
  const v6 = parseIpv6(value)
  if (v6) return { kind: 'ip', value: formatIpv6(v6) }
  return null
}

export function normalizeEntry(str) {
  const entry = parseIpEntry(str)
  return entry ? entry.value : null
}

export function ipScopeKey(value) {
  if (typeof value !== 'string') return '0.0.0.0'
  const raw = value.trim()
  if (!raw) return '0.0.0.0'
  const v4 = parseIpv4(raw)
  if (v4) return formatIpv4(v4)
  const v6 = parseIpv6(raw)
  if (!v6) return raw
  let mapped = true
  for (let i = 0; i < 10; i++) {
    if (v6[i] !== 0) {
      mapped = false
      break
    }
  }
  if (mapped && v6[10] === 0xff && v6[11] === 0xff) return formatIpv4(v6.slice(12))
  return `${formatIpv6(maskBytes(v6, 64))}/64`
}

export function ipMatchesEntry(ip, entry) {
  if (typeof ip !== 'string') return false
  const target = parseIp(ip.trim())
  if (!target) return false
  const parsed = typeof entry === 'string' ? parseIpEntry(entry) : entry
  if (!parsed || typeof parsed !== 'object') return false
  if (typeof parsed.value !== 'string') return false
  if (parsed.kind === 'ip') {
    const candidate = parseIp(parsed.value)
    if (!candidate || candidate.length !== target.length) return false
    for (let i = 0; i < target.length; i++) {
      if (target[i] !== candidate[i]) return false
    }
    return true
  }
  if (parsed.kind === 'cidr') {
    const cidr = parseCidr(parsed.value)
    if (!cidr) return false
    const slash = cidr.value.indexOf('/')
    const base = parseIp(cidr.value.slice(0, slash))
    const prefix = Number(cidr.value.slice(slash + 1))
    if (!base || base.length !== target.length) return false
    for (let i = 0; i < target.length; i++) {
      const diff = target[i] ^ base[i]
      if (diff === 0) continue
      const bitsLeft = prefix - i * 8
      if (bitsLeft >= 8) return false
      if (bitsLeft <= 0) return true
      if ((diff >> (8 - bitsLeft)) !== 0) return false
    }
    return true
  }
  return false
}
