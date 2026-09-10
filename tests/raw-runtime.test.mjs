// raw arrow 单层运行时 + 纯决策函数单测（src/client/deck/raw-runtime.ts → lib/client/deck/raw-runtime.js）。
// 这些用例正是 P0-2 之前无法覆盖的「首拉失败仍要重试 / 删除后不再重试 / 清理不残留」逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RawLayerRuntime,
  decideRawSync,
  autoRetryEligible,
  windowFromBbox,
  RAW_RETRY_MIN_INTERVAL_MS,
} from '../lib/client/deck/raw-runtime.js'

const layer = (over = {}) => ({
  id: 'L1', name: 'L', featureCount: 10, bbox: [0, 0, 1, 1], visible: true, color: '#000',
  rev: 0, source: 'dataset', geometryTypes: ['Point'], cluster: false, mode: 'points',
  renderer: 'deck', dataFormat: 'arrow', totalCount: 200000, ...over,
})

test('RawLayerRuntime：初始态干净，hasRuntime 反映在途/待合并/定时器/冷却', () => {
  const rt = new RawLayerRuntime('x')
  assert.equal(rt.id, 'x')
  assert.equal(rt.spec, null)
  assert.equal(rt.table, null)
  assert.equal(rt.managed, false)
  assert.equal(rt.hasRuntime(), false)
  rt.fetching = '3|'
  assert.equal(rt.hasRuntime(), true)
  rt.fetching = null
  rt.pending = '4|'
  assert.equal(rt.hasRuntime(), true)
  rt.pending = null
  rt.retryTimer = 1
  assert.equal(rt.hasRuntime(), true)
  rt.retryTimer = null
  rt.lastAutoRetryAt = 123
  assert.equal(rt.hasRuntime(), true)
})

test('decideRawSync：无视野 → 旧全档位（bbox=null）；同键/在途跳过', () => {
  const rt = new RawLayerRuntime('L1')
  const s = layer()
  // 无 view：走全档位
  assert.deepEqual(decideRawSync(rt, s, 50000, 5, null, false, false), { kind: 'fetch', bbox: null })
  // 同键已在（lastViewKey / fetching）→ 跳过
  rt.lastViewKey = '50000|'
  assert.deepEqual(decideRawSync(rt, s, 50000, 5, null, false, false), { kind: 'skip' })
  rt.lastViewKey = null
  rt.fetching = '50000|'
  assert.deepEqual(decideRawSync(rt, s, 50000, 5, null, false, false), { kind: 'skip' })
  // force 忽略去重
  assert.deepEqual(decideRawSync(rt, s, 50000, 5, null, false, true), { kind: 'fetch', bbox: null })
})

test('decideRawSync：无视野且命中预取档 → consume；force 时不吃预取', () => {
  const rt = new RawLayerRuntime('L1')
  const s = layer()
  rt.prefetch[100000] = { fake: true }
  assert.deepEqual(decideRawSync(rt, s, 100000, 8, null, true, false), { kind: 'consume' })
  assert.deepEqual(decideRawSync(rt, s, 100000, 8, null, false, false), { kind: 'fetch', bbox: null })
  assert.deepEqual(decideRawSync(rt, s, 100000, 8, null, true, true), { kind: 'fetch', bbox: null })
})

test('decideRawSync：视野远小于图层 → 视口裁剪，取数窗口为视野外扩 25%', () => {
  const rt = new RawLayerRuntime('L1')
  // 层 bbox 很大（10x10 度），视野很小（0.2x0.2 度）→ 面积比远 < 0.55 → 裁剪
  const s = layer({ bbox: [0, 0, 10, 10] })
  const view = { west: 5, south: 5, east: 5.2, north: 5.2 }
  const d = decideRawSync(rt, s, 200000, 12, view, false, false)
  assert.equal(d.kind, 'fetch')
  assert.notEqual(d.bbox, null)
  // 外扩 25%：宽 0.2 → 每边 0.05
  assert.equal(d.bbox, '4.95,4.95,5.25,5.25')
})

test('decideRawSync：视野仍在已拉窗口内 → 覆盖跳过（零请求）', () => {
  const rt = new RawLayerRuntime('L1')
  const s = layer({ bbox: [0, 0, 10, 10] })
  const view = { west: 5, south: 5, east: 5.2, north: 5.2 }
  // 上次成功窗口包含当前视野
  rt.window = windowFromBbox('4.95,4.95,5.25,5.25', 200000)
  assert.equal(rt.window.bb.west, 4.95)
  assert.deepEqual(decideRawSync(rt, s, 200000, 12, view, false, false), { kind: 'skip' })
  // 跨档位 → 不跳过
  assert.equal(decideRawSync(rt, s, 400000, 13, view, false, false).kind, 'fetch')
  // force（数据变更/首拉）→ 不跳过
  assert.equal(decideRawSync(rt, s, 200000, 12, view, false, true).kind, 'fetch')
})

test('decideRawSync：视野大到不需裁剪 → 回旧全档位并清 window', () => {
  const rt = new RawLayerRuntime('L1')
  const s = layer({ bbox: [0, 0, 1, 1] })
  rt.window = windowFromBbox('0,0,1,1', 50000)
  const view = { west: 0, south: 0, east: 1, north: 1 } // 视野≈层 → 面积比≈1 → 不裁剪
  const d = decideRawSync(rt, s, 50000, 5, view, false, false)
  assert.deepEqual(d, { kind: 'fetch', bbox: null })
  assert.equal(rt.window, null, '回全档位要清掉窗口，避免后续覆盖跳过误判')
})

test('autoRetryEligible：首拉失败（spec 仍为空）也应允许排重试 [P0-2 回归]', () => {
  const rt = new RawLayerRuntime('L1')
  rt.managed = true
  assert.equal(rt.spec, null, '前提：尚无任何成功数据')
  assert.equal(autoRetryEligible(rt, 0), true, '首次 Arrow 拉取失败后必须能排重试')
})

test('autoRetryEligible：在途 / 待尾随合并 / 已有定时器 / 冷却中 都不得排重试', () => {
  const base = () => { const rt = new RawLayerRuntime('L1'); rt.managed = true; return rt }
  const a = base(); a.fetching = '3|'
  assert.equal(autoRetryEligible(a, 0), false, '已有在途')
  const b = base(); b.pending = '4|'
  assert.equal(autoRetryEligible(b, 0), false, '已有待尾随合并')
  const c = base(); c.retryTimer = 1
  assert.equal(autoRetryEligible(c, 0), false, '已有未触发定时器（防重复 timer）')
  const d = base(); d.lastAutoRetryAt = 1000
  assert.equal(autoRetryEligible(d, 1000 + RAW_RETRY_MIN_INTERVAL_MS - 1), false, '冷却中')
  assert.equal(autoRetryEligible(d, 1000 + RAW_RETRY_MIN_INTERVAL_MS), true, '冷却结束后可再试')
})

test('autoRetryEligible：非管理态（图层被删/切形态）不得重试 [P0-2 回归]', () => {
  const rt = new RawLayerRuntime('L1')
  rt.managed = false
  assert.equal(autoRetryEligible(rt, 0), false, 'removeOut/clearRaw 后不再重试')
  // 模拟 dispose/removeOut：清掉定时器后无残留
  rt.managed = true
  rt.retryTimer = 0 // 假定时器句柄
  assert.equal(rt.clearRetryTimer(), true)
  assert.equal(rt.retryTimer, null)
  assert.equal(rt.clearRetryTimer(), false, '重复清理放行')
})

test('windowFromBbox：解析出取数窗口与 tier', () => {
  const w = windowFromBbox('116.391,39.908,116.512,40.001', 200000)
  assert.equal(w.tier, 200000)
  assert.deepEqual(w.bb, { west: 116.391, south: 39.908, east: 116.512, north: 40.001 })
})
