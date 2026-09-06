// deck-charts 单测：弧线图 / 轨迹图 / 围墙图 / 辐射图的图层构造（纯配置层，可 Node 直接测）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeDeckChartLayers,
  tripsProgress,
  wallHeightFor,
  radialRadiusFor,
} from '../lib/client/deck-charts.js'

/** deck Layer 会把常量 accessor 归一化成常量、函数 accessor 保留为函数；统一取值。 */
function acc(props, name, feature) {
  const v = props[name]
  return typeof v === 'function' ? v(feature) : v
}

/** 构造一条线要素。 */
function line(coords, props = {}) {
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } }
}
/** 构造一个面要素。 */
function poly(coords, props = {}) {
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [coords] } }
}
/** 构造一个点要素。 */
function pt(lng, lat, props = {}) {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } }
}
const fc = (features) => ({ type: 'FeatureCollection', features })
const BBOX = [110, 30, 120, 40]
const SPEC = (mode, geojson, over = {}) => ({ id: 'r1', mode, geojson, bbox: BBOX, color: '#f97316', visible: true, ...over })

test('makeDeckChartLayers 按 mode 分发四种出图', () => {
  const arc = makeDeckChartLayers(SPEC('arc', fc([line([[110, 30], [120, 40]])])))
  const trips = makeDeckChartLayers(SPEC('trips', fc([line([[110, 30], [115, 35], [120, 40]])])), 0.5)
  const wall = makeDeckChartLayers(SPEC('wall', fc([poly([[110, 30], [120, 30], [120, 40], [110, 40], [110, 30]])])))
  const radial = makeDeckChartLayers(SPEC('radial', fc([pt(116, 39)])))
  assert.equal(arc[0].constructor.name, 'ArcLayer')
  assert.equal(trips[0].constructor.name, 'PathLayer')
  assert.equal(wall[0].constructor.name, 'PolygonLayer')
  assert.equal(radial[0].constructor.name, 'ScatterplotLayer')
})

test('弧线图：每段线的首尾点连弧（OD 流向），可见性/线宽透传', () => {
  const geo = fc([
    line([[110, 30], [120, 40]], { v: 3 }),
    line([[100, 20], [130, 50]]),
  ])
  const layers = makeDeckChartLayers(SPEC('arc', geo, { params: { width: 5 }, visible: false }))
  assert.equal(layers.length, 1)
  const [l] = layers
  assert.equal(l.props.visible, false)
  assert.equal(l.props.data.length, 2)
  // accessor 语义：source=首点、target=末点
  assert.deepEqual(acc(l.props, 'getSourcePosition', geo.features[0]), [110, 30])
  assert.deepEqual(acc(l.props, 'getTargetPosition', geo.features[0]), [120, 40])
  assert.deepEqual(acc(l.props, 'getSourcePosition', geo.features[1]), [100, 20])
  assert.deepEqual(acc(l.props, 'getTargetPosition', geo.features[1]), [130, 50])
  assert.equal(acc(l.props, 'getWidth', geo.features[0]), 5)
  assert.deepEqual(acc(l.props, 'getSourceColor', geo.features[0]), [249, 115, 22, 220])
  assert.deepEqual(acc(l.props, 'getTargetColor', geo.features[0]), [249, 115, 22, 110])
})

test('弧线图：greatCircle 大圆 + 流量字段映射线宽/深浅（opt-in）', () => {
  const geo = fc([
    line([[110, 30], [120, 40]], { flow: 0 }),
    line([[100, 20], [130, 50]], { flow: 100 }),
  ])
  const [l] = makeDeckChartLayers(SPEC('arc', geo, { params: { greatCircle: 1, flow: 1, width: 8 } }))
  assert.equal(l.props.greatCircle, true)
  // 线宽：flow=0 → 1，flow=100（峰值）→ 1+8=9
  assert.equal(acc(l.props, 'getWidth', geo.features[0]), 1)
  assert.equal(acc(l.props, 'getWidth', geo.features[1]), 9)
  // 颜色深浅随流量：源色 alpha 150→255、目标色 alpha 60→150
  assert.deepEqual(acc(l.props, 'getSourceColor', geo.features[0]), [249, 115, 22, 150])
  assert.deepEqual(acc(l.props, 'getSourceColor', geo.features[1]), [249, 115, 22, 255])
  assert.deepEqual(acc(l.props, 'getTargetColor', geo.features[0]), [249, 115, 22, 60])
  assert.deepEqual(acc(l.props, 'getTargetColor', geo.features[1]), [249, 115, 22, 150])
})

test('弧线图：缺省无大圆、无流量映射（常量宽度/颜色，旧行为回归）', () => {
  const geo = fc([line([[110, 30], [120, 40]])])
  const [l] = makeDeckChartLayers(SPEC('arc', geo))
  assert.equal(l.props.greatCircle, false)
  assert.equal(l.props.getWidth, 2)
  assert.deepEqual(l.props.getSourceColor, [249, 115, 22, 220])
  assert.deepEqual(l.props.getTargetColor, [249, 115, 22, 110])
})

test('轨迹图：全路径静态线（PathLayer 输出完整 polyline）+ 时间合成', () => {
  const geo = fc([line([[110, 30], [115, 35], [120, 40]])])
  const layers = makeDeckChartLayers(SPEC('trips', geo), 0.5)
  assert.equal(layers.length, 3)
  const [path] = layers
  assert.equal(path.constructor.name, 'PathLayer')
  assert.equal(path.props.data.length, 1)
  const d = path.props.data[0]
  assert.deepEqual(d.path, [[110, 30, 0], [115, 35, 0], [120, 40, 0]])
  assert.deepEqual(d.timestamps, [0, 1, 2]) // 缺时间属性按顶点索引合成
  assert.deepEqual(acc(path.props, 'getPath', d), [[110, 30, 0], [115, 35, 0], [120, 40, 0]])
  assert.deepEqual(acc(path.props, 'getColor', d), [249, 115, 22, 200])
  // 有 timestamps 属性 → 直接使用；头点按 loopLength 缩放插值（progress 0.5 → currentTime=100 → 起点）
  const geo2 = fc([line([[110, 30], [120, 40]], { timestamps: [100, 200] })])
  const [l2] = makeDeckChartLayers(SPEC('trips', geo2), 0.5)
  const d2 = l2.props.data[0]
  assert.deepEqual(d2.timestamps, [100, 200])
  const core = makeDeckChartLayers(SPEC('trips', geo2), 0.5)[2]
  assert.deepEqual(acc(core.props, 'getPosition', core.props.data[0]), [110, 30])
})

test('轨迹图：白色高亮头点沿静态路径从起点插值到终点', () => {
  const geo = fc([line([[110, 30], [115, 35], [120, 40]])])
  const layers = makeDeckChartLayers(SPEC('trips', geo), 0.5) // progress 0.5 → currentTime=1 → 中间顶点
  assert.equal(layers.length, 3)
  assert.equal(layers[0].constructor.name, 'PathLayer')
  assert.equal(layers[1].constructor.name, 'ScatterplotLayer')
  const core = layers[2]
  assert.equal(core.props.radiusUnits, 'pixels')
  const d = core.props.data[0]
  assert.deepEqual(acc(core.props, 'getPosition', d), [115, 35])
  assert.deepEqual(acc(core.props, 'getFillColor', d), [255, 255, 255, 255])
  // progress 0 → 起点
  const start = makeDeckChartLayers(SPEC('trips', geo), 0)[2]
  assert.deepEqual(acc(start.props, 'getPosition', start.props.data[0]), [110, 30])
  // progress 1 → 终点
  const end = makeDeckChartLayers(SPEC('trips', geo), 1)[2]
  assert.deepEqual(acc(end.props, 'getPosition', end.props.data[0]), [120, 40])
})

test('围墙图：面要素拉伸成 3D（getPolygon 吃 rings），高度按 bbox 或 params 覆盖', () => {
  const ring = [[110, 30], [120, 30], [120, 40], [110, 40], [110, 30]]
  const geo = fc([poly(ring), poly([[100, 20], [105, 20], [105, 25], [100, 25], [100, 20]])])
  const [l] = makeDeckChartLayers(SPEC('wall', geo))
  assert.equal(l.props.extruded, true)
  assert.equal(l.props.data.length, 2)
  assert.deepEqual(acc(l.props, 'getPolygon', geo.features[0]), [ring])
  assert.equal(acc(l.props, 'getElevation', geo.features[0]), wallHeightFor(BBOX))
  const [l2] = makeDeckChartLayers(SPEC('wall', geo, { params: { height: 300 } }))
  assert.equal(acc(l2.props, 'getElevation', geo.features[0]), 300)
  const fill = acc(l.props, 'getFillColor', geo.features[0])
  assert.ok(fill[3] < 255, '填充应半透明')
})

test('围墙图：描边宽可经 params.width 覆盖（缺省 2）', () => {
  const ring = [[110, 30], [120, 30], [120, 40], [110, 40], [110, 30]]
  const geo = fc([poly(ring)])
  const [l] = makeDeckChartLayers(SPEC('wall', geo))
  assert.equal(l.props.lineWidthMinPixels, 2)
  const [l2] = makeDeckChartLayers(SPEC('wall', geo, { params: { width: 8 } }))
  assert.equal(l2.props.lineWidthMinPixels, 8)
})

test('辐射图：点要素绕点画米制半径圆（影响范围），半径可覆盖', () => {
  const geo = fc([pt(116, 39), pt(117, 40)])
  const [l] = makeDeckChartLayers(SPEC('radial', geo))
  assert.equal(l.props.radiusUnits, 'meters')
  assert.equal(l.props.filled, true)
  assert.equal(l.props.stroked, true)
  assert.equal(acc(l.props, 'getRadius', geo.features[0]), radialRadiusFor(BBOX))
  const [l2] = makeDeckChartLayers(SPEC('radial', geo, { params: { radius: 20000 } }))
  assert.equal(acc(l2.props, 'getRadius', geo.features[0]), 20000)
  assert.equal(l.props.data.length, 2)
})

test('tripsProgress：相位能真正走到 1（头点到达终点）再回绕——回归「走不到终点就重来」bug', () => {
  // speed=0.1：10 秒一个完整周期，相位随 tripsTime 持续累加（tripsTime 在 MapView 里不取模）
  assert.equal(tripsProgress(0, 0.1), 0)
  assert.equal(tripsProgress(2.5, 0.1), 0.25)
  assert.equal(tripsProgress(5, 0.1), 0.5) // 中途：走到一半（旧 bug：相位被压死在 0.1）
  assert.ok(Math.abs(tripsProgress(9.9, 0.1) - 0.99) < 1e-9) // 接近终点
  assert.equal(tripsProgress(10, 0.1), 0) // 走满一圈后回绕
  // speed=1：1 秒一圈
  assert.equal(tripsProgress(1.5, 1), 0.5)
})

test('wallHeightFor / radialRadiusFor：缺 bbox 给兜底；有 bbox 按短边推算', () => {
  assert.ok(wallHeightFor(BBOX) >= 40 && wallHeightFor(BBOX) <= 500)
  assert.equal(wallHeightFor(null), 200)
  assert.ok(radialRadiusFor(BBOX) > 0)
  assert.equal(radialRadiusFor(null), 50000)
})
