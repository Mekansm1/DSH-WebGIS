/**
 * 隔离策略（src/geo-job-policy.ts）测试 —— 纯函数，毫秒级。
 *
 * 这里钉住两类容易悄悄错的东西：
 * ① **预算的同源性**：工具声明的 timeoutMs 与 worker 预算必须始终差 GEO_JOB_HEADROOM_MS。
 *    原先这两者是 14 处手写数字，改一处忘一处就会"报计算超过 28 秒但宿主批了更大预算"。
 * ② **门控判据必须是真实规模**：抽样层的 featureCount 只是上图子集，用它会恰好跳过隔离。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GEO_JOB_GATE, GEO_JOB_HEADROOM_MS, GEO_TOOL_TIMEOUTS,
  estimateScale, layerScale, shouldIsolate, workerBudget,
} from '../lib/geo-job-policy.js'
import { registerGeoTools } from '../lib/geo-tools.js'

const pt = (x, y) => ({ type: 'Point', coordinates: [x, y] })
const feat = (x, y) => ({ type: 'Feature', geometry: pt(x, y), properties: {} })
const fc = (n) => ({ type: 'FeatureCollection', features: Array.from({ length: n }, (_, i) => feat(i * 0.001, i * 0.001)) })

test('workerBudget：恒等于工具预算 − 余量（两者同源，不靠人记）', () => {
  assert.equal(GEO_JOB_HEADROOM_MS, 2000)
  for (const v of Object.values(GEO_TOOL_TIMEOUTS)) {
    assert.equal(workerBudget(v), v - GEO_JOB_HEADROOM_MS, `${v} 的 worker 预算应为 ${v - 2000}`)
  }
  assert.equal(workerBudget(GEO_TOOL_TIMEOUTS.op), 28_000)
  assert.equal(workerBudget(GEO_TOOL_TIMEOUTS.stat), 58_000)
  assert.equal(workerBudget(GEO_TOOL_TIMEOUTS.local), 118_000)
})

test('workerBudget：极小预算不会算出 0 或负数（timer 会立刻误触发）', () => {
  assert.ok(workerBudget(1000) >= 1)
  assert.ok(workerBudget(0) >= 1)
})

test('layerScale：抽样层必须取 totalCount，不能取 featureCount', () => {
  // 抽样层：图上 5 万，真实 60 万 —— 用 featureCount 会把大任务判成小的
  assert.equal(layerScale({ featureCount: 50_000, totalCount: 600_000 }), 600_000)
  // 物化层：两者相等
  assert.equal(layerScale({ featureCount: 1234 }), 1234)
  assert.equal(layerScale({ featureCount: 1234, totalCount: 1234 }), 1234)
})

test('estimateScale：各 job kind 的判据正确（双图层用 pairs）', () => {
  const layer = (n) => ({ geojson: fc(n) })
  assert.equal(estimateScale({ kind: 'buffer', layer: layer(10), distance: 1, unit: 'meters' }), 10)
  assert.equal(estimateScale({ kind: 'simplify', layer: layer(7), tolerance: 0.1, highQuality: false }), 7)
  assert.equal(estimateScale({ kind: 'dissolve', layer: layer(9), field: undefined }), 9)
  // 双图层：成本随两个输入一起涨 → 必须相乘
  assert.equal(estimateScale({ kind: 'union', a: layer(100), b: layer(50) }), 5000)
  assert.equal(estimateScale({ kind: 'spatialJoin', target: layer(30), join: layer(40), relation: 'intersects' }), 1200)
  // selectByLocation：给 overlay 才是配对，只给 bbox 是单图层
  assert.equal(estimateScale({ kind: 'selectByLocation', layer: layer(20), relation: 'within' }), 20)
  assert.equal(estimateScale({ kind: 'selectByLocation', layer: layer(20), relation: 'within', overlay: layer(5) }), 100)
  // 统计类走 geojson 字段
  assert.equal(estimateScale({ kind: 'moran', geojson: fc(11), field: 'x', options: {} }), 11)
  assert.equal(estimateScale({ kind: 'kernelDensity', geojson: fc(12), radius: 1, cell: 1 }), 12)
})

test('shouldIsolate：阈值边界（恰好等于就走隔离，不是"大于"）', () => {
  const job = { kind: 'union', a: { geojson: fc(1) }, b: { geojson: fc(1) } }
  const min = GEO_JOB_GATE.union.min
  assert.equal(shouldIsolate(job, min).isolate, true, '恰好等于阈值应隔离')
  assert.equal(shouldIsolate(job, min - 1).isolate, false, '低于阈值应主线程直算')
  assert.equal(shouldIsolate(job, min + 1).isolate, true)
})

test('阈值是实测标定的量级（回归守卫：别再把 buffer 设成 2 万、dissolve 设成 2 千）', () => {
  // 实测：buffer 1000 面 272ms（极贵）而 dissolve 20k 面只要 9.9ms（极便宜）。
  // 首版凭"线性/二次方"的印象分档，两个方向都错了 30~80 倍。
  // 这条只钉**量级关系**，不钉具体数字 —— 重新标定后数字可变，但关系不该反。
  assert.ok(GEO_JOB_GATE.buffer.min < GEO_JOB_GATE.dissolve.min,
    'buffer 比 dissolve 贵得多，阈值必须更低')
  assert.ok(GEO_JOB_GATE.buffer.min <= 5_000, `buffer 阈值 ${GEO_JOB_GATE.buffer.min} 明显偏高`)
  assert.ok(GEO_JOB_GATE.dissolve.min >= 20_000, `dissolve 阈值 ${GEO_JOB_GATE.dissolve.min} 明显偏低`)
  assert.ok(GEO_JOB_GATE.spatialJoin.min > GEO_JOB_GATE.union.min,
    'spatialJoin 有 bbox 预过滤，比 union 便宜，阈值应更高')
  assert.ok(GEO_JOB_GATE.localMoran.min < GEO_JOB_GATE.moran.min,
    'localMoran 比 moran 贵得多（实测同规模差 100×），阈值必须更低')
})

test('shouldIsolate：双图层按 pairs 判 —— 只看单层会漏判', () => {
  const job = { kind: 'union', a: { geojson: fc(1) }, b: { geojson: fc(1) } }
  const min = GEO_JOB_GATE.union.min
  // 两层各 1000 要素 = 1e6 pairs，越过阈值
  const twoLayers = 1000 * 1000
  assert.ok(twoLayers >= min, `前置：${twoLayers} pairs 应越线（阈值 ${min}）`)
  const d = shouldIsolate(job, twoLayers)
  assert.equal(d.isolate, true)
  assert.equal(d.rule.metric, 'pairs', 'union 的判据是 pairs（成本随两个输入一起涨）')
  // 而如果调用点只把单层规模报上来（1000），就会漏判 —— 这正是必须传 pairs 的原因
  assert.equal(shouldIsolate(job, 1000).isolate, false)
})

test('shouldIsolate：overrideMin 可覆盖阈值（测试用；生产不传）', () => {
  const job = { kind: 'buffer', layer: { geojson: fc(1) }, distance: 1, unit: 'meters' }
  assert.equal(shouldIsolate(job, 5).isolate, false, '默认 buffer 阈值 20000，5 不该隔离')
  assert.equal(shouldIsolate(job, 5, 5).isolate, true, '覆盖成 5 后应隔离')
  assert.equal(shouldIsolate(job, 5, 5).rule.min, GEO_JOB_GATE.buffer.min, 'rule 仍反映该 kind 的真实规则')
})

test('shouldIsolate：决策带可读理由（排障时能回答"为什么走了这条路"）', () => {
  const job = { kind: 'moran', geojson: fc(1), field: 'x', options: {} }
  const yes = shouldIsolate(job, 999_999)
  const no = shouldIsolate(job, 1)
  assert.match(yes.reason, /隔离执行/)
  assert.match(no.reason, /主线程直算/)
  assert.equal(yes.scale, 999_999)
})

test('GEO_JOB_GATE：覆盖全部 16 个 job kind，且阈值都是正数', () => {
  const kinds = [
    'buffer', 'dissolve', 'simplify', 'clip', 'intersect', 'difference', 'union',
    'spatialJoin', 'selectByLocation', 'voronoi', 'regularGrid',
    'kernelDensity', 'ann', 'moran', 'localMoran', 'getisOrd',
  ]
  assert.equal(Object.keys(GEO_JOB_GATE).length, kinds.length, '门控表必须与 job kind 一一对应')
  for (const k of kinds) {
    const rule = GEO_JOB_GATE[k]
    assert.ok(rule, `${k} 缺少门控规则`)
    assert.ok(Number.isFinite(rule.min) && rule.min > 0, `${k} 的阈值应为正数`)
    assert.ok(['features', 'pairs', 'cells'].includes(rule.metric), `${k} 的判据不合法`)
  }
  assert.equal(GEO_JOB_GATE.regularGrid.metric, 'cells', '规则格网的判据是格数，不是要素数')
})

test('规则格网：格数与 turf 的生成公式一致（复用它自己的 convertLength，不可能分叉）', () => {
  // 1° × 1° 的框、格边 0.1° → 10×10 = 100 格
  const cells = estimateScale({ kind: 'regularGrid', bbox: [0, 0, 1, 1], cellSize: 0.1, unit: 'degrees' })
  assert.equal(cells, 100)
  // 单位换算走 turf：0.1 公里 ≪ 0.1 度，所以格数暴增
  const km = estimateScale({ kind: 'regularGrid', bbox: [0, 0, 1, 1], cellSize: 0.1, unit: 'kilometers' })
  assert.ok(km > cells * 100, `公里单位下格子应远多于度数单位（实际 ${km} vs ${cells}）`)
})

test('规则格网：格数门控用格数判，不是用图层要素数', () => {
  const d = shouldIsolate({ kind: 'regularGrid', bbox: [0, 0, 1, 1], cellSize: 1, unit: 'degrees' })
  assert.equal(d.rule.metric, 'cells')
  assert.equal(d.scale, 1, '1° 框 / 1° 格 = 1 格')
  assert.equal(d.isolate, false)
})

test('注册表：14 个走隔离的工具，timeoutMs 必须取自 GEO_TOOL_TIMEOUTS', () => {
  // 这条是「预算同源」的守护测试：有人手写回一个数字，这里就红。
  const defs = []
  registerGeoTools({ tools: { register: (d) => defs.push(d) } }, () => ({ layers: [] }))
  const isolated = [
    'webgis_buffer', 'webgis_dissolve', 'webgis_simplify',
    'webgis_clip', 'webgis_intersect', 'webgis_difference', 'webgis_union',
    'webgis_spatial_join', 'webgis_select_by_location',
    'webgis_kernel_density', 'webgis_average_nearest_neighbor', 'webgis_moran_i',
    'webgis_local_moran', 'webgis_getis_ord',
  ]
  const allowed = new Set(Object.values(GEO_TOOL_TIMEOUTS))
  for (const name of isolated) {
    const d = defs.find((x) => x.name === name)
    assert.ok(d, `未找到工具 ${name}`)
    assert.ok(
      allowed.has(d.timeoutMs),
      `${name} 的 timeoutMs=${d.timeoutMs} 不在 GEO_TOOL_TIMEOUTS 值域内 —— 预算与 worker 字面量脱节`,
    )
  }
})
