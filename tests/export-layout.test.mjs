import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  exportFilename,
  formatMeters,
  layoutBoxes,
  legendItemsFromLayers,
  northArrowPath,
  scalebarBar,
} from '../lib/client/export-layout.js'

const fixed = new Date('2026-09-03T00:00:00Z')

test('legendItemsFromLayers：可见性/ids 过滤 + 面/线/点取色', () => {
  const layers = [
    { id: 'ds_1', name: '建筑', visible: true, color: '#ef4444', fillColor: '#f97316', geometryTypes: ['Polygon'], materialized: false, featureCount: 50000, totalCount: 130176 },
    { id: 'ds_2', name: '路网', visible: true, color: '#22c55e', geometryTypes: ['LineString'], materialized: true, featureCount: 5, totalCount: 5 },
    { id: 'import_1', name: 'POI', visible: true, color: '#8b5cf6', fillColor: '#06b6d4', geometryTypes: ['Point'], materialized: true, featureCount: 99, totalCount: 99 },
    { id: 'hidden', name: '藏', visible: false, color: '#000', geometryTypes: ['Point'], materialized: true, featureCount: 1, totalCount: 1 },
  ]
  const all = legendItemsFromLayers(layers)
  assert.equal(all.length, 3)
  assert.deepEqual(all[0], { name: '建筑', fill: '#f97316', stroke: '#ef4444', kind: 'fill', note: '（共 130176，抽样 50000）' })
  assert.equal(all[1].kind, 'line')
  assert.equal(all[1].fill, '#22c55e')
  assert.equal(all[2].kind, 'circle')
  assert.equal(all[2].fill, '#06b6d4')
  assert.equal(all[2].stroke, '#8b5cf6')
  const only = legendItemsFromLayers(layers, { ids: ['ds_1', 'import_1'] })
  assert.deepEqual(only.map((i) => i.name), ['建筑', 'POI'])
})

test('northArrowPath：8 点、关于 cx 左右对称、顶部是尖端', () => {
  const p = northArrowPath(100, 100, 20)
  assert.equal(p.length, 8)
  assert.ok(p.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))
  assert.equal(p[0][0], 100)
  assert.equal(p[0][1], 80)
  for (let i = 1; i < p.length; i++) {
    assert.ok(Math.abs((p[i][0] - 100) - -(p[p.length - i][0] - 100)) < 1e-6, 'x 对称')
  }
})

test('formatMeters / scalebarBar', () => {
  assert.equal(formatMeters(500), '500 m')
  assert.equal(formatMeters(2000), '2 km')
  assert.equal(formatMeters(2500), '2.5 km')
  const mpp = 2 // 每像素 2 米
  const bar = scalebarBar(mpp, 300)
  assert.ok(bar.pixels > 0 && bar.pixels <= 300, `pixels 在 (0,300]，实际 ${bar.pixels}`)
  assert.ok(bar.pixels >= 40, `不要太小：${bar.pixels}`)
  assert.equal(bar.label, formatMeters(bar.meters))
  // 圆整到 1/2/5 × 10^k
  const mant = bar.meters / 10 ** Math.floor(Math.log10(bar.meters))
  assert.ok([1, 2, 5].some((d) => Math.abs(mant - d) < 1e-9), `mantissa ${mant} 属 1/2/5`)
})

test('exportFilename：非法字符清洗 / 中文保留 / 空标题兜底', () => {
  assert.equal(exportFilename('a:b*c?.d', fixed), 'a_b_c_.d-2026-09-03.png')
  assert.equal(exportFilename('广州-建筑', fixed), '广州-建筑-2026-09-03.png')
  assert.equal(exportFilename('', fixed), 'webgis-map-2026-09-03.png')
  assert.equal(exportFilename('   ', fixed), 'webgis-map-2026-09-03.png')
})

test('layoutBoxes：矩形都在画布内，标题在最上，图例/比例尺/指北针不越界', () => {
  const w = 1200
  const h = 800
  const items = legendItemsFromLayers([
    { id: 'a', name: '建筑', visible: true, color: '#f97316', geometryTypes: ['Polygon'], materialized: true, featureCount: 2, totalCount: 2 },
    { id: 'b', name: '路网', visible: true, color: '#22c55e', geometryTypes: ['LineString'], materialized: true, featureCount: 1, totalCount: 1 },
  ])
  const ly = layoutBoxes(w, h, items, { title: '测试出图', legend: true, north: true, scale: true, note: '© OSM' })
  const boxes = [ly.title, ly.legend?.box, ly.north, ly.scale, ly.note].filter(Boolean)
  for (const b of boxes) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h, `越界 ${JSON.stringify(b)}`)
  }
  assert.ok(ly.title.y < (ly.north?.y ?? 0), '标题应在指北针上方')
  assert.ok((ly.scale?.y ?? 0) > (ly.legend?.box.y ?? 0), '图例在比例尺上方')
  for (const row of ly.legend?.rows ?? []) {
    assert.ok(row.x >= ly.legend.box.x && row.y >= ly.legend.box.y, '图例行在 box 内')
  }
})
