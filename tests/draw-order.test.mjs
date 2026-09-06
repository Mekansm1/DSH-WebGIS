// 回归测试：DrawToolbar 的 terradraw 顺序 bug。
//
// 背景：DrawToolbar.activate() 曾把 draw.addFeatures(existing) 放在 draw.start() 之前——
// terra-draw 的 addFeatures 内部调用 checkEnabled()，未 start 时直接抛 "Terra Draw is not enabled"。
// 于是只要绘图画布上已有要素（点/线/面），再点另一个模式按钮（切换）就静默失败、毫无反应。
//
// 本测试用真实 terra-draw + 真实 maplibre adapter + mock 地图，复现该顺序问题：
//   - 先验证「旧顺序」确实抛错（证明 bug 存在）
//   - 再验证「修复后顺序」（start 在前）正常工作（回归护栏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerraDraw, TerraDrawPointMode, TerraDrawLineStringMode, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'

globalThis.requestAnimationFrame = (cb) => { cb(0); return 1 }
globalThis.cancelAnimationFrame = () => {}

function makeElement() {
  const handlers = {}
  return {
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    addEventListener(t, cb) { handlers[t] = cb },
    removeEventListener(t, cb) { if (handlers[t] === cb) delete handlers[t] },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } },
    fire(t, ev) { handlers[t] && handlers[t](ev) },
    getContext: () => null,
  }
}

function makeSource(spec) {
  const src = {
    type: spec.type,
    tiles: spec.tiles,
    _data: spec.data ?? { type: 'FeatureCollection', features: [] },
    setData(d) { src._data = d },
    setTiles(t) { src.tiles = t },
    getData: () => Promise.resolve(src._data),
  }
  return src
}

function makeMap() {
  const sources = {}
  const layers = {}
  const canvas = makeElement()
  return {
    dragRotate: { isEnabled: () => true, enable() {}, disable() {} },
    dragPan: { isEnabled: () => true, enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {} },
    hasImage: () => false,
    loadImage: () => Promise.resolve({ data: {} }),
    addImage: () => {},
    getCanvas() { return canvas },
    getContainer() { return canvas },
    addSource(id, spec) { sources[id] = makeSource(spec) },
    getSource(id) { return sources[id] ?? null },
    removeSource(id) { delete sources[id] },
    addLayer(spec, beforeId) { layers[spec.id] = { ...spec }; if (beforeId && !layers[beforeId]) throw new Error('beforeId missing') },
    getLayer(id) { return layers[id] ?? null },
    removeLayer(id) { delete layers[id] },
    moveLayer() {},
    getStyle() { return { sources: {}, layers: [] } },
    project: () => ({ x: 100, y: 100 }),
    unproject: () => ({ lng: 0, lat: 0 }),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getZoom: () => 4,
    getPitch: () => 0,
    getBearing: () => 0,
    on() {},
    off() {},
  }
}

function mkModes() {
  return [
    new TerraDrawPointMode({}),
    new TerraDrawLineStringMode({}),
    new TerraDrawPolygonMode({}),
    new TerraDrawSelectMode({}),
  ]
}

function makeDraw(map) {
  return new TerraDraw({ adapter: new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 9 }), modes: mkModes() })
}

/** 通过 adapter 的 pointer 监听模拟一次真实点击（画一个点要素）。 */
function clickAt(map, x, y) {
  const ev = { isPrimary: true, clientX: x, clientY: y, target: map.getCanvas(), button: 0, preventDefault() {} }
  map.getCanvas().fire('pointerdown', ev)
  map.getCanvas().fire('pointerup', ev)
}

test('addFeatures 在 start 之前调用会抛错（旧顺序 bug）', () => {
  const map = makeMap()
  const draw = makeDraw(map)
  // 未 start 直接 addFeatures —— DrawToolbar 旧代码的真实顺序
  assert.throws(
    () => draw.addFeatures([{ id: 'p1', type: 'Feature', properties: { mode: 'point' }, geometry: { type: 'Point', coordinates: [0, 0] } }]),
    /not enabled/,
  )
  draw.stop()
})

test('先 start 再 addFeatures + 切换模式正常（修复后顺序）', () => {
  const map = makeMap()
  const draw = makeDraw(map)
  draw.start()
  draw.setMode('point')
  // 真实点击画一个点要素（走模式校验，保证进 store）
  clickAt(map, 200, 200)
  const snap = draw.getSnapshot()
  assert.ok(snap.length >= 1, '点击后应产生至少一个要素')
  // 切换模式：停掉旧 draw、新建 draw、start 在前、addFeatures(existing) 在后
  const existing = draw.getSnapshot()
  draw.stop()
  const draw2 = makeDraw(map)
  draw2.start()
  const added = draw2.addFeatures(existing)
  draw2.setMode('linestring')
  assert.equal(draw2.getMode(), 'linestring')
  assert.equal(draw2.getSnapshot().length, existing.length, '切换后原要素应保留')
  assert.ok(added.every((a) => a.valid !== false), '要素应通过校验')
  draw2.stop()
})
