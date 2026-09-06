import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureCollection, point, lineString, polygon } from '@turf/helpers'
import { tableFromIPC } from 'apache-arrow'
import wkx from 'wkx'
import { buildGeoArrowTables } from '@walkthru-earth/objex-utils'
import { pointsToGeoArrowTable, tableToIpc } from '../lib/geoarrow.js'
import { geojsonFamilies, geojsonKindOf, geometryKindOf, hexToRgb, rawLineData, rawPointData, rawPolygonData } from '../lib/client/geoarrow-utils.js'

test('geometryKindOf：按扩展元数据识别几何类型（点/线，含 IPC 往返）', () => {
  const pts = pointsToGeoArrowTable([{ lon: 113.3, lat: 23.1 }], 'lon', 'lat', [])
  assert.equal(geometryKindOf(pts), 'point')
  assert.equal(geometryKindOf(tableFromIPC(tableToIpc(pts))), 'point')
  // 线表（objex-utils WKB 路径）
  const line = lineString([[113, 23], [113.2, 23.1]])
  const wkb = wkx.Geometry.parseGeoJSON(line.geometry).toWkb()
  const results = buildGeoArrowTables([wkb], new Map())
  assert.equal(geometryKindOf(results[0].table), 'line')
  // 无几何列
  assert.equal(geometryKindOf(pointsToGeoArrowTable([], 'lon', 'lat', [])), 'point') // 空点表仍是 point
})

test('rawPointData：只留合法 Point（非法坐标/非点跳过）', () => {
  const fc = featureCollection([
    point([113.3, 23.1]),
    point([113.4, 23.2]),
    { type: 'Feature', geometry: { type: 'Point', coordinates: [null, 23.1] }, properties: {} },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113, 23], [113.5, 23.5]] }, properties: {} },
  ])
  const out = rawPointData(fc)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0].geometry.coordinates, [113.3, 23.1])
})

test('rawLineData / rawPolygonData / geojsonKindOf：geojson 线面要素过滤与类型分派', () => {
  const fc = featureCollection([
    lineString([[113, 23], [113.2, 23.1]]),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.5, 23.5], [null, 23.6]] }, properties: {} }, // 非法顶点整条跳过
    point([114, 24]),
    polygon([[[0, 0], [0, 1], [1, 1], [0, 0]]]),
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[2, 2], [2, 3], [null, 3], [2, 2]]] }, properties: {} }, // 非法环跳过
  ])
  assert.equal(geojsonKindOf(fc), 'line') // 首个非空类型 = 线
  assert.equal(rawLineData(fc).length, 1)
  assert.equal(rawPolygonData(fc).length, 1)
  assert.equal(rawLineData(fc)[0].geometry.coordinates.length, 2)
  assert.equal(geojsonKindOf(featureCollection([polygon([[[0, 0], [0, 1], [1, 0], [0, 0]]])])), 'polygon')
  assert.equal(geojsonKindOf(featureCollection([point([1, 1])])), 'point')
  assert.equal(geojsonKindOf(featureCollection([])), 'other')
})

test('hexToRgb：#rrggbb / #rgb / 非法回退', () => {
  assert.deepEqual(hexToRgb('#10b981'), [16, 185, 129])
  assert.deepEqual(hexToRgb('f73'), [255, 119, 51])
  assert.deepEqual(hexToRgb('nope'), [249, 115, 22])
})

test('geojsonFamilies：混合几何按出现顺序列出；空集合 []', () => {
  const fc = featureCollection([
    point([1, 1]),
    polygon([[[0, 0], [0, 1], [1, 0], [0, 0]]]),
    lineString([[0, 0], [1, 1]]),
    polygon([[[2, 2], [2, 3], [3, 2], [2, 2]]]),
  ])
  assert.deepEqual(geojsonFamilies(fc), ['point', 'polygon', 'line'])
  assert.deepEqual(geojsonFamilies(featureCollection([])), [])
})
