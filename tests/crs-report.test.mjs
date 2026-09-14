import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crsRangeWarning, crsReport, looksProjected } from '../lib/duckdb/geometry.js'

// 背景：crs === null 有三种完全不同的成因（已声明 4326 / 未声明 SRID=0 / ST_SRID 探不出来），
// 后两种只是"假设按 WGS84 解释"。猜错时距离/面积/缓冲会全错而**结果看上去完全正常** ——
// 这是本插件最危险的一类静默失败。下面这些用例锁住"必须如实说、且必须能自检出来"。

// ---- 范围自检 ----

test('looksProjected: 正常经纬度 → 不告警', () => {
  assert.equal(looksProjected([116.3, 39.9, 116.5, 40.1]), false)   // 北京
  assert.equal(looksProjected([-180, -90, 180, 90]), false)          // 合法极值
  assert.equal(looksProjected([0, 0, 0, 0]), false)
})

test('looksProjected: 投影坐标 → 命中（这是把静默错误变响的关键抓手）', () => {
  // Web Mercator（米）
  assert.equal(looksProjected([12940000, 4800000, 12960000, 4820000]), true)
  // UTM 50N（米）
  assert.equal(looksProjected([500000, 4000000, 510000, 4010000]), true)
  // 只有一维越界也算
  assert.equal(looksProjected([116.3, 4000000, 116.5, 4001000]), true)
  assert.equal(looksProjected([-200, 39.9, 116.5, 40.1]), true)
})

test('looksProjected: 空/坏输入不误报', () => {
  assert.equal(looksProjected(null), false)
  assert.equal(looksProjected(undefined), false)
  assert.equal(looksProjected([]), false)
  assert.equal(looksProjected([NaN, 0, 1, 1]), false)
  assert.equal(looksProjected([0, 0, Infinity, 1]), false)
})

// ---- 检出结论 → 给模型的话 ----

const info = (status, crs = null, srids = []) => ({ crs, srids, status })

test('crsReport: 四种 status 都有话说，且措辞互不相同（沉默正是问题所在）', () => {
  const declared4326 = crsReport(info('declared'))
  const declared3857 = crsReport(info('declared', 'EPSG:3857'))
  const assumedUndef = crsReport(info('assumed-undefined'))
  const assumedProbe = crsReport(info('assumed-probe-failed'))
  const mixed = crsReport(info('mixed', null, [4326, 3857]))

  for (const s of [declared4326, declared3857, assumedUndef, assumedProbe, mixed]) {
    assert.ok(s && s.length > 0, '不能返回空串——不说就等于把假设当事实')
  }
  const all = [declared4326, declared3857, assumedUndef, assumedProbe, mixed]
  assert.equal(new Set(all).size, all.length, '五种情况必须能区分')

  // 已声明 = 事实，不该带警告
  assert.doesNotMatch(declared4326, /⚠/)
  assert.doesNotMatch(declared3857, /⚠/)
  // 假设 = 必须警告，且说清后果
  assert.match(assumedUndef, /未声明/)
  assert.match(assumedUndef, /假设/)
  assert.match(assumedUndef, /sourceCrs/)
  assert.match(assumedProbe, /探测/)
  assert.match(assumedProbe, /假设/)
  assert.match(mixed, /4326, 3857/)
})

test('crsReport: 声明了非 4326 要说明已转换', () => {
  assert.match(crsReport(info('declared', 'EPSG:3857')), /EPSG:3857/)
  assert.match(crsReport(info('declared', 'EPSG:3857')), /4326/)
})

// ---- 越界告警 ----

test('crsRangeWarning: bbox 正常 → 空串（不打扰）', () => {
  assert.equal(crsRangeWarning([116.3, 39.9, 116.5, 40.1], 'assumed-undefined'), '')
  assert.equal(crsRangeWarning([116.3, 39.9, 116.5, 40.1], 'declared'), '')
  assert.equal(crsRangeWarning(null, 'assumed-undefined'), '')
})

test('crsRangeWarning: 越界 + 假设状态 → 必须点破"假设为假"，并给出出路', () => {
  const w = crsRangeWarning([500000, 4000000, 510000, 4010000], 'assumed-undefined')
  assert.match(w, /🚨/)
  assert.match(w, /超出经纬度取值范围/)
  assert.match(w, /500000/)
  assert.match(w, /相互印证为假/, '越界本身就是"按 WGS84 解释"这个假设被证伪的证据')
  assert.match(w, /不可信/, '要明确告诉用户结果不可信，而不是含糊提示')
  assert.match(w, /sourceCrs/, '要给可执行的出路')
  assert.match(w, /EPSG:/)
})

test('crsRangeWarning: 越界但 CRS 是明确声明的 → 措辞更保守（不说假设为假）', () => {
  const w = crsRangeWarning([500000, 4000000, 510000, 4010000], 'declared')
  assert.match(w, /🚨/)
  assert.doesNotMatch(w, /相互印证为假/)
  assert.match(w, /检查/)
})

test('crsRangeWarning: 探测失败也算假设（不能因为探测不到就当没事）', () => {
  const w = crsRangeWarning([500000, 4000000, 510000, 4010000], 'assumed-probe-failed')
  assert.match(w, /相互印证为假/)
})
