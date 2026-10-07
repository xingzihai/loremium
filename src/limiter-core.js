export function sumWindow(entries, now, windowMs) {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  const cutoff = now - windowMs
  let total = 0
  for (const entry of entries) {
    if (!entry || !Number.isFinite(entry.ts)) continue
    if (entry.ts > cutoff) total += Number.isFinite(entry.chars) ? entry.chars : 0
  }
  return total
}

export function remainingForRules(windows, rules, now) {
  if (!Array.isArray(rules) || rules.length === 0) return Infinity
  let remaining = Infinity
  for (const rule of rules) {
    if (!rule || !Number.isFinite(rule.windowSeconds) || rule.windowSeconds <= 0) continue
    const windowSeconds = rule.windowSeconds
    const entries = windows && typeof windows === 'object' ? windows[String(windowSeconds)] : undefined
    const used = sumWindow(entries, now, windowSeconds * 1000)
    const limit = Number.isFinite(rule.limitChars) ? rule.limitChars : Infinity
    remaining = Math.min(remaining, limit - used)
  }
  return remaining
}

export function retryAfterForRules(windows, rules, now) {
  if (!Array.isArray(rules) || rules.length === 0) return 0
  let waitMs = 0
  for (const rule of rules) {
    if (!rule || !Number.isFinite(rule.windowSeconds) || rule.windowSeconds <= 0) continue
    const windowMs = rule.windowSeconds * 1000
    const entries = windows && typeof windows === 'object' ? windows[String(rule.windowSeconds)] : undefined
    if (!Array.isArray(entries) || entries.length === 0) continue
    const limit = Number.isFinite(rule.limitChars) ? rule.limitChars : Infinity
    if (limit === Infinity) continue
    const live = entries
      .filter((entry) => entry && Number.isFinite(entry.ts) && entry.ts > now - windowMs)
      .sort((a, b) => a.ts - b.ts)
    if (live.length === 0) continue
    let used = 0
    for (const entry of live) used += Number.isFinite(entry.chars) ? entry.chars : 0
    if (used < limit) continue
    let released = 0
    let ruleWait = 0
    for (const entry of live) {
      released += Number.isFinite(entry.chars) ? entry.chars : 0
      ruleWait = Math.max(0, entry.ts + windowMs - now)
      if (limit > 0 && used - released < limit) break
    }
    waitMs = Math.max(waitMs, ruleWait)
  }
  return waitMs
}

export function truncateUtf16(text, maxChars) {
  if (typeof text !== 'string') return ''
  const limit = Math.floor(Number(maxChars))
  if (!Number.isFinite(limit) || limit <= 0) return ''
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

export function pickRotation(mode, count, options, counter) {
  if (!Array.isArray(options) || options.length === 0) return undefined
  if (mode === 'random') {
    const buffer = new Uint32Array(1)
    globalThis.crypto.getRandomValues(buffer)
    return options[buffer[0] % options.length]
  }
  const index = Number.isFinite(counter) ? Math.floor(counter) : 0
  return options[((index % options.length) + options.length) % options.length]
}
