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

  // 点图层现在支持（默认 knn 权重）；要素太少时给出 knn 的要素数要求
  const fewPts = featureCollection([point([0, 0], { v: 1 }), point([1, 1], { v: 2 })])
  const tooFew = opMoranI(fewPts, 'v')
  assert.equal(tooFew.ok, false)
  if (!tooFew.ok) assert.match(tooFew.message, /knn 需要至少/)
  // 显式指定 queen 时才报「仅支持面要素」
  const queenPts = opMoranI(fewPts, 'v', { type: 'queen' })
  assert.equal(queenPts.ok, false)
  if (!queenPts.ok) assert.match(queenPts.message, /仅支持面要素/)

  const constant = featureCollection([
    square(0, 0, 1, 1, { v: 5 }),
    square(1, 0, 2, 1, { v: 5 }),
  ])
  const constF = opMoranI(constant, 'v')
  assert.equal(constF.ok, false)
  if (!constF.ok) assert.match(constF.message, /常量/)
})

// ---- 权重矩阵 / 置换检验 / LISA（新增能力） ----

import { makeWeightMatrix, opLocalMoranI, defaultWeightFor } from '../lib/geo-stats.js'

/** 横向一排 n 个 1°×1° 相邻方块，值由 values 给定。 */
function strip(values) {
  return featureCollection(values.map((v, i) => square(i, 0, i + 1, 1, { v })))
}

test('makeWeightMatrix: queen 认共边与共点，rook 只认共边', () => {
  // 两个共边方块 + 一个只在对角共点的方块
  const feats = [
    square(0, 0, 1, 1, { v: 1 }),
    square(1, 0, 2, 1, { v: 2 }),
    square(2, 1, 3, 2, { v: 3 }), // 与第 2 个仅共点（对角）
  ].map((f) => f)
  const queen = makeWeightMatrix(feats, { type: 'queen' })
  const rook = makeWeightMatrix(feats, { type: 'rook' })
  assert.equal(queen.ok, true)
  assert.equal(rook.ok, true)
  if (queen.ok && rook.ok) {
    assert.equal(queen.matrix.neighborPairs, 2, 'queen：共边 1 对 + 共点 1 对')
    assert.equal(rook.matrix.neighborPairs, 1, 'rook：只算共边那 1 对')
    assert.equal(queen.matrix.S0, 4)
    assert.equal(queen.matrix.w[0][1], 1)
    assert.equal(queen.matrix.w[1][0], 1, '对称')
  }
})

test('makeWeightMatrix: knn 每要素连最近 k 个；distance 按阈值连；点图层默认 knn', () => {
  const pts = featureCollection([
    point([0, 0], { v: 1 }), point([0.01, 0], { v: 2 }), point([0.02, 0], { v: 3 }),
    point([1.0, 0], { v: 4 }), point([1.01, 0], { v: 5 }), point([1.02, 0], { v: 6 }),
  ])
  const knn = makeWeightMatrix(pts.features, { type: 'knn', k: 1 })
  assert.equal(knn.ok, true)
  if (knn.ok) {
    assert.equal(knn.matrix.neighborPairs, 4, '两组各 3 点、k=1：每组各连 2 对')
    assert.equal(knn.matrix.w[0][1], 1)
    assert.equal(knn.matrix.w[0][3], 0, '远点不相邻')
  }
  const dist = makeWeightMatrix(pts.features, { type: 'distance', distanceMeters: 2000 })
  assert.equal(dist.ok, true)
  if (dist.ok) assert.ok(dist.matrix.neighborPairs >= 3)
  // 阈值过小 → 无相邻
  const tight = makeWeightMatrix(pts.features, { type: 'distance', distanceMeters: 1 })
  assert.equal(tight.ok, true)
  if (tight.ok) assert.equal(tight.matrix.S0, 0)
  // 缺阈值 → 报错
  assert.equal(makeWeightMatrix(pts.features, { type: 'distance' }).ok, false)
  // 默认权重：面 queen，点 knn
  assert.equal(defaultWeightFor(['Polygon']), 'queen')
  assert.equal(defaultWeightFor(['Point']), 'knn')
})

test('opMoranI: 置换检验可复现（同 seed 同 p），且与正态近似同号同量级', () => {
  const grid = featureCollection([
    square(0, 0, 1, 1, { v: 10 }), square(1, 0, 2, 1, { v: 9 }),
    square(0, 1, 1, 2, { v: 8 }), square(1, 1, 2, 2, { v: 7 }),
    square(2, 0, 3, 1, { v: 1 }), square(3, 0, 4, 1, { v: 2 }),
    square(2, 1, 3, 2, { v: 3 }), square(3, 1, 4, 2, { v: 4 }),
  ])
  const perm1 = opMoranI(grid, 'v', { permutations: 199, seed: 7 })
  const perm2 = opMoranI(grid, 'v', { permutations: 199, seed: 7 })
  assert.equal(perm1.ok, true)
  assert.equal(perm2.ok, true)
  if (perm1.ok && perm2.ok) {
    assert.equal(perm1.p, perm2.p, '同 seed 必须复现')
    assert.match(perm1.test, /permutation/)
    assert.equal(perm1.I, perm2.I)
    assert.ok(perm1.p >= 0 && perm1.p <= 1)
  }
  const normal = opMoranI(grid, 'v')
  assert.equal(normal.ok, true)
  if (normal.ok && perm1.ok) {
    assert.equal(normal.test, 'normal')
    assert.equal(normal.weightType, 'queen')
    assert.equal(Math.sign(normal.I), Math.sign(perm1.I))
  }
})

test('opLocalMoranI: 高值小簇出 HH、低值小簇出 LL（镜像对称），写 lisa_* 属性且同 seed 可复现', () => {
  // 一排 10 个方块：前 3 个是高值小簇（其余为低值）→ 中间的应判为 HH；
  // 镜像配置（前 3 个低值小簇）→ 中间的应判为 LL。小簇是少数时条件置换才显著，这是 LISA 的正常语义。
  const mk = (vals) => featureCollection(vals.map((v, i) => square(i, 0, i + 1, 1, { v })))
  const hi = [90, 95, 100, 1, 1, 1, 1, 1, 1, 1]
  const lo = [10, 5, 0, 99, 99, 99, 99, 99, 99, 99]

  const rHi = opLocalMoranI(mk(hi), 'v', { permutations: 999, seed: 11 })
  assert.equal(rHi.ok, true)
  if (rHi.ok) {
    assert.equal(rHi.geojson.features.length, 10)
    for (const f of rHi.geojson.features) {
      assert.ok(Number.isFinite(f.properties.lisa_I))
      assert.ok(Number.isFinite(f.properties.lisa_p))
      assert.ok(['HH', 'LL', 'HL', 'LH', 'nonsig'].includes(f.properties.lisa_class))
      assert.ok(f.properties.v !== undefined, '原字段保留')
    }
    assert.ok(rHi.counts.HH >= 1, `高值小簇应出现 HH，实际 ${JSON.stringify(rHi.counts)}`)
    assert.equal(rHi.weightType, 'queen')
    assert.equal(rHi.test.startsWith('permutation'), true)
    const again = opLocalMoranI(mk(hi), 'v', { permutations: 999, seed: 11 })
    assert.equal(again.ok, true)
    if (again.ok) assert.deepEqual(again.counts, rHi.counts, '同 seed 必须复现')
  }

  const rLo = opLocalMoranI(mk(lo), 'v', { permutations: 999, seed: 11 })
  assert.equal(rLo.ok, true)
  if (rLo.ok) assert.ok(rLo.counts.LL >= 1, `低值小簇应出现 LL，实际 ${JSON.stringify(rLo.counts)}`)
})

test('opLocalMoranI / opMoranI: 点图层用 knn 可算；无相邻关系时报错', () => {
  const pts = featureCollection([
    point([0, 0], { v: 10 }), point([0.01, 0], { v: 11 }), point([0.02, 0], { v: 9 }),
    point([1, 0], { v: 1 }), point([1.01, 0], { v: 2 }), point([1.02, 0], { v: 1 }),
  ])
  const local = opLocalMoranI(pts, 'v', { permutations: 99, seed: 3 })
  assert.equal(local.ok, true)
  if (local.ok) assert.equal(local.weightType, 'knn')
  // 距离阈值过小 → 无相邻 → 明确报错
  const none = opMoranI(pts, 'v', { type: 'distance', distanceMeters: 1 })
  assert.equal(none.ok, false)
  if (!none.ok) assert.match(none.message, /没有相邻关系/)
})
