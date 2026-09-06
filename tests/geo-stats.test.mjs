import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureCollection, feature, point, polygon } from '@turf/helpers'
import { opAverageNearestNeighbor, opKernelDensity, opMoranI } from '../lib/geo-stats.js'

function square(w, s, e, n, props = {}) {
  return polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]], props)
}

// ---- 核密度 ----

test('opKernelDensity: 点层出网格，格数=cols×rows，density 有限', () => {
  const fc = featureCollection([point([0, 0]), point([0.05, 0.05])])
  const r = opKernelDensity(fc, 5000, 500)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.ok(r.gridCols >= 1 && r.gridRows >= 1)
    assert.equal(r.geojson.features.length, r.gridCols * r.gridRows)
    assert.ok(r.geojson.features.every((f) => Number.isFinite(f.properties.density)))
  }
})

test('opKernelDensity: 面层 → ok:false 仅支持点；格距过小 → 网格过密报错', () => {
  const poly = featureCollection([square(0, 0, 10, 10)])
  const badType = opKernelDensity(poly)
  assert.equal(badType.ok, false)
  if (!badType.ok) assert.match(badType.message, /仅支持点要素/)

  const pts = featureCollection([point([0, 0]), point([10, 10])])
  const dense = opKernelDensity(pts, 5000, 1) // 1m 格距 → 几十万格
  assert.equal(dense.ok, false)
  if (!dense.ok) assert.match(dense.message, /网格过密/)
})

// ---- 平均最近邻 ----

test('opAverageNearestNeighbor: 规则格网 r>1（分散）、聚集 r<1、r=observed/expected', () => {
  const grid = featureCollection([
    point([0, 0]), point([1, 0]), point([1, 1]), point([0, 1]),
  ])
  const dispersed = opAverageNearestNeighbor(grid)
  assert.equal(dispersed.ok, true)
  if (dispersed.ok) {
    assert.equal(dispersed.n, 4)
    assert.ok(dispersed.r > 1, `规则格网应呈分散（r>1），实际 ${dispersed.r}`)
    assert.ok(Math.abs(dispersed.r - dispersed.observed / dispersed.expected) < 1e-9)
  }

  // 聚集：两团紧邻点相距很远 → bbox 大而实测近邻小 → r<<1
  const clustered = featureCollection([
    point([0, 0]), point([0.001, 0]), point([0.001, 0.001]), point([0, 0.001]),
    point([10, 10]), point([10.001, 10]), point([10.001, 10.001]), point([10, 10.001]),
  ])
  const cl = opAverageNearestNeighbor(clustered)
  assert.equal(cl.ok, true)
  if (cl.ok) assert.ok(cl.r < 1, `聚集应 r<1，实际 ${cl.r}`)
})

test('opAverageNearestNeighbor: <2 点 → ok:false', () => {
  const r = opAverageNearestNeighbor(featureCollection([point([0, 0])]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /至少需要 2 个点/)
})

// ---- Moran I ----

test('opMoranI: 正自相关构造（4 高相邻 + 4 低相邻）→ I>0、z>0、p 显著', () => {
  // n 过小（≤4）时方差公式可能为负，取 8 格保证 Var>0
  const fc = featureCollection([
    square(0, 0, 1, 1, { v: 10 }),
    square(1, 0, 2, 1, { v: 10 }),
    square(2, 0, 3, 1, { v: 10 }),
    square(3, 0, 4, 1, { v: 10 }),
    square(4, 0, 5, 1, { v: 1 }),
    square(5, 0, 6, 1, { v: 1 }),
    square(6, 0, 7, 1, { v: 1 }),
    square(7, 0, 8, 1, { v: 1 }),
  ])
  const r = opMoranI(fc, 'v')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.ok(r.I > 0, `I 应 >0（正自相关），实际 ${r.I}`)
    assert.ok(r.z > 0, `z 应 >0，实际 ${r.z}`)
    assert.ok(r.p < 0.05, `p 应显著，实际 ${r.p}`)
    assert.equal(r.n, 8)
  }
})

test('opMoranI: 无相邻 → ok:false；面类型/常量字段守卫', () => {
  const far = featureCollection([
    square(0, 0, 1, 1, { v: 10 }),
    square(100, 100, 101, 101, { v: 1 }),
  ])
  const noAdj = opMoranI(far, 'v')
  assert.equal(noAdj.ok, false)
  if (!noAdj.ok) assert.match(noAdj.message, /没有相邻关系/)

  const nonPoly = featureCollection([point([0, 0], { v: 1 }), point([1, 1], { v: 2 })])
  const badType = opMoranI(nonPoly, 'v')
  assert.equal(badType.ok, false)
  if (!badType.ok) assert.match(badType.message, /仅支持面要素/)

  const constant = featureCollection([
    square(0, 0, 1, 1, { v: 5 }),
    square(1, 0, 2, 1, { v: 5 }),
  ])
  const constF = opMoranI(constant, 'v')
  assert.equal(constF.ok, false)
  if (!constF.ok) assert.match(constF.message, /常量/)
})
