// 视口裁剪纯函数单测（src/client/deck/viewport.ts 编译到 lib/client/deck/viewport.js，可被 node 直接 import）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  paddedBbox,
  bboxArea,
  areaRatio,
  bboxContains,
  bboxStr,
  fromBboxStr,
  shouldViewportCull,
  CULL_RATIO,
  CULL_MIN_ZOOM,
  FETCH_PAD,
  COVER_MARGIN_DEG,
} from '../lib/client/deck/viewport.js'

test('viewport 常量：CULL_RATIO / CULL_MIN_ZOOM / FETCH_PAD / COVER_MARGIN_DEG', () => {
  assert.equal(CULL_RATIO, 0.55)
  assert.equal(CULL_MIN_ZOOM, 15)
  assert.equal(FETCH_PAD, 0.25)
  assert.equal(COVER_MARGIN_DEG, 0.0005)
})

test('paddedBbox：每边按自身宽/高 25% 外扩', () => {
  const bb = { west: 100, south: 20, east: 120, north: 40 }
  const p = paddedBbox(bb, 0.25)
  // 宽=20 → dx=5；高=20 → dy=5
  assert.deepEqual(p, { west: 95, south: 15, east: 125, north: 45 })
  // 纯函数：不修改入参
  assert.deepEqual(bb, { west: 100, south: 20, east: 120, north: 40 })
  assert.notEqual(p, bb)
})

test('paddedBbox：经纬度钳制 ±180 / ±90', () => {
  const p = paddedBbox({ west: 170, south: 89, east: 180, north: 90 }, 0.25)
  // 宽=10 → dx=2.5；高=1 → dy=0.25
  assert.equal(p.west, 167.5)
  assert.equal(p.south, 88.75)
  assert.equal(p.east, 180) // 182.5 被钳到 180
  assert.equal(p.north, 90) // 90.25 被钳到 90
  // 负方向钳制
  const q = paddedBbox({ west: -180, south: -90, east: -170, north: -89 }, 0.25)
  assert.equal(q.west, -180) // -182.5 被钳到 -180
  assert.equal(q.south, -90) // -90.25 被钳到 -90
  assert.equal(q.east, -167.5)
  assert.equal(q.north, -88.75)
})

test('paddedBbox：退化区间（宽或高 ≤ 0）原样返回副本', () => {
  const point = { west: 100, south: 20, east: 100, north: 20 }
  const p1 = paddedBbox(point, 0.25)
  assert.deepEqual(p1, point)
  assert.notEqual(p1, point)
  // 纬向退化（一条水平线）
  const latLine = { west: 100, south: 20, east: 110, north: 20 }
  assert.deepEqual(paddedBbox(latLine, 0.25), latLine)
  // 反向区间（west>east）也视为退化原样返回，不外扩成怪值
  const inverted = { west: 120, south: 20, east: 100, north: 40 }
  assert.deepEqual(paddedBbox(inverted, 0.25), inverted)
})

test('bboxArea：近似球面面积公式，宽/高取正；退化与非有限 → 0', () => {
  const bb = { west: 100, south: 20, east: 120, north: 40 }
  const expected = (bb.east - bb.west) * Math.cos(((bb.north + bb.south) / 2) * (Math.PI / 180)) * (bb.north - bb.south)
  assert.ok(Math.abs(bboxArea(bb) - expected) < 1e-9)
  assert.ok(bboxArea(bb) > 0)
  // 中纬越接近两极 → cos 越小（面积越小的直觉）
  const polar = { west: 100, south: 80, east: 120, north: 85 }
  assert.ok(bboxArea(polar) < bboxArea(bb))
  // 反向区间（west>east）也取正
  assert.ok(bboxArea({ west: 120, south: 20, east: 100, north: 40 }) > 0)
  // 退化/非有限 → 0（供 areaRatio 返回 Infinity）
  assert.equal(bboxArea({ west: 100, south: 20, east: 100, north: 40 }), 0)
  assert.equal(bboxArea({ west: Number.NaN, south: 0, east: 10, north: 10 }), 0)
})

test('areaRatio：view/layer；层面积 0 → Infinity', () => {
  const layer = { west: 100, south: 20, east: 120, north: 40 }
  const viewSmall = { west: 110, south: 30, east: 112, north: 32 }
  const r = areaRatio(viewSmall, layer)
  assert.ok(r > 0 && r < CULL_RATIO, `小视野/大层 比值应 < 0.55，实际 ${r}`)
  assert.equal(areaRatio(layer, layer), 1)
  // 层面积 0（退化点）→ Infinity
  assert.equal(areaRatio(layer, { west: 0, south: 0, east: 0, north: 0 }), Infinity)
  // 层非有限 → Infinity
  assert.equal(areaRatio(layer, { west: Number.NaN, south: 0, east: 10, north: 10 }), Infinity)
})

test('bboxContains：内含 / 边贴边 / 越界 / margin 容差', () => {
  const outer = { west: 0, south: 0, east: 10, north: 10 }
  assert.equal(bboxContains(outer, { west: 1, south: 1, east: 9, north: 9 }), true)
  // 完全重合（边贴边含）
  assert.equal(bboxContains(outer, { ...outer }), true)
  // 四边任一越界 → false
  assert.equal(bboxContains(outer, { west: -1, south: 1, east: 9, north: 9 }), false)
  assert.equal(bboxContains(outer, { west: 1, south: 1, east: 11, north: 9 }), false)
  assert.equal(bboxContains(outer, { west: 1, south: -1, east: 9, north: 9 }), false)
  assert.equal(bboxContains(outer, { west: 1, south: 1, east: 9, north: 11 }), false)
  // marginDeg 容差：越界在容差内放行，超出拒绝
  assert.equal(bboxContains(outer, { west: -0.0004, south: 1, east: 9, north: 9 }, 0.0005), true)
  assert.equal(bboxContains(outer, { west: -0.0005, south: 1, east: 9, north: 9 }, 0.0005), true)
  assert.equal(bboxContains(outer, { west: -0.001, south: 1, east: 9, north: 9 }, 0.0005), false)
  // 无 margin 时 0.0001 越界即 false
  assert.equal(bboxContains(outer, { west: -0.0001, south: 1, east: 9, north: 9 }), false)
})

test('bboxStr / fromBboxStr：往返与 3 位小数舍入', () => {
  const bb = { west: 116.3912345, south: 39.90777, east: 116.51234, north: 40.001234 }
  assert.equal(bboxStr(bb), '116.391,39.908,116.512,40.001')
  const parsed = fromBboxStr(bboxStr(bb))
  assert.deepEqual(parsed, { west: 116.391, south: 39.908, east: 116.512, north: 40.001 })
  // 整数去尾零
  assert.equal(bboxStr({ west: 0, south: 0, east: 10, north: 10 }), '0,0,10,10')
  assert.deepEqual(fromBboxStr('0,0,10,10'), { west: 0, south: 0, east: 10, north: 10 })
  // 容忍空白
  assert.deepEqual(fromBboxStr(' 1, 2 ,3,4 '), { west: 1, south: 2, east: 3, north: 4 })
})

test('fromBboxStr：非法输入抛 Error', () => {
  assert.throws(() => fromBboxStr('1,2,3'))
  assert.throws(() => fromBboxStr('1,a,3,4'))
  assert.throws(() => fromBboxStr('1,,3,4'))
  assert.throws(() => fromBboxStr('1,2,3,4,5'))
  assert.throws(() => fromBboxStr(''))
})

test('shouldViewportCull：有层 bbox 看面积比；无层 bbox 看 zoom', () => {
  const layer = { west: 100, south: 20, east: 120, north: 40 }
  const viewSmall = { west: 110, south: 30, east: 112, north: 32 }
  // 视野面积 < 层 55% → 值得裁剪（与 zoom 无关）
  assert.equal(shouldViewportCull(viewSmall, layer, 3), true)
  assert.equal(shouldViewportCull(viewSmall, layer, 20), true)
  // 视野 ≈ 层 → 不裁剪（整层大致在屏内，走旧全档位）
  assert.equal(shouldViewportCull(layer, layer, 8), false)
  // 层 bbox 退化（面积 0）→ 保守 false
  assert.equal(shouldViewportCull(viewSmall, { west: 0, south: 0, east: 0, north: 0 }, 16), false)
  // 无层 bbox（极少数）：zoom ≥ CULL_MIN_ZOOM 才裁剪
  assert.equal(shouldViewportCull(layer, null, 14), false)
  assert.equal(shouldViewportCull(layer, null, 15), true)
  assert.equal(shouldViewportCull(layer, null, 16), true)
})
