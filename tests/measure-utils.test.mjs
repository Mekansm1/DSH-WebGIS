import { test } from 'node:test'
import assert from 'node:assert/strict'
import { haversineM, pathMeters, segmentMeters, ringPathMeters, polygonAreaM2, formatDistance, formatArea } from '../lib/client/measure-utils.js'

// 赤道 1° 经度 ≈ 111.195 km
test('haversineM: 赤道经度差 1° ≈ 111.19 km', () => {
  const m = haversineM({ lon: 0, lat: 0 }, { lon: 1, lat: 0 })
  assert.ok(m > 111000 && m < 111500, `got ${m}`)
})

// 北京 ↔ 上海 约 1067 km（容差 ±30 km）
test('haversineM: 北京–上海 ≈ 1067 km', () => {
  const m = haversineM({ lon: 116.4074, lat: 39.9042 }, { lon: 121.4737, lat: 31.2304 })
  const km = m / 1000
  assert.ok(km > 1035 && km < 1100, `got ${km} km`)
})

test('pathMeters / segmentMeters: 多段累计 = 逐段求和', () => {
  const a = { lon: 116.4, lat: 39.9 }
  const b = { lon: 121.5, lat: 31.2 }
  const c = { lon: 120.0, lat: 30.5 }
  const segs = segmentMeters([a, b, c])
  assert.equal(segs.length, 2)
  const sum = segs.reduce((s, v) => s + v, 0)
  const direct = haversineM(a, b) + haversineM(b, c)
  assert.ok(Math.abs(sum - direct) < 1e-6)
  assert.ok(Math.abs(pathMeters([a, b, c]) - direct) < 1e-6)
})

test('pathMeters: <2 点为 0', () => {
  assert.equal(pathMeters([]), 0)
  assert.equal(pathMeters([{ lon: 0, lat: 0 }]), 0)
})

// 1°×1° 赤道方块：周长 ≈ 444.7 km，面积 ≈ 1.236e10 m²（球面公式，容差放宽）
const SQ = [
  { lon: 0, lat: 0 },
  { lon: 1, lat: 0 },
  { lon: 1, lat: 1 },
  { lon: 0, lat: 1 },
]
test('ringPathMeters: 闭合环含回到起点那一笔', () => {
  const per = ringPathMeters(SQ)
  assert.ok(per > 442e3 && per < 447e3, `perimeter ${per}`)
  // <3 点不闭合
  assert.equal(ringPathMeters([SQ[0], SQ[1]]), 0)
})
test('polygonAreaM2: 1°×1° 方块面积 ≈ 1.236e10 m²', () => {
  const area = polygonAreaM2(SQ)
  assert.ok(area > 1.20e10 && area < 1.27e10, `area ${area}`)
  assert.equal(polygonAreaM2([SQ[0], SQ[1]]), 0)
})
test('formatArea: m² / ha / km² 分档', () => {
  assert.equal(formatArea(0), '0 m²')
  assert.equal(formatArea(9999), '9999 m²')
  assert.equal(formatArea(10000), '1.00 ha')
  assert.equal(formatArea(50000), '5.00 ha')
  assert.equal(formatArea(2e6), '2.00 km²')
  assert.equal(formatArea(NaN), '0 m²')
  assert.equal(formatArea(-1), '0 m²')
})
test('formatDistance: 单位与位数', () => {
  assert.equal(formatDistance(0), '0 m')
  assert.equal(formatDistance(499.4), '499 m')
  assert.equal(formatDistance(842.6), '843 m')
  assert.equal(formatDistance(999), '999 m')
  assert.equal(formatDistance(1500), '1.50 km')
  assert.equal(formatDistance(12345), '12.35 km')
  assert.equal(formatDistance(150000), '150 km')
  // 非数值 / 负数兜底为 0
  assert.equal(formatDistance(NaN), '0 m')
  assert.equal(formatDistance(-5), '0 m')
})
