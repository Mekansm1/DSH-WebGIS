// 图层叠放顺序纯函数：数组从下到上（末尾 = 地图最上层）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveLayerTo, moveLayerBy } from '../lib/layer-order.js'

const L = (...ids) => ids.map((id) => ({ id }))
const ids = (layers) => layers.map((l) => l.id)

test('moveLayerTo：移动并钳制下标', () => {
  assert.deepEqual(ids(moveLayerTo(L('a', 'b', 'c', 'd'), 'a', 3)), ['b', 'c', 'd', 'a'])
  assert.deepEqual(ids(moveLayerTo(L('a', 'b', 'c', 'd'), 'd', 0)), ['d', 'a', 'b', 'c'])
  assert.deepEqual(ids(moveLayerTo(L('a', 'b', 'c'), 'b', 99)), ['a', 'c', 'b'])
  assert.deepEqual(ids(moveLayerTo(L('a', 'b', 'c'), 'b', -5)), ['b', 'a', 'c'])
})

test('moveLayerTo：找不到 id / 非法下标时原样返回', () => {
  const src = L('a', 'b')
  assert.equal(moveLayerTo(src, 'nope', 1), src)
  assert.equal(moveLayerTo(src, 'a', Number.NaN), src)
})

test('moveLayerBy：up/down/top/bottom 方向语义（末尾 = 最上层）', () => {
  const src = L('a', 'b', 'c')
  assert.deepEqual(ids(moveLayerBy(src, 'b', 'up')), ['a', 'c', 'b'])
  assert.deepEqual(ids(moveLayerBy(src, 'b', 'down')), ['b', 'a', 'c'])
  assert.deepEqual(ids(moveLayerBy(src, 'a', 'top')), ['b', 'c', 'a'])
  assert.deepEqual(ids(moveLayerBy(src, 'c', 'bottom')), ['c', 'a', 'b'])
  // 边界：已在顶部再 up / 已在底部再 down 不变
  assert.deepEqual(ids(moveLayerBy(src, 'c', 'up')), ['a', 'b', 'c'])
  assert.deepEqual(ids(moveLayerBy(src, 'a', 'down')), ['a', 'b', 'c'])
})
