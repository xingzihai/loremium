import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle
const encoder = new TextEncoder()
const TEAM_DOMAIN = 'team.cloudflareaccess.com'
const AUD = 'loremium-test-aud'
const KID = 'loremium-test-kid'

const generateRsaKeyPair = () =>
  subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )

const keyPair = await generateRsaKeyPair()
const otherKeyPair = await generateRsaKeyPair()
const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey)
const jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }

const originalFetch = globalThis.fetch

globalThis.fetch = async (url) => {
  if (String(url) === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const { verifyAccessJwt } = await import('../src/access.js')

const env = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }

function b64url(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function basePayload(overrides = {}) {
  return {
    aud: AUD,
    iss: `https://${TEAM_DOMAIN}`,
    exp: nowSec() + 3600,
    ...overrides
  }
}

async function signToken(payload, { header = {}, privateKey = keyPair.privateKey } = {}) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header }))
  const body = b64url(JSON.stringify(payload))
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(signature)}`
}

test('JWKS fetch failure returns null', async () => {
  const team = 'unreachable.cloudflareaccess.com'
  const token = await signToken(basePayload({ iss: `https://${team}` }))
  assert.equal(await verifyAccessJwt(token, { ...env, ACCESS_TEAM_DOMAIN: team }), null)
})

test('valid token returns payload', async () => {
  const payload = basePayload()
  const token = await signToken(payload)
  assert.deepEqual(await verifyAccessJwt(token, env), payload)
})

test('expired token returns null', async () => {
  const token = await signToken(basePayload({ exp: nowSec() - 10 }))
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('token missing exp returns null', async () => {
  const payload = basePayload()
  delete payload.exp
  const token = await signToken(payload)
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('aud mismatch returns null', async () => {
  const token = await signToken(basePayload({ aud: 'other-aud' }))
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('iss mismatch returns null', async () => {
  const token = await signToken(basePayload({ iss: 'https://evil.example' }))
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('nbf in the future returns null', async () => {
  const token = await signToken(basePayload({ nbf: nowSec() + 120 }))
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('unknown kid returns null', async () => {
  const token = await signToken(basePayload(), { header: { kid: 'unknown-kid' } })
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('token forged with a different private key returns null', async () => {
  const token = await signToken(basePayload(), { privateKey: otherKeyPair.privateKey })
  assert.equal(await verifyAccessJwt(token, env), null)
})

test('alg=none with empty signature returns null', async () => {
  const head = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }))
  const body = b64url(JSON.stringify(basePayload()))
  assert.equal(await verifyAccessJwt(`${head}.${body}.`, env), null)
})

test('HS256 confusion using the public key as HMAC secret returns null', async () => {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }))
  const body = b64url(JSON.stringify(basePayload()))
  const spki = await subtle.exportKey('spki', keyPair.publicKey)
  const hmacKey = await subtle.importKey('raw', spki, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await subtle.sign('HMAC', hmacKey, encoder.encode(`${head}.${body}`))
  assert.equal(await verifyAccessJwt(`${head}.${body}.${b64url(signature)}`, env), null)
})

test('malformed three-part token returns null', async () => {
  assert.equal(await verifyAccessJwt('aaa.bbb.ccc', env), null)
})

test('two-part token returns null', async () => {
  assert.equal(await verifyAccessJwt('aaa.bbb', env), null)
})

test('empty or missing token returns null', async () => {
  assert.equal(await verifyAccessJwt('', env), null)
  assert.equal(await verifyAccessJwt(null, env), null)
  assert.equal(await verifyAccessJwt(undefined, env), null)
})

test('missing env config returns null', async () => {
  const token = await signToken(basePayload())
  assert.equal(await verifyAccessJwt(token, {}), null)
  assert.equal(await verifyAccessJwt(token, { ACCESS_AUD: AUD }), null)
  assert.equal(await verifyAccessJwt(token, { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }), null)
})

// Restore the process-wide fetch stub so this file cannot leak into other
// modules loaded in the same process.
after(() => {
  globalThis.fetch = originalFetch
})
