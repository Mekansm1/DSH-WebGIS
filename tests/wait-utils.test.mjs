import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitBasemapExtraction, awaitExportCompletion } from '../lib/wait-utils.js'

/** 最小 WebgisState 桩（只喂等待器用到的字段）。 */
function stateStub(over = {}) {
  return { exportRequest: null, exportImage: null, exportError: null, ...over }
}

const IMG = { id: 7, ref: { attachmentId: 'a1' }, width: 100, height: 80, title: '出图' }

test('awaitExportCompletion: 收到同 seq 的出图 → ok，并清掉 request', async () => {
  const st = stateStub({ exportRequest: { seq: 7, params: {} }, exportImage: IMG })
  const r = await awaitExportCompletion(st, 7, 500)
  assert.equal(r.ok, true)
  assert.equal(r.image.id, 7)
  assert.equal(st.exportRequest, null)
})

test('awaitExportCompletion: seq 不匹配的出图不算这次的结果（继续等别的）', async () => {
  const st = stateStub({ exportRequest: { seq: 7, params: {} }, exportImage: { ...IMG, id: 6 } })
  const r = await awaitExportCompletion(st, 7, 300)
  assert.equal(r.ok, false)
  assert.match(r.message, /超时/)
})

// 回归：用户点了「导出 PNG」（下载）并关闭弹窗时，host 原先只能干等到超时，
// 表现为工具卡住、模型还劝用户再点一次按钮。
test('awaitExportCompletion: 用户取消（exportError）→ 立即返回失败原因，不干等超时', async () => {
  const st = stateStub({ exportRequest: { seq: 7, params: {} }, exportError: '用户关闭了出图弹窗，本次出图已取消' })
  const started = Date.now()
  const r = await awaitExportCompletion(st, 7, 30_000)
  const elapsed = Date.now() - started
  assert.equal(r.ok, false)
  assert.match(r.message, /取消/)
  assert.ok(elapsed < 2000, `应立刻返回，实际耗时 ${elapsed}ms`)
  assert.equal(st.exportError, null)
  assert.equal(st.exportRequest, null)
})

test('awaitExportCompletion: 超时文案明确不要再重试', async () => {
  const st = stateStub({ exportRequest: { seq: 7, params: {} } })
  const r = await awaitExportCompletion(st, 7, 300)
  assert.equal(r.ok, false)
  assert.match(r.message, /超时/)
  assert.match(r.message, /不要反复重试/)
  assert.equal(st.exportRequest, null)
})

// ---- 底图要素提取等待器（与出图同构：结果 / 失败 / 超时 三个出口） ----

test('awaitBasemapExtraction: 收到同 seq 的结果 → ok，并清掉请求', async () => {
  const st = stateStub({
    basemapRequest: { seq: 3, params: { sourceLayer: 'waterway' } },
    basemapResult: { id: 3, geojson: { type: 'FeatureCollection', features: [] }, featureCount: 12, names: ['白浪河'] },
  })
  const r = await awaitBasemapExtraction(st, 3, 500)
  assert.equal(r.ok, true)
  assert.equal(r.result.featureCount, 12)
  assert.equal(st.basemapRequest, null)
})

// 关键：栅格底图 / 视野内无该图层时，客户端要主动上报失败，让工具立刻拿到原因，
// 而不是干等到超时（用户看到的会是"卡住"）。
test('awaitBasemapExtraction: 客户端上报失败 → 立刻返回原因，不干等超时', async () => {
  const st = stateStub({
    basemapRequest: { seq: 3, params: { sourceLayer: 'waterway' } },
    basemapError: '当前底图是光栅瓦片，没有可提取的矢量数据。',
  })
  const started = Date.now()
  const r = await awaitBasemapExtraction(st, 3, 30_000)
  assert.equal(r.ok, false)
  assert.match(r.message, /光栅瓦片/)
  assert.ok(Date.now() - started < 2000, '应立刻返回')
  assert.equal(st.basemapError, null)
  assert.equal(st.basemapRequest, null)
})

test('awaitBasemapExtraction: seq 不匹配不算本次结果；超时文案给出可行动提示', async () => {
  const other = stateStub({
    basemapRequest: { seq: 3, params: { sourceLayer: 'waterway' } },
    basemapResult: { id: 2, geojson: { type: 'FeatureCollection', features: [] }, featureCount: 1 },
  })
  assert.equal((await awaitBasemapExtraction(other, 3, 300)).ok, false)

  const st = stateStub({ basemapRequest: { seq: 3, params: { sourceLayer: 'waterway' } } })
  const r = await awaitBasemapExtraction(st, 3, 300)
  assert.equal(r.ok, false)
  assert.match(r.message, /矢量底图/)
  assert.equal(st.basemapRequest, null)
})
