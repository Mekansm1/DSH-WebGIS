import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeFeatures, geometryKind, groupFeaturesByName } from '../lib/client/basemap-extract.js'
import { BASEMAP_LAYERS, basemapLayerCatalog, defaultExportLayerNames, resolveBasemapLayer } from '../lib/basemap-layers.js'

/** 最小 MapGeoJSONFeature 桩（只喂去重/归组用到的字段）。 */
function feat(over = {}) {
  return {
    type: 'Feature',
    id: undefined,
    properties: {},
    geometry: { type: 'LineString', coordinates: [[119.1, 36.7], [119.11, 36.71]] },
    ...over,
  }
}

// ---- 去重 ----

test('dedupeFeatures: 按 feature.id 去重（瓦片 buffer 会让跨边界要素重复出现）', () => {
  const a = feat({ id: 7, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } })
  const dup = feat({ id: 7, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } })
  const b = feat({ id: 8 })
  const out = dedupeFeatures([a, dup, b])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((f) => f.id), [7, 8])
})

test('dedupeFeatures: 无 id 时按几何指纹去重（坐标取 6 位小数）', () => {
  const g = { type: 'LineString', coordinates: [[119.1, 36.7], [119.11, 36.71]] }
  const a = feat({ geometry: g })
  const same = feat({ geometry: { type: 'LineString', coordinates: [[119.1, 36.7], [119.11, 36.71]] } })
  const other = feat({ geometry: { type: 'LineString', coordinates: [[119.2, 36.8], [119.21, 36.81]] } })
  assert.equal(dedupeFeatures([a, same, other]).length, 2)
  // 浮点尾差在 6 位小数内视为同一几何
  const noisy = feat({ geometry: { type: 'LineString', coordinates: [[119.100000001, 36.7], [119.11, 36.71]] } })
  assert.equal(dedupeFeatures([a, noisy]).length, 1)
})

test('dedupeFeatures: id 与几何混用时各走各的（id 优先，不去误伤同名不同段的要素）', () => {
  const sameGeomDifferentId = [
    feat({ id: 1, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } }),
    feat({ id: 2, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } }),
  ]
  // 两条 id 不同 → 都保留（可能是同名河的不同段）
  assert.equal(dedupeFeatures(sameGeomDifferentId).length, 2)
})

// ---- 归组 ----

test('groupFeaturesByName: 同名分段归成一个 MultiLineString（用户说"白浪河"要的是一条河）', () => {
  const segs = [1, 2, 3].map((i) => feat({
    id: i,
    properties: { name: '白浪河', class: 'river' },
    geometry: { type: 'LineString', coordinates: [[119.1 + i * 0.01, 36.7], [119.11 + i * 0.01, 36.71]] },
  }))
  const other = feat({ id: 9, properties: { name: '虞河', class: 'river' } })
  const out = groupFeaturesByName([...segs, other])
  assert.equal(out.length, 2)
  const bl = out.find((f) => f.properties.name === '白浪河')
  assert.equal(bl.geometry.type, 'MultiLineString')
  assert.equal(bl.geometry.coordinates.length, 3)
  assert.equal(bl.properties.__segments, 3)
  // 单段的不包装成 Multi
  const yh = out.find((f) => f.properties.name === '虞河')
  assert.equal(yh.geometry.type, 'LineString')
})

test('groupFeaturesByName: 无名字的要素各自独立（不强行合并）', () => {
  const out = groupFeaturesByName([feat({ id: 1 }), feat({ id: 2 }), feat({ id: 3 })])
  assert.equal(out.length, 3)
})

test('groupFeaturesByName: 几何类型不一致时退回 GeometryCollection（不产生非法 Multi）', () => {
  const line = feat({ id: 1, properties: { name: 'X' } })
  const poly = feat({
    id: 2, properties: { name: 'X' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  })
  const out = groupFeaturesByName([line, poly])
  assert.equal(out.length, 1)
  assert.equal(out[0].geometry.type, 'GeometryCollection')
})

// ---- 用户说法 → source-layer ----

test('resolveBasemapLayer: 用户口语命中对应图层', () => {
  assert.equal(resolveBasemapLayer('河流').sourceLayer, 'waterway')
  assert.equal(resolveBasemapLayer('河').sourceLayer, 'waterway')
  assert.equal(resolveBasemapLayer('水系').sourceLayer, 'waterway')
  assert.equal(resolveBasemapLayer('运河').sourceLayer, 'waterway')
  assert.equal(resolveBasemapLayer('waterway').sourceLayer, 'waterway')
  assert.equal(resolveBasemapLayer('道路').sourceLayer, 'transportation')
  assert.equal(resolveBasemapLayer('路网').sourceLayer, 'transportation')
  assert.equal(resolveBasemapLayer('建筑').sourceLayer, 'building')
  assert.equal(resolveBasemapLayer('公园').sourceLayer, 'park')
  assert.equal(resolveBasemapLayer('兴趣点').sourceLayer, 'poi')
})

test('resolveBasemapLayer: 精确的 source-layer 名优先，认不出返回 null（不瞎猜）', () => {
  assert.equal(resolveBasemapLayer('landuse').sourceLayer, 'landuse')
  assert.equal(resolveBasemapLayer('boundary').sourceLayer, 'boundary')
  assert.equal(resolveBasemapLayer('人口密度'), null)
  assert.equal(resolveBasemapLayer(''), null)
})

// 单字别名（"路"/"河"）按包含匹配，所以更长的说法也能命中 —— 这是有意的宽容度：
// 模型可能传"这条路""地铁线路"这类说法。代价是会误命中，但工具描述里列了目录，
// 模型看到"认不出"的清单能自行纠正；且铁路/轨交确实在 transportation 图层里。
test('resolveBasemapLayer: 单字别名按包含匹配（宽容度，非精确）', () => {
  assert.equal(resolveBasemapLayer('地铁线路').sourceLayer, 'transportation')
  assert.equal(resolveBasemapLayer('这条路').sourceLayer, 'transportation')
  // 更长的别名优先：'河流' 命中 waterway 而不是别的
  assert.equal(resolveBasemapLayer('河流').sourceLayer, 'waterway')
})

test('底图图层目录: 每条完整，且道路被明确标注不带 name', () => {
  assert.ok(BASEMAP_LAYERS.length >= 8)
  for (const s of BASEMAP_LAYERS) {
    assert.ok(s.sourceLayer && s.name && s.aliases.length > 0, `${s.sourceLayer} 元信息不全`)
    assert.ok(['line', 'polygon', 'point', 'mixed'].includes(s.geometry))
  }
  // 道路的名字在 transportation_name 图层 —— 这是实测踩过的坑，必须显式标注
  const road = BASEMAP_LAYERS.find((s) => s.sourceLayer === 'transportation')
  assert.equal(road.hasName, false)
  assert.match(road.note, /transportation_name/)
  // 河流自带 name
  assert.equal(BASEMAP_LAYERS.find((s) => s.sourceLayer === 'waterway').hasName, true)
  assert.match(basemapLayerCatalog(), /waterway（河流\/水道）/)
})

// ---- 默认导出：全部内容图层 → 点/线/面三个图层 ----

test('geometryKind: 几何类型归到点/线/面三族，未知返回 null', () => {
  assert.equal(geometryKind('Point'), 'point')
  assert.equal(geometryKind('MultiPoint'), 'point')
  assert.equal(geometryKind('LineString'), 'line')
  assert.equal(geometryKind('MultiLineString'), 'line')
  assert.equal(geometryKind('Polygon'), 'polygon')
  assert.equal(geometryKind('MultiPolygon'), 'polygon')
  assert.equal(geometryKind('GeometryCollection'), null)
  assert.equal(geometryKind(undefined), null)
})

test('defaultExportLayerNames: 含全部内容图层 + 地名/山峰/机场等点位图层', () => {
  const names = defaultExportLayerNames()
  for (const want of ['waterway', 'water', 'transportation', 'building', 'park', 'landuse', 'landcover', 'boundary', 'poi', 'aeroway']) {
    assert.ok(names.includes(want), `默认导出应包含 ${want}`)
  }
  // 地名(place)/山峰/机场名是独立的点位数据，不是"渲染文字" —— 低缩放级别下它们往往是仅有的点来源
  for (const want of ['place', 'mountain_peak', 'aerodrome_label', 'water_name', 'housenumber']) {
    assert.ok(names.includes(want), `默认导出应包含 ${want}`)
  }
})

test('defaultExportLayerNames: 只排除几何重复的图层（否则线要素会翻倍）', () => {
  const names = defaultExportLayerNames()
  // transportation_name 的几何与 transportation 完全重复，只是多带路名
  assert.ok(!names.includes('transportation_name'))
  const skipped = BASEMAP_LAYERS.filter((s) => s.skipDefault)
  assert.deepEqual(skipped.map((s) => s.sourceLayer), ['transportation_name'])
  assert.match(skipped[0].skipDefault, /重复/)
})

test('目录: 清单里说明哪些图层默认不含以及为什么', () => {
  const catalog = basemapLayerCatalog()
  assert.match(catalog, /默认导出不含（几何与上面的图层重复，点名才取）/)
  assert.match(catalog, /transportation_name/)
  assert.match(catalog, /place（地名）/)
})

test('groupFeaturesByName: 归组键含图层名 —— 同名公园面与 POI 点不会被并成一个要素', () => {
  const park = feat({ id: 1, properties: { name: '人民公园' }, sourceLayer: 'park' })
  const poi = feat({ id: 2, properties: { name: '人民公园' }, sourceLayer: 'poi' })
  const out = groupFeaturesByName([park, poi])
  assert.equal(out.length, 2, '不同图层的同名要素应各自独立')
})
