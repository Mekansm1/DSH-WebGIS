import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEL_SRC, isSelectionLayerId } from '../lib/client/map-highlight.js'

// 回归：点击高亮层被主动置顶（否则会被数据层盖住），而 queryRenderedFeatures 返回的第一条
// 就是最上层 —— 于是上一次点击的高亮图形会抢走 topPayload。它的 properties 是空的几何壳，
// 结果就是「同一个要素点第二次，提示该要素无属性字段」。
// 所有拾取入口都必须用它过滤掉高亮层。
test('isSelectionLayerId: 识别全部高亮层（四层 + 裸源名）', () => {
  assert.equal(isSelectionLayerId('gis-sel-fill'), true)
  assert.equal(isSelectionLayerId('gis-sel-halo'), true)
  assert.equal(isSelectionLayerId('gis-sel-line'), true)
  assert.equal(isSelectionLayerId('gis-sel-dot'), true)
  // deck 侧的选中层用裸 id
  assert.equal(isSelectionLayerId(SEL_SRC), true)
})

test('isSelectionLayerId: 不误伤数据层（含名字里带 sel 的）', () => {
  for (const id of ['data-polygon', 'gis-result-1', 'data-points', 'cluster-1', 'data', 'sel', 'gis-selection']) {
    assert.equal(isSelectionLayerId(id), false, `${id} 不该被当成高亮层`)
  }
  assert.equal(isSelectionLayerId(undefined), false)
  assert.equal(isSelectionLayerId(''), false)
})
