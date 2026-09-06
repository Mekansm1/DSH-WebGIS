import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { featureCollection, point } from '@turf/helpers'
import { toShpZip } from '../lib/geo-export.js'
import { loadCsvText, loadDataset, parseShapefileBuffer } from '../lib/index.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'webgis-'))
}

// 回归：曾把 `match(...)[0]`（带点 .csv）与 'csv' 比较导致永远不匹配，
// 所有格式都掉进 JSON 分支（.shp/.csv 被 JSON.parse 报错）。以下测试锁住分发。

test('loadDataset: .csv 分发到 CSV 解析，产出点要素，BOM 已处理', async () => {
  const dir = tmpDir()
  const csvPath = join(dir, 'poi.csv')
  // 带 BOM 的 CSV，含 lon_wgs84/lat_wgs84 列
  writeFileSync(
    csvPath,
    '﻿name,lon_wgs84,lat_wgs84,cat\nA,116.39,39.90,x\nB,121.47,31.23,y\n',
    'utf8',
  )
  const ds = await loadDataset(csvPath)
  assert.equal(ds.featureCount, 2)
  assert.equal(ds.geojson.features[0].geometry.type, 'Point')
  assert.deepEqual(ds.geojson.features[0].geometry.coordinates, [116.39, 39.9])
  assert.equal(ds.geojson.features[0].properties.name, 'A')
  // 用到的坐标列不重复保留，其余列保留
  assert.ok(!('lon_wgs84' in ds.geojson.features[0].properties))
  assert.equal(ds.geojson.features[0].properties.cat, 'x')
})

test('loadDataset: .geojson 仍走 JSON 分支', async () => {
  const dir = tmpDir()
  const jsonPath = join(dir, 'points.geojson')
  writeFileSync(
    jsonPath,
    JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} }] }),
    'utf8',
  )
  const ds = await loadDataset(jsonPath)
  assert.equal(ds.featureCount, 1)
  assert.deepEqual(ds.geojson.features[0].geometry.coordinates, [1, 2])
})

test('loadDataset: .shp 走 shapefile 分支（垃圾内容报 shp 解析错误，而非 JSON 错误）', async () => {
  const dir = tmpDir()
  const shpPath = join(dir, 'fake.shp')
  writeFileSync(shpPath, 'this is not a real shapefile, definitely not JSON', 'utf8')
  // 修复前：ext='.shp' 不匹配 'shp' → 掉进 JSON 分支 → "is not valid JSON"
  // 修复后：走 loadShapefile → shpjs 对垃圾内容抛非 JSON 错误
  await assert.rejects(loadDataset(shpPath), (err) => {
    assert.ok(!/is not valid JSON/.test(err.message), `不应是 JSON 解析错误，实际：${err.message}`)
    return true
  })
})

test('loadDataset: .zip 走 shapefile 分支（路径不带 .csv/.shp/.zip 之外的后缀时归 JSON）', async () => {
  const dir = tmpDir()
  const zipPath = join(dir, 'fake.zip')
  writeFileSync(zipPath, 'not a zip', 'utf8')
  await assert.rejects(loadDataset(zipPath), (err) => {
    assert.ok(!/is not valid JSON/.test(err.message), `不应是 JSON 解析错误，实际：${err.message}`)
    return true
  })
})

// ---- WKT 列 / 字节导入（功能 2：shp/csv/geojson 导入）----

test('loadCsvText: WKT 几何列 → 任意几何类型（Polygon/Point），几何列不重复保留，SRID 前缀可剥', () => {
  const csv = 'name,geom,note\n"地块A","POLYGON((0 0,1 0,1 1,0 1,0 0))",x\n"地块B",SRID=4326;POINT(116.39 39.90),y\n'
  const gj = loadCsvText(csv)
  assert.equal(gj.features.length, 2)
  assert.equal(gj.features[0].geometry.type, 'Polygon')
  assert.equal(gj.features[1].geometry.type, 'Point')
  assert.deepEqual(gj.features[1].geometry.coordinates, [116.39, 39.9])
  assert.equal(gj.features[0].properties.name, '地块A')
  assert.ok(!('geom' in gj.features[0].properties))
})

test('loadCsvText: 无 WKT 列时回退经纬度列 → Point', () => {
  const gj = loadCsvText('name,lon_wgs84,lat_wgs84\nA,116.39,39.90\n')
  assert.equal(gj.features.length, 1)
  assert.equal(gj.features[0].geometry.type, 'Point')
})

test('parseShapefileBuffer: toShpZip 产物 zip → 要素坐标一致', async () => {
  const zip = toShpZip(featureCollection([point([116.4, 39.9], { name: 'a' })]), 'p')
  const gj = await parseShapefileBuffer(Buffer.from(zip), 'zip')
  assert.equal(gj.features.length, 1)
  assert.deepEqual(gj.features[0].geometry.coordinates, [116.4, 39.9])
})
