import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_MAPS, baseMapAction } from '../lib/basemaps.js'

test('底图目录：id 唯一、两类齐全、kind 合法、非 default url 非空', () => {
  const ids = new Set(BASE_MAPS.map((d) => d.id))
  assert.equal(ids.size, BASE_MAPS.length, 'id 唯一')
  const cats = new Set(BASE_MAPS.map((d) => d.category))
  assert.ok(cats.has('矢量') && cats.has('影像'), '两类都有')
  for (const d of BASE_MAPS) {
    assert.ok(d.kind === 'raster' || d.kind === 'style', `${d.id} kind 合法`)
    assert.ok(d.name && d.category, `${d.id} 有名称/分类`)
    if (d.id !== 'default') assert.ok(d.url, `${d.id} url 非空`)
  }
  assert.ok(BASE_MAPS.some((d) => d.id === 'default'), '有 default 初始底图')
  assert.ok(BASE_MAPS.some((d) => d.kind === 'style'), '有矢量样式底图')
  assert.ok(BASE_MAPS.some((d) => d.kind === 'raster' && d.id !== 'default'), '有影像光栅底图')
})

test('baseMapAction: 样式→setStyleUrl；光栅+base源→setTiles；光栅无base源→setStyleRaster', () => {
  const style = BASE_MAPS.find((d) => d.kind === 'style')
  const raster = BASE_MAPS.find((d) => d.id === 'esri-imagery')
  assert.ok(style && raster)
  assert.deepEqual(baseMapAction(style, true), { kind: 'setStyleUrl', url: style.url })
  assert.deepEqual(baseMapAction(style, false), { kind: 'setStyleUrl', url: style.url })
  assert.deepEqual(baseMapAction(raster, true), { kind: 'setTiles', url: raster.url })
  assert.deepEqual(baseMapAction(raster, false), { kind: 'setStyleRaster', url: raster.url })
})
