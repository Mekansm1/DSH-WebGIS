// deck-layers 单测：平面/蜂窝热力图在 deck.gl 侧的图层构造（纯配置层，可 Node 直接测）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeDeckLayer,
  makeHeatmapLayer,
  makeHexagonLayer,
  maxDensityOf,
  hexHeightFor,
  hexRadiusFor,
  MAX_DECK_POINTS,
  HEAT_RAMP,
} from '../lib/client/deck-layers.js'

/** 构造一个含可选 density 的点要素。 */
function pt(lng, lat, density) {
  return {
    type: 'Feature',
    properties: density === undefined ? {} : { density },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  }
}

const fc = (features) => ({ type: 'FeatureCollection', features })
const BBOX = [110, 30, 120, 40]
const SPEC = { id: 'r1', bbox: BBOX, visible: true }

test('maxDensityOf：扫 density 峰值；空集 0', () => {
  assert.equal(maxDensityOf(fc([pt(1, 1, 5), pt(2, 2, 3), pt(3, 3)])), 5)
  assert.equal(maxDensityOf(fc([])), 0)
  assert.equal(maxDensityOf(fc([pt(1, 1)])), 0)
})

test('hexHeightFor：缺 bbox 100；有 bbox 钳制 40–200 米', () => {
  assert.equal(hexHeightFor(null), 100)
  const h = hexHeightFor(BBOX)
  assert.ok(h >= 40 && h <= 200)
})

test('hexRadiusFor：bbox 短边约 40 格策略，正数', () => {
  const r = hexRadiusFor(BBOX)
  assert.ok(r > 0 && Number.isFinite(r))
  assert.equal(hexRadiusFor(null), 8000)
})

test('makeHeatmapLayer（平面热力图）', () => {
  const geo = fc([pt(116, 39, 10), pt(117, 40, 20)])
  const l = makeHeatmapLayer({ ...SPEC, mode: 'plane', geojson: geo })
  assert.equal(l.id, 'deck-r1-plane')
  assert.equal(l.props.aggregation, 'SUM')
  assert.equal(l.props.pickable, false)
  assert.equal(l.props.visible, true)
  assert.equal(l.props.radiusPixels, 40)
  // 域必须留空自动：显式给 [0, maxDensity] 会把聚合像素权重压成单色（无渐变）
  assert.equal(l.props.colorDomain, null)
  assert.equal(l.props.colorRange.length, HEAT_RAMP.length)
  // 数据只保留 Point 要素；accessor 语义：有 density 用 density、无则计 1
  assert.equal(l.props.data.length, 2)
  assert.equal(l.props.getWeight(pt(1, 1, 7)), 7)
  assert.equal(l.props.getWeight(pt(1, 1)), 1)
  assert.deepEqual(l.props.getPosition(pt(116, 39)), [116, 39])
})

test('makeHexagonLayer（蜂窝热力图）', () => {
  const geo = fc([pt(116, 39, 10), pt(117, 40, 20)])
  const l = makeHexagonLayer({ ...SPEC, mode: 'hex', geojson: geo, visible: false })
  assert.equal(l.id, 'deck-r1-hex')
  assert.equal(l.props.extruded, true)
  assert.equal(l.props.visible, false)
  assert.equal(l.props.pickable, false)
  assert.equal(l.props.elevationAggregation, 'SUM')
  assert.equal(l.props.colorAggregation, 'SUM')
  assert.equal(l.props.radius, hexRadiusFor(BBOX))
  assert.deepEqual(Array.from(l.props.elevationRange), [0, hexHeightFor(BBOX)])
  // 域必须留空自动：显式域若小于密集区聚合 SUM，shader 会把超界格子整格丢弃（图斑缺失）+ 柱高被压平
  assert.equal(l.props.colorDomain, null)
  assert.equal(l.props.elevationDomain, null)
  assert.equal(l.props.getElevationWeight(pt(1, 1, 4)), 4)
  assert.equal(l.props.getElevationWeight(pt(1, 1)), 1)
  assert.ok(l.props.material, '应有材质（光效）')
})

test('makeDeckLayer 按 mode 分发', () => {
  const geo = fc([pt(116, 39)])
  const p = makeDeckLayer({ ...SPEC, mode: 'plane', geojson: geo })
  const h = makeDeckLayer({ ...SPEC, mode: 'hex', geojson: geo })
  assert.equal(p.constructor.name, 'HeatmapLayer')
  assert.equal(h.constructor.name, 'HexagonLayer')
})

test('性能：超 MAX_DECK_POINTS 均匀抽稀（聚合成本控制）；不超限全量', () => {
  // 30 万点 → step 2，恰好取 15 万
  const big = []
  for (let i = 0; i < 300000; i++) big.push(pt((i % 360) - 180, (Math.floor(i / 360) % 180) - 90))
  const l = makeHeatmapLayer({ ...SPEC, mode: 'plane', geojson: fc(big) })
  assert.equal(l.props.data.length, MAX_DECK_POINTS)
  // 未超限 → 全量
  const small = makeHeatmapLayer({ ...SPEC, mode: 'plane', geojson: fc([pt(1, 1), pt(2, 2)]) })
  assert.equal(small.props.data.length, 2)
})
