const JWKS_TTL_MS = 3600_000
const JWKS_MIN_REFRESH_MS = 60_000
const JWKS_TIMEOUT_MS = 5000
let jwksCache = { teamDomain: null, at: 0, keys: null }

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function b64urlToJson(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)))
}

async function fetchKeys(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(JWKS_TIMEOUT_MS) : undefined
  })
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
  const body = await res.json()
  jwksCache = { teamDomain, at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] }
  return jwksCache.keys
}

async function getKeys(teamDomain, force = false) {
  const now = Date.now()
  const cached = jwksCache.teamDomain === teamDomain && Array.isArray(jwksCache.keys)
  if (cached && now - jwksCache.at < JWKS_TTL_MS) {
    if (!force || now - jwksCache.at < JWKS_MIN_REFRESH_MS) return jwksCache.keys
  }
  return fetchKeys(teamDomain)
}

export async function verifyAccessJwt(token, env) {
  try {
    if (!token || !env || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = b64urlToJson(parts[0])
    const payload = b64urlToJson(parts[1])
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null
    if (!payload || typeof payload !== 'object') return null
    const aud = payload.aud
    const audiences = Array.isArray(aud) ? aud : [aud]
    if (!audiences.includes(env.ACCESS_AUD)) return null
    const nowSec = Math.floor(Date.now() / 1000)
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) return null
    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null
    let jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN)).find((key) => key.kid === header.kid)
    if (!jwk) {
      jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN, true)).find((key) => key.kid === header.kid)
    }
    if (!jwk || jwk.kty !== 'RSA') return null
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    )
    return valid ? payload : null
  } catch {
    return null
  }
}
