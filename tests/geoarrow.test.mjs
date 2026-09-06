import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tableFromIPC } from 'apache-arrow'
import wkx from 'wkx'
import { DuckDbEngine } from '../lib/duckdb.js'
import { pointsToGeoArrowTable, tableToIpc, wkbRowsToGeoArrowTable } from '../lib/geoarrow.js'

test('pointsToGeoArrowTable：结构 + 扩展元数据 + IPC 往返', () => {
  const rows = [
    { lon: 113.3, lat: 23.1, name: 'a', v: 1 },
    { lon: 113.4, lat: 23.2, name: 'b', v: 2 },
    { lon: null, lat: 23.1, name: 'skip' }, // 非法/空坐标行跳过
  ]
  const table = pointsToGeoArrowTable(rows, 'lon', 'lat', ['name', 'v'])
  assert.equal(table.numRows, 2)
  assert.equal(table.numCols, 3)
  const g = table.getChild('__geometry')
  // 扩展元数据在 schema 字段上（deck.gl-geoarrow 扫 schema.fields 定位几何列）；值走 vector.get。
  assert.equal(table.schema.fields.find((f) => f.name === '__geometry')?.metadata.get('ARROW:extension:name'), 'geoarrow.point')
  assert.deepEqual(Array.from(g?.get(0) ?? []), [113.3, 23.1])
  assert.equal(table.getChild('name')?.get(1), 'b')
  assert.equal(table.getChild('v')?.get(1), 2)
  // IPC 往返：扩展元数据保留、数据一致（客户端 tableFromIPC 还原喂给 deck.gl-geoarrow）
  const back = tableFromIPC(tableToIpc(table))
  assert.equal(back.numRows, 2)
  assert.equal(back.schema.fields.find((f) => f.name === '__geometry')?.metadata.get('ARROW:extension:name'), 'geoarrow.point')
  assert.deepEqual(Array.from(back.getChild('__geometry')?.get(0) ?? []), [113.3, 23.1])
})

test('pointsToGeoArrowTable：空结果 / 属性列类型（数值→Float64、字符串→Utf8）', () => {
  const empty = pointsToGeoArrowTable([], 'lon', 'lat', ['name'])
  assert.equal(empty.numRows, 0)
  const mixed = pointsToGeoArrowTable([{ lon: 113, lat: 23, n: 5, s: 'x' }], 'lon', 'lat', ['n', 's'])
  assert.equal(mixed.getChild('n')?.get(0), 5)
  assert.equal(mixed.getChild('s')?.get(0), 'x')
})

test('pointsToGeoArrowTable：空属性（attrs=[]）→ 只出几何列（arrow 路由只拉坐标的契约，防 SELECT * 全属性爆堆回归）', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ lon: 113 + i, lat: 23, name: `p${i}`, addr: 'x' }))
  const table = pointsToGeoArrowTable(rows, 'lon', 'lat', [])
  assert.equal(table.numRows, 5)
  assert.equal(table.numCols, 1) // 只有 __geometry，不带任何属性列
  assert.equal(table.schema.fields[0]?.name, '__geometry')
  assert.equal(table.schema.fields.find((f) => f.name === '__geometry')?.metadata.get('ARROW:extension:name'), 'geoarrow.point')
  assert.deepEqual(Array.from(table.getChild('__geometry')?.get(4) ?? []), [117, 23])
  const back = tableFromIPC(tableToIpc(table))
  assert.equal(back.numCols, 1)
  assert.equal(back.schema.fields.find((f) => f.name === '__geometry')?.metadata.get('ARROW:extension:name'), 'geoarrow.point')
})

test('wkbRowsToGeoArrowTable：WKB → GeoArrow（经 objex-utils，混合几何取主类型）', () => {
  const wkb = (g) => wkx.Geometry.parseGeoJSON(g).toWkb()
  const rows = [
    { __wkb: wkb({ type: 'Point', coordinates: [113.3, 23.1] }), name: 'a' },
    { __wkb: wkb({ type: 'Point', coordinates: [113.4, 23.2] }), name: 'b' },
    { __wkb: null, name: 'skip' },
  ]
  const table = wkbRowsToGeoArrowTable(rows, '__wkb', ['name'])
  assert.ok(table)
  assert.equal(table.numRows, 2)
  assert.equal(table.getChild('name')?.get(0), 'a')
  const back = tableFromIPC(tableToIpc(table))
  assert.equal(back.numRows, 2)
  assert.equal(back.getChild('name')?.get(1), 'b')
})

test('wkbRowsToGeoArrowTable：线/面 WKB → GeoArrow（线面放行后的 arrow 路由数据源）', () => {
  const wkb = (g) => wkx.Geometry.parseGeoJSON(g).toWkb()
  // 线 → geoarrow.linestring
  const lineTable = wkbRowsToGeoArrowTable([
    { __wkb: wkb({ type: 'LineString', coordinates: [[113, 23], [113.1, 23.1]] }) },
    { __wkb: wkb({ type: 'LineString', coordinates: [[114, 24], [114.1, 24.1]] }) },
  ], '__wkb', [])
  assert.ok(lineTable)
  assert.equal(lineTable.numRows, 2)
  // objex-utils 几何字段名是 geometry（非 __geometry），按扩展元数据找
  assert.equal(lineTable.schema.fields.find((f) => f.metadata.get('ARROW:extension:name') === 'geoarrow.linestring')?.name, 'geometry')
  // 面（带洞）→ geoarrow.polygon
  const polyTable = wkbRowsToGeoArrowTable([
    { __wkb: wkb({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[0.2, 0.2], [0.2, 0.3], [0.3, 0.3], [0.3, 0.2], [0.2, 0.2]]] }) },
    { __wkb: wkb({ type: 'Polygon', coordinates: [[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]] }) },
  ], '__wkb', [])
  assert.ok(polyTable)
  assert.equal(polyTable.numRows, 2)
  assert.equal(polyTable.schema.fields.find((f) => f.metadata.get('ARROW:extension:name') === 'geoarrow.polygon')?.name, 'geometry')
  // IPC 往返保留扩展元数据（客户端 tableFromIPC 还原喂给 GeoArrowPolygonLayer）
  const back = tableFromIPC(tableToIpc(polyTable))
  assert.equal(back.schema.fields.find((f) => f.metadata.get('ARROW:extension:name') === 'geoarrow.polygon')?.name, 'geometry')
})

test('wkbRowsToGeoArrowTable：无有效几何 → null', () => {
  assert.equal(wkbRowsToGeoArrowTable([{ __wkb: null }], '__wkb', []), null)
  assert.equal(wkbRowsToGeoArrowTable([], '__wkb', []), null)
})

test('真实引擎：duckTable 全表 → Point GeoArrow 表（arrow 路由的数据来源）', async () => {
  const dir = join(tmpdir(), `dsh-webgis-geoarrow-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  let out = 'id,name,lon_wgs84,lat_wgs84,city\n'
  for (let i = 1; i <= 20; i++) out += `${i},p${i},${(113 + i / 100).toFixed(4)},${(23 + i / 100).toFixed(4)},${i % 2 ? '天河' : '越秀'}\n`
  writeFileSync(join(dir, 'poi.csv'), out)
  try {
    const engine = new DuckDbEngine()
    const t = engine.nextTableName()
    await engine.createTableFromCsv(t, join(dir, 'poi.csv'))
    const rows = await engine.query(t, '')
    const table = pointsToGeoArrowTable(rows, 'lon_wgs84', 'lat_wgs84', ['id', 'name', 'city'])
    assert.equal(table.numRows, 20)
    assert.equal(table.schema.fields.find((f) => f.name === '__geometry')?.metadata.get('ARROW:extension:name'), 'geoarrow.point')
    assert.equal(table.getChild('city')?.get(0), '天河')
    await engine.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
