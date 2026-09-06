import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionStateStore, emptyWebgisState } from '../lib/session-state.js'

test('SessionStateStore: 不同会话独立副本，互不串扰', () => {
  const store = new SessionStateStore()
  const a = store.get('sessA')
  const b = store.get('sessB')
  assert.notEqual(a, b)
  a.dataset = { name: 'x', geojson: {}, featureCount: 0 }
  a.layers.push({ id: 'import_1', name: 'x' })
  assert.equal(b.dataset, null)
  assert.equal(b.layers.length, 0)
})

test('SessionStateStore: 同会话多次 get 返回同一实例；空/缺失会话落 anon 桶', () => {
  const store = new SessionStateStore()
  assert.equal(store.get('s'), store.get('s'))
  assert.equal(store.get(undefined), store.get(''))
  assert.equal(store.get(' '), store.get(undefined))
})

test('SessionStateStore: dispose 回收真实会话，anon 桶不回收', () => {
  const store = new SessionStateStore()
  store.get('sessA')
  store.get(undefined)
  assert.equal(store.size, 2)
  store.dispose('sessA')
  assert.equal(store.size, 1)
  assert.equal(store.has('sessA'), false)
  assert.equal(store.has(undefined), true)
})

test('SessionStateStore: seed 每次新建会话调用一次并返回新副本', () => {
  let calls = 0
  const store = new SessionStateStore(() => {
    calls += 1
    const st = emptyWebgisState()
    st.dataset = { name: 'default', geojson: {}, featureCount: 1 }
    return st
  })
  const a = store.get('a')
  const b = store.get('b')
  assert.equal(calls, 2)
  assert.equal(a.dataset?.name, 'default')
  assert.notEqual(a, b)
})
