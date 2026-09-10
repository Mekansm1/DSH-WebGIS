import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureCollection, point, polygon } from '@turf/helpers'
import {
  INDEX_SPECS, findIndexSpec, formatVerdict, geometryFamily, judgeIndex, opGetisOrd, opGini, opShannon,
} from '../lib/geo-indices.js'

/** 判定用的图层形态（字段体检结果用最小手写桩，避免依赖工具层）。 */
function shape(over = {}) {
  return {
    id: 'dataset',
    name: '测试图层',
    geometryTypes: ['Point'],
    featureCount: 100,
    materialized: true,
    bbox: [0, 0, 0.1, 0.1],
    recommendedFields: [{ field: 'price', valid: 100, nullRate: 0, min: 1, max: 99, mean: 50, std: 28, unique: 98 }],
    excludedFields: [],
    ...over,
  }
}

const spec = (id) => INDEX_SPECS.find((s) => s.id === id)
/** 一组点要素：values 逐个作为属性 v。 */
const pointsOf = (values) => featureCollection(values.map((v, i) => point([i * 0.001, 0], { v })))

// ---- 基尼系数 ----

test('opGini: 完全平均 = 0，极端集中 = 0.75', () => {
  const equal = opGini(pointsOf([1, 1, 1, 1]), 'v')
  assert.equal(equal.ok, true)
  assert.equal(equal.gini, 0)

  const concentrated = opGini(pointsOf([0, 0, 0, 10]), 'v')
  assert.equal(concentrated.ok, true)
  // 4 个要素里 3 个为 0：G = 1 − 1/n = 0.75
  assert.equal(concentrated.gini, 0.75)
})

test('opGini: 负值/合计为 0 报错，空值跳过并计数', () => {
  const neg = opGini(pointsOf([-1, 2, 3, 4]), 'v')
  assert.equal(neg.ok, false)
  assert.match(neg.message, /负值/)

  const zero = opGini(pointsOf([0, 0, 0, 0]), 'v')
  assert.equal(zero.ok, false)
  assert.match(zero.message, /合计为 0/)

  const withNull = opGini(featureCollection([
    point([0, 0], { v: 1 }), point([0.001, 0], { v: 2 }),
    point([0.002, 0], { v: 3 }), point([0.003, 0], { v: null }),
  ]), 'v')
  assert.equal(withNull.ok, true)
  assert.equal(withNull.n, 3)
  assert.equal(withNull.skipped, 1)
})

// ---- 香农熵 ----

test('opShannon: 4 类完全均匀 → H=ln4、均匀度=1；集中 → 更小', () => {
  const even = featureCollection(['a', 'b', 'c', 'd'].map((k, i) => point([i * 0.001, 0], { k })))
  const r1 = opShannon(even, 'k')
  assert.equal(r1.ok, true)
  assert.equal(r1.mode, 'category')
  assert.equal(r1.h, Number(Math.log(4).toFixed(4)))
  assert.equal(r1.evenness, 1)
  assert.equal(r1.categories, 4)

  const skewed = featureCollection(['a', 'a', 'a', 'b'].map((k, i) => point([i * 0.001, 0], { k })))
  const r2 = opShannon(skewed, 'k')
  assert.equal(r2.ok, true)
  assert.ok(r2.h < r1.h)
  assert.ok(r2.evenness < 1)
})

test('opShannon: 数值列自动按丰度解读（唯一值多），编码列落在类别解读', () => {
  const abundance = pointsOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130])
  const r1 = opShannon(abundance, 'v')
  assert.equal(r1.ok, true)
  assert.equal(r1.mode, 'value')

  // 唯一值少（编码列）→ 类别解读
  const codes = pointsOf([1, 1, 2, 2, 3, 3])
  const r2 = opShannon(codes, 'v')
  assert.equal(r2.ok, true)
  assert.equal(r2.mode, 'category')
  assert.equal(r2.categories, 3)

  // 显式指定可覆盖自动判断
  const r3 = opShannon(abundance, 'v', 'category')
  assert.equal(r3.ok, true)
  assert.equal(r3.mode, 'category')
  assert.equal(r3.categories, 13)

  const neg = opShannon(pointsOf([-1, 2, 3, 4]), 'v', 'value')
  assert.equal(neg.ok, false)
  assert.match(neg.message, /负值/)
})

// ---- Getis-Ord Gi* ----

/** 5×5 网格点（间距 0.01°）：值随 x 递增 → 东侧应为热点、西侧应为冷点。 */
function gridWithGradient() {
  const feats = []
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) feats.push(point([i * 0.01, j * 0.01], { v: i * 10 + 1 }))
  }
  return featureCollection(feats)
}

test('opGetisOrd: 梯度网格 → 高值端是热点(hot)、低值端是冷点(cold)，gi_q 不小于 gi_p', () => {
  const r = opGetisOrd(gridWithGradient(), 'v', { type: 'distance', distanceMeters: 1500, alpha: 0.05 })
  assert.equal(r.ok, true)
  assert.equal(r.n, 25)
  assert.ok(r.counts.hot > 0, '应识别出热点')
  assert.ok(r.counts.cold > 0, '应识别出冷点')
  assert.equal(r.counts.hot + r.counts.cold + r.counts.nonsig, 25)

  const at = (x, y) => r.geojson.features.find((f) =>
    Math.abs(f.geometry.coordinates[0] - x) < 1e-9 && Math.abs(f.geometry.coordinates[1] - y) < 1e-9)
  const southWest = at(0, 0)
  const southEast = at(0.04, 0)
  assert.equal(southEast.properties.gi_class, 'hot')
  assert.equal(southWest.properties.gi_class, 'cold')
  assert.ok(southEast.properties.gi_z > 0 && southWest.properties.gi_z < 0)
  for (const f of r.geojson.features) assert.ok(f.properties.gi_q >= f.properties.gi_p - 1e-9)
  // 原属性保留（结果图层仍能看原始字段）
  assert.equal(southEast.properties.v, 41)
})

test('opGetisOrd: 常量字段 / 空值 / 要素过少都有明确报错', () => {
  const flat = featureCollection(Array.from({ length: 9 }, (_, i) => point([i * 0.01, 0], { v: 5 })))
  const r1 = opGetisOrd(flat, 'v', { type: 'distance', distanceMeters: 2000 })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /常量/)

  const withNull = gridWithGradient()
  withNull.features[0].properties.v = null
  const r2 = opGetisOrd(withNull, 'v', { type: 'distance', distanceMeters: 1500 })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /空值\/非数值/)

  const few = featureCollection([point([0, 0], { v: 1 }), point([0.01, 0], { v: 2 }), point([0.02, 0], { v: 3 })])
  const r3 = opGetisOrd(few, 'v', { type: 'distance', distanceMeters: 5000 })
  assert.equal(r3.ok, false)
  assert.match(r3.message, /至少需要 4 个要素/)
})

test('opGetisOrd: 面图层用 queen 权重（邻接）也能算', () => {
  // 4 个方块两两相邻，值 1/2/30/1：高值块的空间滞后也高 → z > 0
  const box = (w, s, v) => polygon([[[w, s], [w + 1, s], [w + 1, s + 1], [w, s + 1], [w, s]]], { v })
  const fc = featureCollection([box(0, 0, 1), box(1, 0, 2), box(2, 0, 30), box(0, 1, 1)])
  const r = opGetisOrd(fc, 'v', { type: 'queen' })
  assert.equal(r.ok, true)
  assert.equal(r.weightType, 'queen')
  assert.equal(r.n, 4)
  const high = r.geojson.features.find((f) => f.properties.v === 30)
  assert.ok(high.properties.gi_z > 0)
})

// ---- 目录匹配 ----

test('findIndexSpec: 用户口语命中目录；目录外返回 null 而不是猜', () => {
  assert.equal(findIndexSpec('基尼系数').spec.id, 'gini')
  assert.equal(findIndexSpec('基尼').spec.id, 'gini')
  assert.equal(findIndexSpec('gini').spec.id, 'gini')
  assert.equal(findIndexSpec('算一下香农熵').spec.id, 'shannon')
  assert.equal(findIndexSpec('做个热点分析').spec.id, 'getis_ord')
  assert.equal(findIndexSpec('核密度').spec.id, 'kernel_density')
  assert.equal(findIndexSpec('莫兰').spec.id, 'moran_i')
  assert.equal(findIndexSpec('LISA').spec.id, 'local_moran')

  const unknown = findIndexSpec('随机森林重要性')
  assert.equal(unknown.spec, null)
  assert.equal(unknown.candidates.length, 0)
})

test('geometryFamily: 单族/混族/无几何', () => {
  assert.equal(geometryFamily(['Point']), 'point')
  assert.equal(geometryFamily(['Point', 'MultiPoint']), 'point')
  assert.equal(geometryFamily(['Polygon', 'MultiPolygon']), 'polygon')
  assert.equal(geometryFamily(['Point', 'Polygon']), 'mixed')
  assert.equal(geometryFamily([]), 'none')
})

// ---- 判定 ----

test('judgeIndex: 抽样图层算基尼 → 不可行（结果会失真），并给修正建议', () => {
  const v = judgeIndex(spec('gini'), shape({ materialized: false, featureCount: 2000, totalCount: 60000 }))
  assert.equal(v.feasible, false)
  assert.match(v.reasons.join(''), /抽样显示/)
  const card = formatVerdict(spec('gini'), v)
  assert.match(card, /无法计算/)
  assert.match(card, /筛|webgis_sql_layer/)
})

test('judgeIndex: 字段含负值 → 该字段被排除并给出原因；无候选时判不可行', () => {
  const s = shape({ recommendedFields: [{ field: 'delta', valid: 10, nullRate: 0, min: -5, max: 9, mean: 2, std: 3, unique: 8 }] })
  const v = judgeIndex(spec('gini'), s)
  assert.equal(v.feasible, false)
  assert.equal(v.candidates.length, 0)
  assert.match(v.fieldIssues[0].reason, /负值/)
  const card = formatVerdict(spec('gini'), v)
  assert.match(card, /无法计算/)
  assert.match(card, /delta：含负值/)
})

test('judgeIndex: 几何不匹配（核密度要点、给了面）→ 不可行；混族几何 → 不可行', () => {
  const v = judgeIndex(spec('kernel_density'), shape({ geometryTypes: ['Polygon'] }))
  assert.equal(v.feasible, false)
  assert.match(v.reasons.join(''), /需要点要素/)

  const mixed = judgeIndex(spec('moran_i'), shape({ geometryTypes: ['Point', 'Polygon'] }))
  assert.equal(mixed.feasible, false)
  assert.match(mixed.reasons.join(''), /混杂/)
})

test('judgeIndex: 空间类指数给默认权重建议（面→queen、点→knn k=5）', () => {
  const poly = judgeIndex(spec('moran_i'), shape({ geometryTypes: ['Polygon'] }))
  assert.equal(poly.suggestedParams.weight, 'queen')
  const pts = judgeIndex(spec('moran_i'), shape({ geometryTypes: ['Point'] }))
  assert.deepEqual(pts.suggestedParams, { weight: 'knn', k: 5 })
})

test('judgeIndex: 核密度按范围推荐带宽/格距，大范围自动放大格距避开 40000 格上限', () => {
  // 小范围（约 1.1km）：不应沿用默认 5000m 带宽
  const small = judgeIndex(spec('kernel_density'), shape({ bbox: [0, 0, 0.01, 0.01] }))
  assert.ok(small.suggestedParams.radiusMeters < 5000)
  assert.ok(small.suggestedParams.cellSizeMeters < 500)

  // 全国范围（约 5000km 宽）：默认 500m 格距会远超上限 → 推荐值必须把格数压到上限内
  const big = judgeIndex(spec('kernel_density'), shape({ bbox: [73, 18, 135, 54], featureCount: 650000 }))
  const cell = big.suggestedParams.cellSizeMeters
  assert.ok(cell > 500, `大范围应放大格距，实际 ${cell}`)
  assert.match(big.suggestNote, /已放大格距/)
  const cells = Math.ceil(((135 - 73) * 111320 * Math.cos((36 * Math.PI) / 180)) / cell)
    * Math.ceil(((54 - 18) * 110540) / cell)
  assert.ok(cells <= 40000, `推荐网格 ${cells} 应不超上限`)
})

test('judgeIndex: 抽样图层算核密度 → 可行但警告（与基尼的硬拦不同）', () => {
  const v = judgeIndex(spec('kernel_density'), shape({ geometryTypes: ['Point'], materialized: false, totalCount: 60000 }))
  assert.equal(v.feasible, true)
  assert.match(v.warnings.join(''), /抽样/)
})

test('judgeIndex + formatVerdict: 可行时给出候选字段与建议参数', () => {
  const v = judgeIndex(spec('shannon'), shape())
  assert.equal(v.feasible, true)
  assert.equal(v.candidates[0].field, 'price')
  const card = formatVerdict(spec('shannon'), v)
  assert.match(card, /可以计算/)
  assert.match(card, /候选字段：price/)
})

test('注册表完整性：每条都有说明/参数/工具名，id 唯一', () => {
  const ids = INDEX_SPECS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const s of INDEX_SPECS) {
    assert.ok(s.name && s.summary && s.tool.startsWith('webgis_'), `${s.id} 元信息不全`)
    assert.ok(Array.isArray(s.caveats) && s.caveats.length > 0, `${s.id} 应至少给一条注意事项`)
    assert.ok(s.needs.minFeatures >= 3, `${s.id} minFeatures 应 ≥3`)
  }
})
