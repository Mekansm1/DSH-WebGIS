import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polygon, featureCollection, feature, point, lineString } from '@turf/helpers'
import {
  normalizeFC,
  cleanFeatureCollection,
  bboxOf,
  geometryTypesOf,
  makeResultLayer,
  summarize,
  requireLayer,
  requireFeatures,
  requirePolygonOnly,
  requireField,
  opBuffer,
  opCentroids,
  opConvexHull,
  opBBoxPolygon,
  opDissolve,
  opSimplify,
  opExplode,
  opIntersect,
  opClip,
  opDifference,
  opUnion,
  opSelectByValue,
  opSpatialJoin,
  opSmooth,
  opReproject,
  opRegularGrid,
  opVoronoi,
  opAttributeJoin,
  opSelectByLocation,
} from '../lib/geo-processing.js'

// 两个 10°×10° 正方形，重叠区域为 [5,5]–[10,10]（5×5）
function square(w, s, e, n, props = {}) {
  return polygon([[
    [w, s], [e, s], [e, n], [w, n], [w, s],
  ]], props)
}
const layerA = makeResultLayer({
  id: 'a', name: '图层A',
  geojson: featureCollection([square(0, 0, 10, 10, { name: 'a' })]),
  source: 'gis-result',
})
const layerB = makeResultLayer({
  id: 'b', name: '图层B',
  geojson: featureCollection([square(5, 5, 15, 15, { name: 'b' })]),
  source: 'gis-result',
})

test('normalizeFC 支持 FC / Feature / Geometry，非法输入抛错', () => {
  const fcInput = featureCollection([square(0, 0, 1, 1)])
  assert.equal(normalizeFC(fcInput).type, 'FeatureCollection')
  const feat = square(0, 0, 1, 1)
  assert.equal(normalizeFC(feat).features.length, 1)
  const geom = square(0, 0, 1, 1).geometry
  assert.equal(normalizeFC(geom).features.length, 1)
  assert.throws(() => normalizeFC({ foo: 1 }))
  assert.throws(() => normalizeFC(null))
})

test('cleanFeatureCollection 丢弃 null/缺失几何', () => {
  const dirty = featureCollection([
    square(0, 0, 1, 1),
    { type: 'Feature', properties: {}, geometry: null },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
  ])
  const clean = cleanFeatureCollection(dirty)
  assert.equal(clean.features.length, 2)
})

test('bboxOf / geometryTypesOf', () => {
  assert.deepEqual(bboxOf(layerA.geojson), [0, 0, 10, 10])
  assert.equal(bboxOf(featureCollection([])), null)
  assert.deepEqual(geometryTypesOf(layerA.geojson), ['Polygon'])
  assert.deepEqual(geometryTypesOf(featureCollection([
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
  ])), ['Point'])
})

test('makeResultLayer 计算汇总字段，summarize 摘掉 geojson，mode 默认 points 且透传', () => {
  assert.equal(layerA.featureCount, 1)
  assert.deepEqual(layerA.bbox, [0, 0, 10, 10])
  assert.deepEqual(layerA.geometryTypes, ['Polygon'])
  assert.equal(layerA.visible, true)
  assert.equal(layerA.mode, 'points', 'makeResultLayer 默认 mode=points')
  const s = summarize(layerA)
  assert.ok(!('geojson' in s))
  assert.equal(s.id, 'a')
  assert.equal(s.mode, 'points', 'summarize 透传 mode')

  const heat = makeResultLayer({ id: 'h', name: '热', geojson: featureCollection([]), source: 'gis-result', mode: 'hex' })
  assert.equal(heat.mode, 'hex', '显式 mode 生效')
})

test('守卫函数', () => {
  assert.equal(requireLayer([layerA], 'a').id, 'a')
  assert.match(requireLayer([layerA], 'nope'), /找不到图层/)
  assert.equal(requireFeatures(layerA), null)
  const empty = makeResultLayer({ id: 'e', name: '空', geojson: featureCollection([]), source: 'gis-result' })
  assert.match(requireFeatures(empty), /没有可处理/)
  assert.equal(requirePolygonOnly(layerA, '测试'), null)
  const pts = makeResultLayer({
    id: 'p', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] })]),
    source: 'gis-result',
  })
  assert.match(requirePolygonOnly(pts, '溶解'), /仅支持面要素/)
  assert.equal(requireField(layerA, 'name'), null)
  assert.match(requireField(layerA, 'nope'), /没有字段/)
})

test('opBuffer 生成扩大的面', () => {
  const out = opBuffer(layerA, 0.5, 'degrees')
  assert.equal(out.type, 'FeatureCollection')
  assert.equal(out.features.length, 1)
  const b = bboxOf(out)
  assert.ok(b[0] < 0 && b[1] < 0 && b[2] > 10 && b[3] > 10, `bbox 应外扩: ${b}`)
})

test('opCentroids 逐要素产出点', () => {
  const two = makeResultLayer({
    id: 't', name: '两个面',
    geojson: featureCollection([square(0, 0, 5, 5), square(6, 6, 9, 9)]),
    source: 'gis-result',
  })
  const out = opCentroids(two)
  assert.equal(out.features.length, 2)
  assert.equal(out.features[0].geometry.type, 'Point')
})

test('opConvexHull 点集凸包', () => {
  const pts = makeResultLayer({
    id: 'p', name: '点',
    geojson: featureCollection([
      feature({ type: 'Point', coordinates: [0, 0] }),
      feature({ type: 'Point', coordinates: [10, 0] }),
      feature({ type: 'Point', coordinates: [5, 10] }),
    ]),
    source: 'gis-result',
  })
  const out = opConvexHull(pts)
  assert.equal(out.features.length, 1)
  assert.match(out.features[0].geometry.type, /Polygon/)
})

test('opBBoxPolygon 外接矩形', () => {
  const out = opBBoxPolygon(layerA)
  assert.deepEqual(out.features[0].geometry.coordinates[0][0], [0, 0])
})

test('opDissolve 按字段合并 / 全图合并', () => {
  const two = makeResultLayer({
    id: 'd', name: '两地块',
    geojson: featureCollection([
      square(0, 0, 5, 10, { group: 'x' }),
      square(5, 0, 10, 10, { group: 'x' }),
      square(20, 20, 25, 25, { group: 'y' }),
    ]),
    source: 'gis-result',
  })
  const byField = opDissolve(two, 'group')
  assert.equal(byField.features.length, 2)
  assert.deepEqual(bboxOf(byField), [0, 0, 25, 25])
  const all = opDissolve(two, undefined)
  assert.equal(all.features.length, 1)
  assert.deepEqual(bboxOf(all), [0, 0, 25, 25])
})

test('opSimplify 减少坐标数量', () => {
  const wavy = polygon([[
    [0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0], [5, 0.01], [6, 0], [7, 0.01],
    [7, 1], [6, 1.01], [5, 1], [4, 1.01], [3, 1], [2, 1.01], [1, 1], [0, 1], [0, 0],
  ]])
  const layer = makeResultLayer({ id: 's', name: '锯齿', geojson: featureCollection([wavy]), source: 'gis-result' })
  const before = wavy.geometry.coordinates[0].length
  const out = opSimplify(layer, 0.5, false)
  const after = out.features[0].geometry.coordinates[0].length
  assert.ok(after < before)
})

test('opExplode 拆分多部件', () => {
  const multi = feature({
    type: 'MultiPolygon',
    coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], [[[3, 3], [4, 3], [4, 4], [3, 4], [3, 3]]]],
  })
  const layer = makeResultLayer({ id: 'm', name: '多部件', geojson: featureCollection([multi]), source: 'gis-result' })
  const out = opExplode(layer)
  assert.equal(out.features.length, 2)
  assert.equal(out.features[0].geometry.type, 'Polygon')
})

test('opIntersect / opClip 得到 5×5 重叠区', () => {
  const inter = opIntersect(layerA, layerB)
  assert.equal(inter.features.length, 1)
  assert.deepEqual(bboxOf(inter), [5, 5, 10, 10])
  const clip = opClip(layerA, layerB)
  assert.deepEqual(bboxOf(clip), [5, 5, 10, 10])
})

test('opDifference 得到 L 形（A 减重叠区）', () => {
  const diff = opDifference(layerA, layerB)
  assert.equal(diff.features.length, 1)
  const b = bboxOf(diff)
  // A(0-10)×(0-10) 减去 [5,5]-[10,10]，bbox 不变但面积变小
  assert.deepEqual(b, [0, 0, 10, 10])
  const area = diff.features[0].geometry.type === 'Polygon'
    ? diff.features[0].geometry.coordinates[0].length
    : 0
  assert.ok(area > 0)
})

test('opUnion 合并两图层', () => {
  const u = opUnion(layerA, layerB)
  assert.equal(u.features.length, 1)
  assert.deepEqual(bboxOf(u), [0, 0, 15, 15])
})

test('opSelectByValue 各种运算符', () => {
  const pts = makeResultLayer({
    id: 'sel', name: '选择',
    geojson: featureCollection([
      feature({ type: 'Point', coordinates: [0, 0] }, { city: '杭州', pop: 100 }),
      feature({ type: 'Point', coordinates: [1, 1] }, { city: '北京', pop: 200 }),
      feature({ type: 'Point', coordinates: [2, 2] }, { city: '上海', pop: 300 }),
      feature({ type: 'Point', coordinates: [3, 3] }, { city: null, pop: null }),
    ]),
    source: 'gis-result',
  })
  assert.equal(opSelectByValue(pts, 'pop', 'gt', '150').features.length, 2)
  assert.equal(opSelectByValue(pts, 'pop', 'eq', '100').features.length, 1)
  assert.equal(opSelectByValue(pts, 'city', 'eq', '北京').features.length, 1)
  assert.equal(opSelectByValue(pts, 'city', 'in', '北京,上海').features.length, 2)
  assert.equal(opSelectByValue(pts, 'city', 'is_null', undefined).features.length, 1)
  assert.equal(opSelectByValue(pts, 'city', 'not_null', undefined).features.length, 3)
  assert.equal(opSelectByValue(pts, 'city', 'contains', '海').features.length, 1)
})

test('opSpatialJoin within：点在面内计数', () => {
  const target = makeResultLayer({
    id: 't', name: '目标点',
    geojson: featureCollection([
      feature({ type: 'Point', coordinates: [7, 7] }, { name: '内部点' }),
      feature({ type: 'Point', coordinates: [50, 50] }, { name: '外部点' }),
    ]),
    source: 'gis-result',
  })
  const join = layerB // 5-15 × 5-15 正方形
  const out = opSpatialJoin(target, join, 'within')
  assert.equal(out.features.length, 2)
  assert.equal(out.features[0].properties._joinCount, 1)
  assert.equal(out.features[1].properties._joinCount, 0)
})

test('opSpatialJoin contains：面包含小块计数', () => {
  const target = makeResultLayer({
    id: 't', name: '大正方形',
    geojson: featureCollection([square(0, 0, 20, 20)]),
    source: 'gis-result',
  })
  const join = makeResultLayer({
    id: 'j', name: '小正方形们',
    geojson: featureCollection([square(1, 1, 3, 3), square(4, 4, 6, 6), square(50, 50, 51, 51)]),
    source: 'gis-result',
  })
  const out = opSpatialJoin(target, join, 'contains')
  assert.equal(out.features.length, 1)
  assert.equal(out.features[0].properties._joinCount, 2)
})

// ---- 功能 4：矢量扩展 ----

test('opSmooth: 三角环 1 次迭代 2m+1 点、端点闭合；开线保端点；Point 原样', () => {
  const tri = makeResultLayer({
    id: 's', name: '三角',
    geojson: featureCollection([polygon([[[0, 0], [10, 0], [5, 8], [0, 0]]])]),
    source: 'gis-result',
  })
  const s1 = opSmooth(tri, 1)
  assert.equal(s1.features[0].geometry.coordinates[0].length, 7) // 3 顶点 → 6 + 闭合 1
  const s2 = opSmooth(tri, 2)
  assert.equal(s2.features[0].geometry.coordinates[0].length, 15) // 7 → 14 + 闭合 1
  // 开线保端点
  const line = makeResultLayer({
    id: 'l', name: '线',
    geojson: featureCollection([lineString([[0, 0], [2, 0], [4, 2]])]),
    source: 'gis-result',
  })
  const sl = opSmooth(line, 1)
  const coords = sl.features[0].geometry.coordinates
  assert.deepEqual(coords[0], [0, 0])
  assert.deepEqual(coords[coords.length - 1], [4, 2])
  // Point 原样
  const pts = makeResultLayer({
    id: 'p', name: '点',
    geojson: featureCollection([point([1, 2])]),
    source: 'gis-result',
  })
  assert.deepEqual(opSmooth(pts, 2).features[0].geometry.coordinates, [1, 2])
})

test('opReproject: WGS84 点 → Web Mercator，再转回近似原值', () => {
  const layer = makeResultLayer({
    id: 'r', name: '点',
    geojson: featureCollection([point([116.4, 39.9])]),
    source: 'gis-result',
  })
  const merc = opReproject(layer, 'mercator').features[0].geometry.coordinates
  assert.ok(Math.abs(merc[0] - 12957588.7) < 1, `x=${merc[0]}`)
  assert.ok(Math.abs(merc[1] - 4851421.2) < 1, `y=${merc[1]}`)
  const back = opReproject(makeResultLayer({ id: 'r2', name: 'x', geojson: featureCollection([feature({ type: 'Point', coordinates: merc })]), source: 'gis-result' }), 'wgs84')
  const ll = back.features[0].geometry.coordinates
  assert.ok(Math.abs(ll[0] - 116.4) < 1e-6)
  assert.ok(Math.abs(ll[1] - 39.9) < 1e-6)
})

test('opRegularGrid: 合法 bbox 出格网；非法 bbox / cellSize 抛错', () => {
  const grid = opRegularGrid([0, 0, 10, 10], 200, 'kilometers')
  assert.ok(grid.features.length >= 1)
  assert.match(grid.features[0].geometry.type, /Polygon/)
  assert.throws(() => opRegularGrid([10, 0, 0, 10], 5, 'kilometers'), /bbox 非法/)
  assert.throws(() => opRegularGrid([0, 0, 10, 10], 0, 'kilometers'), /cellSize/)
})

test('opVoronoi: ≥3 点出泰森多边形；<3 点抛错', () => {
  const layer = makeResultLayer({
    id: 'v', name: '点',
    geojson: featureCollection([
      point([0, 0]), point([1, 0]), point([0.5, 1]), point([2, 2]),
    ]),
    source: 'gis-result',
  })
  const out = opVoronoi(layer)
  assert.ok(out.features.length >= 3)
  assert.ok(out.features.every((f) => f.geometry.type === 'Polygon'))
  const two = makeResultLayer({
    id: 'v2', name: '两点',
    geojson: featureCollection([point([0, 0]), point([1, 1])]),
    source: 'gis-result',
  })
  assert.throws(() => opVoronoi(two), /至少需要 3 个点/)
})

test('opAttributeJoin: inner join 合并属性、无命中丢弃、缺字段抛错', () => {
  const target = makeResultLayer({
    id: 't', name: '目标',
    geojson: featureCollection([
      square(0, 0, 1, 1, { code: 'A', pop: 10 }),
      square(2, 2, 3, 3, { code: 'B', pop: 20 }),
      square(4, 4, 5, 5, { code: 'X', pop: 30 }),
    ]),
    source: 'gis-result',
  })
  const join = makeResultLayer({
    id: 'j', name: '字典',
    geojson: featureCollection([
      square(9, 9, 10, 10, { code: 'A', label: '甲类' }),
      square(9, 9, 10, 10, { code: 'B', label: '乙类' }),
    ]),
    source: 'gis-result',
  })
  const out = opAttributeJoin(target, join, 'code')
  assert.equal(out.features.length, 2) // X 无匹配丢弃
  assert.equal(out.features[0].properties.label, '甲类')
  assert.equal(out.features[0].properties.pop, 10) // target 属性保留（join 无 pop 冲突）
  assert.throws(() => opAttributeJoin(target, join, 'nope'), /没有字段/)
})

test('opSelectByLocation: overlay within 筛选 / bbox intersects / 二选一校验', () => {
  const layer = makeResultLayer({
    id: 's', name: '点',
    geojson: featureCollection([
      point([7, 7], { name: '内' }),
      point([50, 50], { name: '外' }),
    ]),
    source: 'gis-result',
  })
  const zone = makeResultLayer({
    id: 'z', name: '范围',
    geojson: featureCollection([square(0, 0, 10, 10)]),
    source: 'gis-result',
  })
  const byOverlay = opSelectByLocation(layer, 'within', zone)
  assert.equal(byOverlay.features.length, 1)
  assert.equal(byOverlay.features[0].properties.name, '内')
  const byBbox = opSelectByLocation(layer, 'intersects', undefined, [45, 45, 55, 55])
  assert.equal(byBbox.features.length, 1)
  assert.equal(byBbox.features[0].properties.name, '外')
  assert.throws(() => opSelectByLocation(layer, 'intersects', zone, [0, 0, 1, 1]), /必须且只能提供一个/)
})

test('makeResultLayer：多几何族（families>1）禁 Arrow，即使带 duckTable 也 dataFormat=geojson', () => {
  const big = makeResultLayer({
    id: 'ds_1', name: '混合', source: 'dataset',
    geojson: featureCollection([square(0, 0, 1, 1)]),
    duckTable: 'duckdb_x', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000, // >10 万 → deck
    families: ['point', 'polygon'],
  })
  assert.equal(big.renderer, 'deck')
  assert.equal(big.dataFormat, 'geojson', '多族强制 geojson（避免 Arrow 静默只编主族）')
  // 单族（或不带 families）的 duckTable 大图层 → arrow
  const single = makeResultLayer({
    id: 'ds_2', name: '单族', source: 'dataset',
    geojson: featureCollection([square(0, 0, 1, 1)]),
    duckTable: 'duckdb_y', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000,
  })
  assert.equal(single.dataFormat, 'arrow')
})

test('P0-1 回归：duck 大图层 bbox 用 fullBbox（全量真实范围），不用抽样 geojson 的 bbox', () => {
  // 模拟：真实数据双簇（美国+中国），但上图抽样只落在 [0,0,10,10] 的抽样窗内。
  const sampleOnly = featureCollection([square(0, 0, 10, 10)])
  const full = [-130, -10, 135, 60]
  const duckBig = makeResultLayer({
    id: 'p0_1', name: 'P0-1', source: 'dataset',
    geojson: sampleOnly,
    duckTable: 'duckdb_z', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000,
    fullBbox: full,
  })
  assert.deepEqual(duckBig.bbox, full, '有 fullBbox 时 bbox 必须代表完整数据，而非抽样 geojson')
  assert.deepEqual(summarize(duckBig).bbox, full, 'summarize 把全量 bbox 透传给客户端（视口裁剪用它）')
  // 不带 fullBbox（物化/未灌表图层）→ 保持 geojson bbox（geojson=全量，二者一致）
  const noFull = makeResultLayer({
    id: 'p0_1b', name: 'P0-1b', source: 'dataset',
    geojson: sampleOnly,
    duckTable: 'duckdb_w', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000,
  })
  assert.deepEqual(noFull.bbox, [0, 0, 10, 10])
  // fullBbox=null（全表范围算不出）→ 回退抽样 bbox，不产出 null/Infinity
  const nullFull = makeResultLayer({
    id: 'p0_1c', name: 'P0-1c', source: 'dataset',
    geojson: sampleOnly,
    duckTable: 'duckdb_v', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000,
    fullBbox: null,
  })
  assert.deepEqual(nullFull.bbox, [0, 0, 10, 10])
})
