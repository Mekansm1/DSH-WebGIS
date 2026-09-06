import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedIp } from '../lib/http-fetch.js'

test('isBlockedIp: 私网/回环/链路本地/保留/组播/元数据全拒', () => {
  assert.equal(isBlockedIp('127.0.0.1'), true)
  assert.equal(isBlockedIp('127.8.8.8'), true)
  assert.equal(isBlockedIp('10.0.0.1'), true)
  assert.equal(isBlockedIp('172.16.0.1'), true)
  assert.equal(isBlockedIp('172.31.255.255'), true)
  assert.equal(isBlockedIp('192.168.1.1'), true)
  assert.equal(isBlockedIp('169.254.169.254'), true, '云元数据地址必须被拒')
  assert.equal(isBlockedIp('100.64.0.1'), true)
  assert.equal(isBlockedIp('0.0.0.0'), true)
  assert.equal(isBlockedIp('224.0.0.1'), true)
  assert.equal(isBlockedIp('255.255.255.255'), true)
  // IPv6
  assert.equal(isBlockedIp('::1'), true)
  assert.equal(isBlockedIp('::'), true)
  assert.equal(isBlockedIp('::ffff:192.168.1.1'), true, 'IPv4-mapped IPv6 解包后按 v4 判')
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true)
  assert.equal(isBlockedIp('fe80::1'), true)
  assert.equal(isBlockedIp('fc00::1'), true)
  assert.equal(isBlockedIp('fd12:abcd::1'), true)
})

test('isBlockedIp: 公网地址放行', () => {
  assert.equal(isBlockedIp('8.8.8.8'), false)
  assert.equal(isBlockedIp('114.114.114.114'), false)
  assert.equal(isBlockedIp('203.0.113.9'), false)
  assert.equal(isBlockedIp('2606:4700::1111'), false)
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false)
})
