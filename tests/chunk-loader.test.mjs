import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerChunk, isChunkLoaded, asyncRegistry } from '../lib/client/chunk-loader.js'

test('registerChunk / isChunkLoaded / asyncRegistry 共享 window 级单例', () => {
  // 隔离：记录/清理 globalThis.__dshWebgisAsync（chunk-loader 的窗口级单例键）。
  const g = globalThis
  const before = g.__dshWebgisAsync
  delete g.__dshWebgisAsync
  try {
    assert.equal(isChunkLoaded('none'), false, '未注册应为 false')
    registerChunk('a', { x: 1 })
    assert.equal(isChunkLoaded('a'), true, '注册后应可见')
    assert.equal(asyncRegistry()._m['a']?.x, 1, 'registerChunk 写入同一注册表')
    // 幂等：同名覆盖（ensure 判重依赖的是 _m 已存在即秒回）。
    registerChunk('a', { x: 2 })
    assert.equal(asyncRegistry()._m['a']?.x, 2, '同名覆盖')
  } finally {
    if (before === undefined) delete g.__dshWebgisAsync
    else g.__dshWebgisAsync = before
  }
})
