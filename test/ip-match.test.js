import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidIp, parseIpEntry, ipMatchesEntry, normalizeEntry, ipScopeKey } from '../src/ip-match.js'

test('isValidIp accepts ipv4', () => {
  assert.equal(isValidIp('0.0.0.0'), true)
  assert.equal(isValidIp('1.2.3.4'), true)
  assert.equal(isValidIp('255.255.255.255'), true)
  assert.equal(isValidIp(' 1.2.3.4 '), true)
})

test('isValidIp rejects invalid ipv4', () => {
  assert.equal(isValidIp('1.2.3'), false)
  assert.equal(isValidIp('1.2.3.4.5'), false)
  assert.equal(isValidIp('1.2.3.256'), false)
  assert.equal(isValidIp('256.1.1.1'), false)
  assert.equal(isValidIp('01.2.3.4'), false)
  assert.equal(isValidIp('1.2.3.-1'), false)
  assert.equal(isValidIp('1.2.3.a'), false)
  assert.equal(isValidIp('1..3.4'), false)
  assert.equal(isValidIp(''), false)
  assert.equal(isValidIp('1.2.3.4/8'), false)
  assert.equal(isValidIp('1.2.3.4 5.6.7.8'), false)
  assert.equal(isValidIp(null), false)
  assert.equal(isValidIp(123), false)
})

test('isValidIp accepts ipv6', () => {
  assert.equal(isValidIp('::'), true)
  assert.equal(isValidIp('::1'), true)
  assert.equal(isValidIp('1::'), true)
  assert.equal(isValidIp('2001:db8::1'), true)
  assert.equal(isValidIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), true)
  assert.equal(isValidIp('fe80::abcd:ef01'), true)
  assert.equal(isValidIp('::ffff:192.168.1.1'), true)
  assert.equal(isValidIp('64:ff9b::192.0.2.33'), true)
})

test('isValidIp rejects invalid ipv6', () => {
  assert.equal(isValidIp('1::2::3'), false)
  assert.equal(isValidIp(':::'), false)
  assert.equal(isValidIp('12345::'), false)
  assert.equal(isValidIp('g::1'), false)
  assert.equal(isValidIp('1:2:3:4:5:6:7'), false)
  assert.equal(isValidIp('1:2:3:4:5:6:7:8:9'), false)
  assert.equal(isValidIp('fe80::1%eth0'), false)
  assert.equal(isValidIp('::ffff:999.168.1.1'), false)
})

test('parseIpEntry classifies ip and cidr', () => {
  assert.deepEqual(parseIpEntry('1.2.3.4'), { kind: 'ip', value: '1.2.3.4' })
  assert.deepEqual(parseIpEntry('10.0.0.0/8'), { kind: 'cidr', value: '10.0.0.0/8' })
  assert.deepEqual(parseIpEntry('2001:db8::1'), { kind: 'ip', value: '2001:db8::1' })
  assert.deepEqual(parseIpEntry('2001:db8::/32'), { kind: 'cidr', value: '2001:db8::/32' })
  assert.equal(parseIpEntry('not-an-ip'), null)
  assert.equal(parseIpEntry('10.0.0.0/33'), null)
  assert.equal(parseIpEntry('2001:db8::/129'), null)
  assert.equal(parseIpEntry('10.0.0.0/8/8'), null)
  assert.equal(parseIpEntry('10.0.0.0/'), null)
  assert.equal(parseIpEntry('/8'), null)
  assert.equal(parseIpEntry(''), null)
})

test('normalizeEntry canonicalizes ipv4 and cidr', () => {
  assert.equal(normalizeEntry('1.2.3.4'), '1.2.3.4')
  assert.equal(normalizeEntry('10.1.2.3/8'), '10.0.0.0/8')
  assert.equal(normalizeEntry('192.168.1.77/24'), '192.168.1.0/24')
  assert.equal(normalizeEntry('192.168.1.0/24'), '192.168.1.0/24')
  assert.equal(normalizeEntry('0.0.0.0/0'), '0.0.0.0/0')
  assert.equal(normalizeEntry('255.255.255.255/32'), '255.255.255.255/32')
  assert.equal(normalizeEntry('01.2.3.4'), null)
})

test('normalizeEntry canonicalizes ipv6', () => {
  assert.equal(normalizeEntry('::'), '::')
  assert.equal(normalizeEntry('0:0:0:0:0:0:0:1'), '::1')
  assert.equal(normalizeEntry('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1')
  assert.equal(normalizeEntry('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1')
  assert.equal(normalizeEntry('2001:db8::/32'), '2001:db8::/32')
  assert.equal(normalizeEntry('2001:db8:ffff::1/32'), '2001:db8::/32')
  assert.equal(normalizeEntry('2001:db8::/129'), null)
})

test('ipMatchesEntry ipv4 cidr boundaries', () => {
  const entry = { kind: 'cidr', value: '10.0.0.0/8' }
  assert.equal(ipMatchesEntry('10.0.0.0', entry), true)
  assert.equal(ipMatchesEntry('10.255.255.255', entry), true)
  assert.equal(ipMatchesEntry('10.1.2.3', entry), true)
  assert.equal(ipMatchesEntry('11.0.0.0', entry), false)
  assert.equal(ipMatchesEntry('9.255.255.255', entry), false)
})

test('ipMatchesEntry /24 and /32 boundaries', () => {
  const net24 = { kind: 'cidr', value: '192.168.1.0/24' }
  assert.equal(ipMatchesEntry('192.168.1.0', net24), true)
  assert.equal(ipMatchesEntry('192.168.1.255', net24), true)
  assert.equal(ipMatchesEntry('192.168.2.0', net24), false)
  assert.equal(ipMatchesEntry('192.168.0.255', net24), false)
  const host = { kind: 'cidr', value: '192.168.1.5/32' }
  assert.equal(ipMatchesEntry('192.168.1.5', host), true)
  assert.equal(ipMatchesEntry('192.168.1.6', host), false)
})

test('ipMatchesEntry /0 matches all ipv4 and no ipv6', () => {
  const any4 = { kind: 'cidr', value: '0.0.0.0/0' }
  assert.equal(ipMatchesEntry('1.2.3.4', any4), true)
  assert.equal(ipMatchesEntry('255.255.255.255', any4), true)
  assert.equal(ipMatchesEntry('2001:db8::1', any4), false)
  const any6 = { kind: 'cidr', value: '::/0' }
  assert.equal(ipMatchesEntry('2001:db8::1', any6), true)
  assert.equal(ipMatchesEntry('1.2.3.4', any6), false)
})

test('ipMatchesEntry ipv6 cidr boundaries', () => {
  const entry = { kind: 'cidr', value: '2001:db8::/32' }
  assert.equal(ipMatchesEntry('2001:db8::', entry), true)
  assert.equal(ipMatchesEntry('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', entry), true)
  assert.equal(ipMatchesEntry('2001:db9::1', entry), false)
  assert.equal(ipMatchesEntry('2001:db7::1', entry), false)
  const v6host = { kind: 'cidr', value: 'fe80::1/128' }
  assert.equal(ipMatchesEntry('fe80::1', v6host), true)
  assert.equal(ipMatchesEntry('fe80::2', v6host), false)
})

test('ipMatchesEntry plain ip entries compare canonically', () => {
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'ip', value: '1.2.3.4' }), true)
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'ip', value: '1.2.3.5' }), false)
  assert.equal(ipMatchesEntry('2001:0DB8::1', { kind: 'ip', value: '2001:db8::1' }), true)
  assert.equal(ipMatchesEntry('2001:db8::1', { kind: 'ip', value: '2001:db8::2' }), false)
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'ip', value: '::ffff:1.2.3.4' }), false)
  assert.equal(ipMatchesEntry('::ffff:1.2.3.4', { kind: 'ip', value: '1.2.3.4' }), false)
})

test('ipMatchesEntry rejects malformed input', () => {
  assert.equal(ipMatchesEntry('nope', { kind: 'ip', value: '1.2.3.4' }), false)
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'ip', value: 'nope' }), false)
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'cidr', value: '10.0.0.0/99' }), false)
  assert.equal(ipMatchesEntry('1.2.3.4', { kind: 'other', value: '1.2.3.4' }), false)
  assert.equal(ipMatchesEntry('1.2.3.4', null), false)
})

test('ipMatchesEntry accepts raw string entries', () => {
  assert.equal(ipMatchesEntry('10.4.5.6', '10.0.0.0/8'), true)
  assert.equal(ipMatchesEntry('2001:db8::5', '2001:db8::/32'), true)
  assert.equal(ipMatchesEntry('11.4.5.6', '10.0.0.0/8'), false)
})

test('ipScopeKey keeps ipv4 canonical and distinct', () => {
  assert.equal(ipScopeKey('1.2.3.4'), '1.2.3.4')
  assert.equal(ipScopeKey(' 001.2.3.4 '), '001.2.3.4')
  assert.equal(ipScopeKey('255.255.255.255'), '255.255.255.255')
  assert.notEqual(ipScopeKey('1.2.3.4'), ipScopeKey('1.2.3.5'))
})

test('ipScopeKey aggregates ipv6 into /64 buckets', () => {
  assert.equal(ipScopeKey('2001:db8:1:2::1'), '2001:db8:1:2::/64')
  assert.equal(ipScopeKey('2001:db8:1:2::1'), ipScopeKey('2001:db8:1:2:ffff:ffff:ffff:ffff'))
  assert.notEqual(ipScopeKey('2001:db8:1:2::1'), ipScopeKey('2001:db8:1:3::1'))
  assert.equal(ipScopeKey('2001:0DB8:0001:0002:0000:0000:0000:0001'), '2001:db8:1:2::/64')
})

test('ipScopeKey maps ipv4-mapped ipv6 to ipv4', () => {
  assert.equal(ipScopeKey('::ffff:1.2.3.4'), '1.2.3.4')
  assert.equal(ipScopeKey('::ffff:102:304'), '1.2.3.4')
})

test('ipScopeKey handles invalid or empty input', () => {
  assert.equal(ipScopeKey(''), '0.0.0.0')
  assert.equal(ipScopeKey('   '), '0.0.0.0')
  assert.equal(ipScopeKey(null), '0.0.0.0')
  assert.equal(ipScopeKey('not-an-ip'), 'not-an-ip')
})
