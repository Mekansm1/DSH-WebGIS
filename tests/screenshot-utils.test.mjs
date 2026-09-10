import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestLine, layerDigest, screenshotMeta } from '../lib/screenshot-utils.js'

/** 最小图层桩（只喂 layerDigest 用到的字段）。 */
function layer(over = {}) {
  return {
    id: 'dataset',
    name: '生活服务',
    featureCount: 62431,
    bbox: [116.2, 39.8, 116.6, 40.1],
    visible: true,
    color: '#e11d48',
    geometryTypes: ['Polygon'],
    mode: 'points',
    ...over,
  }
}

const VIEW = [116.3, 39.85, 116.5, 40.05] // 落在图层 bbox 内部

test('layerDigest: 只列可见图层，隐藏的计入 hidden 而不列出', () => {
  const r = layerDigest([
    layer({ id: 'a' }),
    layer({ id: 'b', visible: false, name: '已隐藏的层' }),
    layer({ id: 'c' }),
  ], VIEW)
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'c'])
  assert.equal(r.hidden, 1)
})

test('layerDigest: bbox 与视野相交才算 inView，视野外的保留但计数并排在后面', () => {
  const r = layerDigest([
    layer({ id: 'outside', name: '视野外', bbox: [100, 20, 101, 21], featureCount: 999999 }),
    layer({ id: 'inside', name: '视野内', featureCount: 10 }),
  ], VIEW)
  assert.equal(r.offView, 1)
  // 视野内在前（即使要素数远小于视野外的层）
  assert.deepEqual(r.items.map((i) => i.id), ['inside', 'outside'])
  assert.equal(r.items[0].inView, true)
  assert.equal(r.items[1].inView, false)
})

test('layerDigest: 视野未知或缺 bbox 不误报「不在画面里」', () => {
  const noView = layerDigest([layer({ id: 'a' })], null)
  assert.equal(noView.items[0].inView, true)
  assert.equal(noView.offView, 0)

  const noBbox = layerDigest([layer({ id: 'b', bbox: null })], VIEW)
  assert.equal(noBbox.items[0].inView, true)
  assert.equal(noBbox.offView, 0)
})

test('layerDigest: 同屏内按要素数降序；颜色取填充色优先', () => {
  const r = layerDigest([
    layer({ id: 'small', featureCount: 5 }),
    layer({ id: 'big', featureCount: 5000, color: '#111111', fillColor: '#2563eb' }),
  ], VIEW)
  assert.deepEqual(r.items.map((i) => i.id), ['big', 'small'])
  assert.equal(r.items[0].color, '#2563eb')
  assert.equal(r.items[1].color, '#e11d48')
})

test('layerDigest: 抽样图层带上真实总行数，全量图层不带', () => {
  const r = layerDigest([
    layer({ id: 'sampled', materialized: false, totalCount: 650000, featureCount: 2000 }),
    layer({ id: 'full', materialized: true, totalCount: 2000 }),
  ], VIEW)
  const sampled = r.items.find((i) => i.id === 'sampled')
  const full = r.items.find((i) => i.id === 'full')
  assert.equal(sampled.totalCount, 650000)
  assert.equal(full.totalCount, undefined)
})

test('digestLine: 带上名称/id/几何/要素数/颜色/展示方式，视野外有标记', () => {
  const r = layerDigest([layer({ id: 'dataset', mode: 'plane' })], VIEW)
  const line = digestLine(r.items[0])
  assert.match(line, /生活服务/)
  assert.match(line, /id=dataset/)
  assert.match(line, /Polygon/)
  assert.match(line, /62431 个要素/)
  assert.match(line, /颜色 #e11d48/)
  assert.match(line, /展示 plane/)
  assert.doesNotMatch(line, /不在当前视野内/)

  const off = layerDigest([layer({ bbox: [100, 20, 101, 21] })], VIEW)
  assert.match(digestLine(off.items[0]), /不在当前视野内/)
})

// ---- 红点只在「用户手动点击」时才有 ----

const SHOT = {
  ref: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1024, height: 1024, name: 'webgis-map' },
  scale: 1,
  pin: { x: 512, y: 512 },
  viewport: { width: 1024, height: 1024, zoom: 12, bearing: 0, pitch: 0, centerLng: 116.4, centerLat: 39.9 },
}

test('screenshotMeta: 透传 pinned；捕获视图（缺省）视为图上无红点', () => {
  assert.equal(screenshotMeta({ ...SHOT, pinned: true }).pinned, true)
  // 捕获路径不传 pinned → 必须是 false，否则文案会去描述一个不存在的红点
  assert.equal(screenshotMeta({ ...SHOT }).pinned, false)
})

test('screenshotMeta: 四角反投影出的 extent 包住画面中心（换算自洽）', () => {
  const meta = screenshotMeta(SHOT)
  assert.ok(meta.extent.west < 116.4 && 116.4 < meta.extent.east)
  assert.ok(meta.extent.south < 39.9 && 39.9 < meta.extent.north)
  assert.equal(meta.width, 1024)
  assert.equal(meta.height, 1024)
})
