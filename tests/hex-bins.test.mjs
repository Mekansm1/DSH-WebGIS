import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureCollection, feature, point } from '@turf/helpers'
import { hexbinFC, pickHexSizeMeters, MAX_HEX_CELLS } from '../lib/client/hex-bins.js'

/** 在 [0,0]~[0.2,0.2] 内铺 n×n 点网格。 */
function grid(n, start = 0, span = 0.2) {
  const feats = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      feats.push(point([start + (span * i) / (n - 1 || 1), start + (span * j) / (n - 1 || 1)]))
    }
  }
  return featureCollection(feats)
}

test('hexbinFC: 原始点（无 density）→ 蜂窝面，count 总和 = 点数', () => {
  const fc = grid(12)
  const hex = hexbinFC(fc)
  assert.equal(hex.type, 'FeatureCollection')
  assert.ok(hex.features.length > 0)
  const total = hex.features.reduce((s, f) => s + (f.properties.count ?? 0), 0)
  assert.equal(total, fc.features.length, '所有点都归入某个六边形')
  // 无 density → 每格 count=1，density=count
  for (const f of hex.features) {
    assert.equal(f.geometry.type, 'Polygon')
    assert.equal(f.properties.density, f.properties.count)
  }
})

test('hexbinFC: 带 density → 每格 density 求和，总密度 ≈ 输入总密度', () => {
  const feats = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      feats.push(feature({ type: 'Point', coordinates: [i * 0.01, j * 0.01] }, { density: 1 + (i + j) * 0.5 }))
    }
  }
  const fc = featureCollection(feats)
  const hex = hexbinFC(fc)
  const sumIn = feats.reduce((s, f) => s + f.properties.density, 0)
  const sumOut = hex.features.reduce((s, f) => s + (f.properties.density ?? 0), 0)
  assert.ok(Math.abs(sumOut - sumIn) < 1e-3, `总密度守恒：${sumOut} ≈ ${sumIn}`)
  for (const f of hex.features) {
    assert.equal(typeof f.properties.density, 'number')
    assert.equal(typeof f.properties.count, 'number')
  }
})

test('hexbinFC: 空输入 → 空 FeatureCollection', () => {
  const hex = hexbinFC(featureCollection([]))
  assert.equal(hex.features.length, 0)
})

test('hexbinFC: 每个六边形是闭合的 6 顶点 Polygon', () => {
  const hex = hexbinFC(grid(10))
  for (const f of hex.features) {
    const ring = f.geometry.coordinates[0]
    assert.equal(ring.length, 7, '6 顶点 + 闭合点')
    assert.deepEqual(ring[0], ring[ring.length - 1], '首尾闭合')
    const unique = new Set(ring.slice(0, 6).map((c) => c.join(',')))
    assert.equal(unique.size, 6, '6 个顶点互不相同')
  }
})

test('hexbinFC: 确定性（同输入两次结果一致）', () => {
  const fc = grid(10)
  assert.deepEqual(hexbinFC(fc), hexbinFC(fc))
})

test('hexbinFC: MultiPoint 展开归并', () => {
  const mp = feature({ type: 'MultiPoint', coordinates: [[0, 0], [0.5, 0.5]] })
  const hex = hexbinFC(featureCollection([mp]))
  const total = hex.features.reduce((s, f) => s + (f.properties.count ?? 0), 0)
  assert.equal(total, 2)
})

test('pickHexSizeMeters: 面积越大格距越大，且预测格数不超上限', () => {
  const small = pickHexSizeMeters(10000, 5000)
  const large = pickHexSizeMeters(100000, 50000)
  assert.ok(large >= small, '大面积 → 更大格距')
  const predicted = (100000 * 50000 * 1.1547) / (large * large)
  assert.ok(predicted <= MAX_HEX_CELLS + 1, `格数受上限约束：${predicted} ≤ ${MAX_HEX_CELLS}`)
})
