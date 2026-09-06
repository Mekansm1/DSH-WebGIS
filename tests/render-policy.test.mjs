import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureCollection, point } from '@turf/helpers'
import { arrowCountForZoom, CHOICE_FROM, DECK_FROM, nextArrowCount, pickRenderer } from '../lib/render-policy.js'
import { makeResultLayer } from '../lib/geo-processing.js'

test('pickRenderer：硬规则（arrow / deck 特效 / supercluster）优先', () => {
  // Arrow 数据只能 deck（即使只有 1 行）
  assert.equal(pickRenderer({ mode: 'points', actualCount: 1, materialized: true, dataFormat: 'arrow' }), 'deck')
  // deck 特效模式恒 deck
  for (const mode of ['arc', 'trips', 'wall', 'radial']) {
    assert.equal(pickRenderer({ mode, actualCount: 1, materialized: true, dataFormat: 'geojson' }), 'deck')
  }
  // supercluster 硬绑定 maplibre（即使 50 万行）
  assert.equal(
    pickRenderer({ mode: 'points', actualCount: 500_000, materialized: false, dataFormat: 'geojson', needSupercluster: true }),
    'maplibre',
  )
})

test('arrowCountForZoom：初始 5 万 → 15 级 20 万 → 16 级 60 万 → 17 级后全量', () => {
  const TOTAL = 1_680_418
  // 低缩放（≤14）初始 5 万
  assert.equal(arrowCountForZoom(2, TOTAL), 50_000)
  assert.equal(arrowCountForZoom(8, TOTAL), 50_000)
  assert.equal(arrowCountForZoom(14, TOTAL), 50_000)
  // 15 级 20 万、16 级 60 万
  assert.equal(arrowCountForZoom(15, TOTAL), 200_000)
  assert.equal(arrowCountForZoom(16, TOTAL), 600_000)
  // 17 级以后全量
  assert.equal(arrowCountForZoom(17, TOTAL), TOTAL)
  assert.equal(arrowCountForZoom(20, TOTAL), TOTAL)
  // 小图层：min 收敛回全量
  assert.equal(arrowCountForZoom(2, 30_000), 30_000)
  assert.equal(arrowCountForZoom(16, 30_000), 30_000)
  assert.equal(arrowCountForZoom(9, 120_000), 50_000)
  assert.equal(arrowCountForZoom(15, 120_000), 120_000)
})

test('nextArrowCount：当前分档的下一档（预取预热）；全量返回 null', () => {
  const TOTAL = 1_680_418
  assert.equal(nextArrowCount(50_000, TOTAL), 200_000)
  assert.equal(nextArrowCount(200_000, TOTAL), 600_000)
  assert.equal(nextArrowCount(600_000, TOTAL), TOTAL)
  assert.equal(nextArrowCount(TOTAL, TOTAL), null)
  assert.equal(nextArrowCount(120_000, TOTAL), 200_000)
  assert.equal(nextArrowCount(50_000, 80_000), 80_000) // 中间档不存在 → 直接全量
  assert.equal(nextArrowCount(80_000, 80_000), null)
})

test('pickRenderer：按真实行数分档（>10 万 deck / 5~10 万 user-choice / ≤5 万 maplibre）', () => {
  const base = { mode: 'points', materialized: true, dataFormat: 'geojson' }
  assert.equal(pickRenderer({ ...base, actualCount: 1 }), 'maplibre')
  assert.equal(pickRenderer({ ...base, actualCount: 50_000 }), 'maplibre')
  assert.equal(pickRenderer({ ...base, actualCount: 50_001 }), 'user-choice')
  assert.equal(pickRenderer({ ...base, actualCount: 100_000 }), 'user-choice')
  assert.equal(pickRenderer({ ...base, actualCount: 100_001 }), 'deck')
  assert.equal(pickRenderer({ ...base, actualCount: 1_000_000 }), 'deck')
  assert.equal(DECK_FROM, 100_000)
  assert.equal(CHOICE_FROM, 50_000)
})

test('makeResultLayer：renderer/totalCount/materialized/dataFormat 计算', () => {
  const pts = featureCollection([point([113, 23]), point([113.1, 23.1])])
  // 小图层：maplibre、已全量物化、仅 geojson
  const small = makeResultLayer({ id: 'a', name: 'a', geojson: pts, source: 'x' })
  assert.equal(small.renderer, 'maplibre')
  assert.equal(small.materialized, true)
  assert.equal(small.dataFormat, 'geojson')
  assert.equal(small.totalCount, undefined)
  // duckTable 大图层：真实行数 >10 万 → deck 原始点（geojson 只是抽样）
  const huge = makeResultLayer({
    id: 'b', name: 'b', geojson: pts, source: 'csv',
    duckTable: 'duckdb_1', duckCoords: { lon: 'lon', lat: 'lat' }, totalCount: 1_000_000, cluster: false,
  })
  assert.equal(huge.renderer, 'deck')
  assert.equal(huge.materialized, false)
  assert.equal(huge.dataFormat, 'arrow')
  assert.equal(huge.totalCount, 1_000_000)
  // duckTable 但真实行数 5~10 万 → user-choice 存为 maplibre
  const mid = makeResultLayer({
    id: 'c', name: 'c', geojson: pts, source: 'csv',
    duckTable: 'duckdb_2', duckCoords: { lon: 'lon', lat: 'lat' }, totalCount: 60_000, cluster: false,
  })
  assert.equal(mid.renderer, 'maplibre')
  assert.equal(mid.materialized, false)
  // duckTable + cluster（显式 supercluster）→ maplibre 硬规则
  const clus = makeResultLayer({ id: 'd', name: 'd', geojson: pts, source: 'csv', duckTable: 'duckdb_3', totalCount: 1_000_000, cluster: true })
  assert.equal(clus.renderer, 'maplibre')
  // 大图层线/面（duckTable）→ deck 原始数据 + arrow（放行集合含线/面）
  const line = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[113, 23], [113.2, 23.1]] }, properties: {} }],
  }
  const bigline = makeResultLayer({ id: 'e', name: 'e', geojson: line, source: 'csv', duckTable: 'duckdb_4', totalCount: 500_000, cluster: false })
  assert.equal(bigline.renderer, 'deck')
  assert.equal(bigline.dataFormat, 'arrow')
  const poly = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[113, 23], [113.2, 23], [113.2, 23.1], [113, 23]]] }, properties: {} }],
  }
  // 纯面大图层 → deck + arrow（threads 已用 node 内置 shim 解决 bundle 加载，面上 arrow 走 zoom 分级）
  const bigpoly = makeResultLayer({ id: 'g', name: 'g', geojson: poly, source: 'csv', duckTable: 'duckdb_5', totalCount: 300_000, cluster: false })
  assert.equal(bigpoly.renderer, 'deck')
  assert.equal(bigpoly.dataFormat, 'arrow')
  // deck 特效模式 → deck（即使小）
  const arc = makeResultLayer({ id: 'f', name: 'f', geojson: pts, source: 'x', mode: 'arc' })
  assert.equal(arc.renderer, 'deck')
})
