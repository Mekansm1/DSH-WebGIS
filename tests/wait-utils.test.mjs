import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitExportCompletion } from '../lib/wait-utils.js'

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
