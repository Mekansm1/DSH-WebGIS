import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DuckDbEngine,
  detectCoordColumns,
  detectGeomColumn,
  detectGeomFormat,
  friendlyDuckError,
  geometryRowsToGeoJSON,
  getDuckDb,
  normalizeValue,
  rowsToGeoJSON,
} from '../lib/duckdb.js'
import {
  geomFamiliesOf,
  geomFamiliesOfWkb,
  ingestBigGeojson,
  loadCsvSourceData,
  loadVectorSourceData,
  registerDuckDbTools,
} from '../lib/duckdb-tools.js'
import { registerGeoTools } from '../lib/geo-tools.js'
import { makeResultLayer } from '../lib/geo-processing.js'
import { dropLayerResources } from '../lib/index.js'
import { polygon, featureCollection } from '@turf/helpers'

/** 造一个捕获了工具注册的假 ctx + 按会话隔离的注册表状态；CSV 图层移除联动 DROP 内存表。 */
function setupDuck(engine) {
  const defs = []
  const ctx = { tools: { register: (d) => defs.push(d) } }
  const states = new Map()
  const stateFor = (sid) => {
    const key = sid ?? 'anon'
    let st = states.get(key)
    if (!st) {
      st = { layers: [] }
      states.set(key, st)
    }
    return st
  }
  const removed = []
  registerDuckDbTools(ctx, stateFor, { engine })
  registerGeoTools(ctx, stateFor, {
    onRemoveLayer: (layer) => {
      removed.push(layer)
      if (layer.duckTable) void engine.dropTable(layer.duckTable)
    },
  })
  const tool = (name) => {
    const d = defs.find((x) => x.name === name)
    assert.ok(d, `未找到工具 ${name}`)
    return d
  }
  const run = (name, args, sid) => tool(name).execute(args, { agent: sid ? { id: sid } : undefined })
  return { defs, states, stateFor, state: stateFor(undefined), tool, run, removed }
}

/** 生成 n 行带 lon_wgs84/lat_wgs84 的 POI CSV（广州一带，city 天河/越秀交替）。 */
function poiCsv(n) {
  let out = 'id,name,lon_wgs84,lat_wgs84,city\n'
  for (let i = 1; i <= n; i++) {
    const lon = (113.0 + (i % 100) / 100).toFixed(6)
    const lat = (23.0 + (i % 100) / 100).toFixed(6)
    out += `${i},p${i},${lon},${lat},${i % 2 ? '天河' : '越秀'}\n`
  }
  return out
}

let dir
before(() => {
  dir = join(tmpdir(), `dsh-webgis-duckdb-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'poi.csv'), poiCsv(200))
  writeFileSync(join(dir, 'xy.csv'), 'id,label,x,y\n1,a,113.3,23.1\n2,b,113.4,23.2\n3,c,113.5,23.3\n')
  writeFileSync(join(dir, 'nogeom.csv'), 'id,name\n1,a\n2,b\n')
  writeFileSync(join(dir, 'city.csv'), 'id,name,lon_wgs84,lat_wgs84,城市\n1,广州塔,113.32,23.11,广州\n2,北京,116.40,39.90,北京\n')
  // 几何列（WKT）fixture：无经纬度列；混合 Point/Polygon（Polygon 带逗号需引号包裹）。
  writeFileSync(
    join(dir, 'wkt.csv'),
    'id,name,wkt\n'
      + '1,a,POINT(113.3 23.1)\n'
      + '2,b,POINT(113.4 23.2)\n'
      + '3,c,"POLYGON((113.2 23.2,113.8 23.2,113.8 23.8,113.2 23.8,113.2 23.2))"\n',
  )
  // 经纬度 + WKT 共存：现状优先走经纬度点。
  writeFileSync(join(dir, 'lonlat_wkt.csv'), 'id,lon,lat,wkt\n1,113.3,23.1,POINT(113.3 23.1)\n2,113.4,23.2,POINT(113.4 23.2)\n3,113.5,23.3,POINT(113.5 23.3)\n')
  // 纯点 WKT（无经纬度列）→ duckGeom point-only 路径。
  writeFileSync(
    join(dir, 'wkt_pts.csv'),
    'id,name,wkt\n1,a,POINT(113.3 23.1)\n2,b,POINT(113.4 23.2)\n3,c,POINT(113.5 23.3)\n',
  )
  // 面 WKT 层（duckGeom polygon）作 intersects_layer 对方。
  writeFileSync(
    join(dir, 'wkt_polys.csv'),
    'id,name,wkt\n'
      + '1,A,"POLYGON((113.2 23.2,113.8 23.2,113.8 23.8,113.2 23.8,113.2 23.2))"\n'
      + '2,B,"POLYGON((114.0 23.0,114.5 23.0,114.5 23.5,114.0 23.5,114.0 23.0))"\n',
  )
  // 200,020 行大 CSV：跑 spatial_filter 超加载上限（>200000）分支。
  let big = 'id,name,lon_wgs84,lat_wgs84,city\n'
  for (let i = 1; i <= 200_020; i++) {
    const lon = (113.0 + (i % 100) / 100).toFixed(6)
    const lat = (23.0 + (i % 100) / 100).toFixed(6)
    big += `${i},p${i},${lon},${lat},${i % 2 ? '天河' : '越秀'}\n`
  }
  writeFileSync(join(dir, 'poi_big.csv'), big)
  // 小 KML（2 个 Point Placemark）：矢量 ST_Read/GDAL 直读灌表 fixture。
  const kml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2">\n'
    + '<Document>\n'
    + '  <Placemark><name>Point1</name><description>first</description><Point><coordinates>113.3,23.1,0</coordinates></Point></Placemark>\n'
    + '  <Placemark><name>Point2</name><description>second</description><Point><coordinates>113.4,23.2,0</coordinates></Point></Placemark>\n'
    + '</Document>\n'
    + '</kml>\n'
  writeFileSync(join(dir, 'pts.kml'), kml, 'utf8')
})
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('detectCoordColumns：自动优先级 + 显式传入 + 缺失回退', () => {
  assert.deepEqual(detectCoordColumns(['lon_wgs84', 'lat_wgs84', 'city']), { lon: 'lon_wgs84', lat: 'lat_wgs84' })
  assert.deepEqual(detectCoordColumns(['lon', 'lat']), { lon: 'lon', lat: 'lat' })
  assert.deepEqual(detectCoordColumns(['id', 'x', 'y', 'city']), { lon: null, lat: null })
  assert.deepEqual(detectCoordColumns(['id', 'x', 'y', 'city'], 'x', 'y'), { lon: 'x', lat: 'y' })
  // 显式只传对一半 → 不认（返回 null，工具层提示补全）
  assert.deepEqual(detectCoordColumns(['id', 'x', 'y'], 'xx', 'y'), { lon: null, lat: null })
})

test('rowsToGeoJSON：坐标列不保留、非法/越界/空行跳过', () => {
  const fc = rowsToGeoJSON([
    { lon_wgs84: 113.3, lat_wgs84: 23.1, name: 'a' },
    { lon_wgs84: 999, lat_wgs84: 23.1, name: 'bad' },
    { lon_wgs84: null, lat_wgs84: 23.1, name: 'null' },
    { lon_wgs84: 113.4, lat_wgs84: 91, name: 'out' },
  ], 'lon_wgs84', 'lat_wgs84')
  assert.equal(fc.features.length, 1)
  assert.deepEqual(fc.features[0].geometry.coordinates, [113.3, 23.1])
  assert.deepEqual(fc.features[0].properties, { name: 'a' })
})

test('DuckDbEngine：建表/信息/抽样/查询/删除', async () => {
  const engine = new DuckDbEngine()
  const t = engine.nextTableName()
  await engine.createTableFromCsv(t, join(dir, 'poi.csv'))
  const info = await engine.tableInfo(t)
  assert.equal(info.count, 200)
  assert.ok(info.columns.includes('lon_wgs84'))
  assert.deepEqual(engine.tableNames(), [t])

  const sampled = await engine.sampleRows(t, 50)
  assert.ok(sampled.length > 0 && sampled.length <= 50)

  const q = await engine.query(t, 'WHERE city = ? LIMIT 5', ['天河'])
  assert.equal(q.length, 5)
  assert.ok(q.every((r) => r.city === '天河'))

  const positions = await engine.readPointCoordinates(`SELECT "lon_wgs84", "lat_wgs84" FROM ${t}`)
  assert.equal(positions.length, 400, '200 行坐标应写为 400 个 Float64 值')
  assert.deepEqual(Array.from(positions.slice(0, 2)), [113.01, 23.01])

  await engine.dropTable(t)
  assert.deepEqual(engine.tableNames(), [])
  await engine.close()
})

test('DuckDbEngine.arrowIpc：Node Neo 未提供 IPC 导出时稳定回退 null', async () => {
  const engine = new DuckDbEngine()
  try {
    const t = engine.nextTableName()
    await engine.createTableFromCsv(t, join(dir, 'poi.csv'))
    const buf = await engine.arrowIpc(`SELECT "lon_wgs84", "lat_wgs84" FROM ${t} LIMIT 100`)
    assert.equal(buf, null)
    await engine.dropTable(t)
    assert.deepEqual(engine.tableNames(), [])
  } finally {
    await engine.close()
  }
})

test('webgis_load_csv：小文件常规加载（全部上图、不留内存表）', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'small')
  assert.equal(out.totalCount, 200)
  assert.equal(out.featureCount, 200)
  assert.equal(out.table, '')
  const layer = state.layers[0]
  assert.equal(layer.source, 'csv')
  assert.equal(layer.duckTable, undefined)
  assert.equal(layer.cluster, false)
  assert.equal(layer.renderer, 'maplibre')
  assert.equal(layer.materialized, true)
  assert.equal(layer.dataFormat, 'geojson')
  assert.equal(layer.totalCount, 200)
  assert.deepEqual(engine.tableNames(), [])
  await engine.close()
})

test('webgis_load_csv：大文件抽样+cluster+保留内存表；移除图层联动 DROP', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run, removed } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'poi.csv') }) // 200 行 > 阈值 50
  assert.equal(out.ok, true)
  assert.equal(out.status, 'loaded')
  assert.equal(out.totalCount, 200)
  assert.ok(out.featureCount > 0 && out.featureCount <= 50)
  const layer = state.layers[0]
  assert.ok(layer.duckTable, '大文件应保留内存表')
  assert.equal(layer.cluster, true)
  assert.equal(layer.renderer, 'maplibre', '200 行 < 10 万 → maplibre 聚合')
  assert.equal(layer.materialized, false)
  assert.equal(layer.dataFormat, 'geojson', 'maplibre 渲染图层走 geojson（arrow 只服务 deck 点图层）')
  assert.equal(layer.totalCount, 200)
  assert.deepEqual(engine.tableNames(), [layer.duckTable])

  const rm = await run('webgis_remove_layer', { layer: layer.id })
  assert.equal(rm.ok, true)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].id, layer.id)
  assert.deepEqual(engine.tableNames(), [], '移除图层后内存表应被 DROP')
  await engine.close()
})

test('webgis_load_csv：filter 只上图匹配子集（含中文列名）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'city.csv'), filter: { 城市: '广州' } })
  assert.equal(out.ok, true)
  assert.equal(out.totalCount, 2)
  assert.equal(out.featureCount, 1)
  assert.equal(state.layers[0].geojson.features[0].properties.name, '广州塔')
  await engine.close()
})

test('webgis_load_csv：显式 lonField/latField（列名非标准）', async () => {
  const engine = new DuckDbEngine()
  const { run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'xy.csv'), lonField: 'x', latField: 'y' })
  assert.equal(out.ok, true)
  assert.equal(out.featureCount, 3)
  await engine.close()
})

test('webgis_load_csv：limit 限制上图子集', async () => {
  const engine = new DuckDbEngine()
  const { run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'poi.csv'), limit: 10 })
  assert.equal(out.ok, true)
  assert.equal(out.featureCount, 10)
  await engine.close()
})

test('webgis_load_csv：无经纬度列 → ok:false（提示可传字段或改用 webgis_load）', async () => {
  const engine = new DuckDbEngine()
  const { run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'nogeom.csv') })
  assert.equal(out.ok, false)
  assert.match(out.message, /经纬度/)
  await engine.close()
})

test('webgis_load_csv：路径不存在 → ok:false', async () => {
  const engine = new DuckDbEngine()
  const { run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'nope.csv') })
  assert.equal(out.ok, false)
  await engine.close()
})

test('webgis_load_csv：会话隔离（不同 agent 各看各的图层）', async () => {
  const engine = new DuckDbEngine()
  const { run, stateFor } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') }, 'alice')
  await run('webgis_load_csv', { path: join(dir, 'city.csv') }, 'bob')
  assert.equal(stateFor('alice').layers.length, 1)
  assert.equal(stateFor('bob').layers.length, 1)
  assert.equal(stateFor(undefined).layers.length, 0)
  await engine.close()
})

test('webgis_filter_layer：where 等于筛选 → 新表新图层（可链式再筛）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') }) // 200 行大文件
  const base = state.layers[0]
  assert.ok(base.duckTable)

  const out = await run('webgis_filter_layer', { layer: base.id, where: { city: '天河' } })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.equal(out.count, 100)
  assert.equal(out.featureCount, 100)
  const result = state.layers[1]
  assert.ok(result.duckTable)
  assert.deepEqual(result.duckCoords, { lon: 'lon_wgs84', lat: 'lat_wgs84' })

  // 链式：在结果图层上再 bbox 筛选
  const out2 = await run('webgis_filter_layer', { layer: result.id, bbox: { west: 113, south: 23, east: 114, north: 24 } })
  assert.equal(out2.ok, true)
  assert.equal(out2.count, 100)
  await engine.close()
})

test('webgis_filter_layer：bbox 范围筛选', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  // poi.csv 的 lon/lat 在 113.0~113.99 / 23.0~23.99；切右上象限
  const out = await run('webgis_filter_layer', { layer: layer.id, bbox: { west: 113.5, south: 23.5, east: 114, north: 24 } })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.ok(out.count > 0 && out.count <= 100)
  await engine.close()
})

test('webgis_filter_layer：radius + center 半径筛选', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  const out = await run('webgis_filter_layer', { layer: layer.id, center: { lon: 113.5, lat: 23.5 }, radius: 2000 })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.ok(out.count > 0 && out.count < 200)
  await engine.close()
})

test('webgis_filter_layer：非 DuckDB 图层 → ok:false', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'city.csv') }) // 小文件 → 无内存表
  const layer = state.layers[0]
  assert.equal(layer.duckTable, undefined)
  const out = await run('webgis_filter_layer', { layer: layer.id, where: { 城市: '广州' } })
  assert.equal(out.ok, false)
  assert.match(out.message, /不是 DuckDB 大文件图层/)
  await engine.close()
})

test('webgis_layer_stats：行数 + 字段统计 + Top 分布', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  const out = await run('webgis_layer_stats', { layer: layer.id, field: 'city' })
  assert.equal(out.ok, true)
  assert.equal(out.value.count, 200)
  assert.equal(out.value.distinct, 2)
  assert.deepEqual(out.value.top.map((t) => t.count).sort((a, b) => b - a), [100, 100])
  // 只给行数
  const only = await run('webgis_layer_stats', { layer: layer.id })
  assert.equal(only.ok, true)
  assert.equal(only.value.count, 200)
  await engine.close()
})

test('webgis_sql_layer：__layer__ 占位 + 无经纬度结果给预览', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  const out = await run('webgis_sql_layer', {
    layer: layer.id,
    sql: 'SELECT city, count(*) AS c FROM __layer__ GROUP BY city ORDER BY c DESC',
  })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'no_geometry')
  assert.equal(out.rowCount, 2)
  assert.deepEqual(out.rows.map((r) => r.city).sort(), ['天河', '越秀'])
  await engine.close()
})

test('webgis_sql_layer：结果含经纬度 → 上图', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  const out = await run('webgis_sql_layer', {
    layer: layer.id,
    sql: "SELECT * FROM __layer__ WHERE city = '天河' LIMIT 10",
  })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.equal(out.featureCount, 10)
  assert.equal(state.layers[1].source, 'csv')
  await engine.close()
})

test('webgis_sql_layer：结果超 limit 拒绝', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  const out = await run('webgis_sql_layer', { layer: layer.id, sql: 'SELECT * FROM __layer__', limit: 10 })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'too_many')
  assert.equal(out.count, 200)
  await engine.close()
})

test('webgis_sql_layer：写操作/分号/注释被拒', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const layer = state.layers[0]
  for (const bad of [
    'DROP TABLE __layer__',
    'SELECT 1; DROP TABLE x',
    'SELECT * FROM __layer__ -- 注释',
  ]) {
    const out = await run('webgis_sql_layer', { layer: layer.id, sql: bad })
    assert.equal(out.ok, false, bad)
  }
  await engine.close()
})

test('webgis_filter_layer：polygon 围栏筛选（spatial ST_Within）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const base = state.layers[0]
  const poly = {
    type: 'Polygon',
    coordinates: [[[113.2, 23.2], [113.8, 23.2], [113.8, 23.8], [113.2, 23.8], [113.2, 23.2]]],
  }
  const out = await run('webgis_filter_layer', { layer: base.id, polygon: poly })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  // poi.csv 的 lon/lat 均来自同一 i%100：围住 i%100 ∈ (20,80) 区间
  assert.ok(out.count > 50 && out.count < 180)
  await engine.close()
})

test('webgis_filter_layer：polygonLayer 面图层作围栏', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'poi.csv') })
  const base = state.layers[0]
  const fence = makeResultLayer({
    id: 'fence', name: '围栏', source: 'dataset',
    geojson: featureCollection([polygon([[[113.2, 23.2], [113.8, 23.2], [113.8, 23.8], [113.2, 23.8], [113.2, 23.2]]])]),
  })
  state.layers.push(fence)
  const out = await run('webgis_filter_layer', { layer: base.id, polygonLayer: 'fence' })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.ok(out.count > 50)
  await engine.close()
})

test('dropLayerResources：GUI 右键删除路径也释放 DuckDB 内存表（#回归）', async () => {
  // 该函数是 GUI /webgis/layer-action remove 与 AI webgis_remove_layer 共用的释放钩子（进程级单例引擎）。
  const engine = getDuckDb()
  const t = engine.nextTableName()
  await engine.createTableFromCsv(t, join(dir, 'poi.csv'))
  assert.deepEqual(engine.tableNames(), [t])
  // fire-and-forget（void），轮询等 dropTable 完成
  dropLayerResources({ duckTable: t })
  for (let i = 0; i < 40 && engine.tableNames().length > 0; i++) await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(engine.tableNames(), [], 'GUI 删除后 DuckDB 表应被 DROP')
  // 无 duckTable 的图层调用不抛错
  dropLayerResources({ id: 'dataset' })
})

test('webgis_export_layer：导出 CSV / GeoJSON 到指定路径', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'city.csv') })
  const layer = state.layers[0]
  const csvPath = join(dir, 'out.csv')
  const csv = await run('webgis_export_layer', { layer: layer.id, format: 'csv', path: csvPath })
  assert.equal(csv.ok, true)
  const csvText = readFileSync(csvPath, 'utf8')
  assert.match(csvText, /name/)
  assert.match(csvText, /广州塔/)
  const gjPath = join(dir, 'out.json')
  const gj = await run('webgis_export_layer', { layer: layer.id, format: 'geojson', path: gjPath })
  assert.equal(gj.ok, true)
  const gjText = readFileSync(gjPath, 'utf8')
  assert.match(gjText, /FeatureCollection/)
  await engine.close()
})

// ---- 开源借鉴 Part A：几何列 + CRS / 错误分类 / 值归一化 ----

test('detectGeomColumn：打分优先（GEOMETRY 类型 > geom 名 > wkt 名）+ 显式 + 无几何', () => {
  assert.equal(detectGeomColumn([{ name: 'id', type: 'INTEGER' }]), null)
  assert.equal(detectGeomColumn([{ name: 'shape', type: 'GEOMETRY' }, { name: 'id', type: 'INTEGER' }]), 'shape')
  assert.equal(detectGeomColumn([{ name: 'geom', type: 'VARCHAR' }]), 'geom')
  assert.equal(detectGeomColumn([{ name: 'shape_wkt', type: 'VARCHAR' }]), 'shape_wkt')
  // GEOMETRY 类型优先于更贴名的 VARCHAR
  assert.equal(
    detectGeomColumn([
      { name: 'the_geom', type: 'VARCHAR' },
      { name: 'g', type: 'GEOMETRY' },
    ]),
    'g',
  )
  // 显式指定：命中即返回（不做打分）；不存在返回 null
  assert.equal(detectGeomColumn([{ name: 'shape_wkt', type: 'VARCHAR' }], 'shape_wkt'), 'shape_wkt')
  assert.equal(detectGeomColumn([{ name: 'shape_wkt', type: 'VARCHAR' }], 'nope'), null)
})

test('detectGeomFormat：三格式判定', () => {
  assert.equal(detectGeomFormat({ name: 'geom', type: 'GEOMETRY' }), 'geometry')
  assert.equal(detectGeomFormat({ name: 'geom', type: 'GEOMETRY(POINT,4326)' }), 'geometry')
  assert.equal(detectGeomFormat({ name: 'wkb', type: 'BLOB' }), 'wkb')
  assert.equal(detectGeomFormat({ name: 'data', type: 'BINARY' }), 'wkb')
  assert.equal(detectGeomFormat({ name: 'shape_wkt', type: 'VARCHAR' }), 'wkt')
  assert.equal(detectGeomFormat({ name: 'name', type: 'VARCHAR' }), null)
})

test('friendlyDuckError：各分类命中 + 默认原样', () => {
  assert.match(friendlyDuckError(new Error('DuckDB 查询超时（>30000ms）')), /建议：/)
  assert.match(friendlyDuckError(new Error('Parser Error: syntax error at or near')), /建议：/)
  assert.match(friendlyDuckError(new Error('Binder Error: No such column')), /建议：/)
  assert.match(friendlyDuckError(new Error('ST_Within not found')), /建议：/)
  assert.match(friendlyDuckError(new Error('Out of Memory: malloc failed')), /建议：/)
  assert.match(friendlyDuckError(new Error('IO Error: No such file')), /建议：/)
  assert.equal(friendlyDuckError(new Error('其他错误')), '其他错误')
})

test('normalizeValue：BigInt 安全/超界、Date、Buffer、对象、数组', () => {
  assert.equal(normalizeValue(123n), 123)
  assert.equal(normalizeValue(9007199254740993n), '9007199254740993') // 超界保精度
  assert.equal(normalizeValue(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z')
  assert.equal(normalizeValue(Buffer.from([1, 2, 3])), '[binary 3B]')
  assert.deepEqual(normalizeValue({ a: 1n, b: 'x' }), { a: 1, b: 'x' })
  assert.deepEqual(normalizeValue([1n, 'x']), [1, 'x'])
  assert.equal(normalizeValue('str'), 'str')
})

test('geometryRowsToGeoJSON：非法/空/坏 JSON 行跳过，几何不进 properties', () => {
  const fc = geometryRowsToGeoJSON([
    { __geometry: '{"type":"Point","coordinates":[113.3,23.1]}', name: 'a' },
    { __geometry: '{"type":"Point","coordinates":[null,23.1]}', name: 'nan' },
    { __geometry: 'not-json', name: 'bad' },
    { __geometry: null, name: 'null' },
    { __geometry: '{"type":"LineString","coordinates":[[113,23],[113.5,23.5]]}', name: 'line' },
  ], ['name'])
  assert.equal(fc.features.length, 2)
  assert.equal(fc.features[0].geometry.type, 'Point')
  assert.deepEqual(fc.features[0].properties, { name: 'a' })
  assert.equal(fc.features[1].geometry.type, 'LineString')
})

// 工具层：WKT 列自动上图 / 显式 geometryColumn / lon+lat 优先 / 几何图层筛选（需联网装一次 spatial）

test('webgis_load_csv：WKT 列自动识别 → 任意几何上图（无经纬度不报错）', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'wkt.csv') })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'small')
  assert.equal(out.featureCount, 3)
  const layer = state.layers[0]
  assert.equal(layer.duckGeom?.column, 'wkt')
  assert.equal(layer.duckGeom?.format, 'wkt')
  assert.equal(layer.duckGeom?.sourceCrs, null)
  assert.deepEqual(layer.geometryTypes.sort(), ['Point', 'Polygon'])
  await engine.close()
})

test('webgis_load_csv：显式 geometryColumn + sourceCrs（转 4326 上图）', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'wkt.csv'), geometryColumn: 'wkt', sourceCrs: 'EPSG:3857' })
  assert.equal(out.ok, true)
  assert.equal(state.layers[0].duckGeom?.column, 'wkt')
  assert.equal(state.layers[0].duckGeom?.sourceCrs, 'EPSG:3857')
  assert.equal(state.layers[0].geojson.features.length, 3)
  await engine.close()
})

test('webgis_load_csv：lon/lat + WKT 共存 → 默认走经纬度点（现状优先）', async () => {
  const engine = new DuckDbEngine()
  const { state, run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'lonlat_wkt.csv') })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'small')
  const layer = state.layers[0]
  assert.deepEqual(layer.duckCoords, { lon: 'lon', lat: 'lat' })
  assert.equal(layer.duckGeom, undefined)
  assert.deepEqual(layer.geometryTypes, ['Point'])
  await engine.close()
})

test('webgis_sql_layer：结果含 GEOMETRY 列 → 上图（几何列优先级 > 经纬度）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'wkt.csv') }) // 3 行 > 阈值 2 → 大文件保留 duckTable
  const base = state.layers[0]
  const out = await run('webgis_sql_layer', {
    layer: base.id,
    sql: 'SELECT ST_GeomFromText(wkt) AS geom, name FROM __layer__',
  })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'ok')
  assert.equal(out.featureCount, 3)
  assert.ok(state.layers[1].geometryTypes.includes('Point'))
  await engine.close()
})

test('webgis_filter_layer：几何图层 where 可用、bbox/radius/polygon 明确拒绝、产物继承 duckGeom', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const { state, run } = setupDuck(engine)
  await run('webgis_load_csv', { path: join(dir, 'wkt.csv') })
  const base = state.layers[0]
  assert.ok(base.duckGeom)
  // where 等于筛选照常（基于普通列）
  const w = await run('webgis_filter_layer', { layer: base.id, where: { name: 'a' } })
  assert.equal(w.ok, true)
  assert.equal(w.status, 'ok')
  assert.equal(w.count, 1)
  assert.equal(w.featureCount, 1)
  const result = state.layers[1]
  assert.deepEqual(result.duckGeom, base.duckGeom, 'filter 产物继承 duckGeom')
  // bbox / radius / polygon 明确拒绝
  const b = await run('webgis_filter_layer', { layer: base.id, bbox: { west: 113, south: 23, east: 114, north: 24 } })
  assert.equal(b.ok, false)
  assert.match(b.message, /几何列图层/)
  const r = await run('webgis_filter_layer', { layer: base.id, center: { lon: 113.5, lat: 23.5 }, radius: 1000 })
  assert.equal(r.ok, false)
  assert.match(r.message, /几何列图层/)
  const p = await run('webgis_filter_layer', {
    layer: base.id,
    polygon: { type: 'Polygon', coordinates: [[[113, 23], [114, 23], [114, 24], [113, 24], [113, 23]]] },
  })
  assert.equal(p.ok, false)
  await engine.close()
})

test('ingestBigGeojson：≤阈值返回 null；>阈值灌 duckTable + duckGeom + 抽样（SHP/GeoJSON/上传统一走 arrow）', async () => {
  const fc = featureCollection([
    polygon([[[113, 23], [113.1, 23], [113.1, 23.1], [113, 23]]], { name: 'a' }),
    polygon([[[113.2, 23.2], [113.3, 23.2], [113.3, 23.3], [113.2, 23.2]]], { name: 'b' }),
    polygon([[[113.5, 23.5], [113.6, 23.5], [113.6, 23.6], [113.5, 23.5]]], { name: 'c' }),
  ])
  // ≤阈值 → null（纯 geojson 路径）
  assert.equal(await ingestBigGeojson(fc, undefined, 100), null)
  // >阈值（minRows=1）→ 灌表
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const big = await ingestBigGeojson(fc, engine, 1)
  assert.ok(big, '应灌表')
  assert.equal(big.totalCount, 3)
  assert.equal(big.duckGeom.format, 'geometry')
  assert.equal(big.duckGeom.column, 'geom') // ST_Read 默认几何列
  assert.ok(big.duckTable)
  // 抽样 geojson 是 Polygon（≤threshold 2 行）
  assert.ok(big.geojson.features.length <= 2)
  assert.equal(big.geojson.features[0].geometry.type, 'Polygon')
  // duckTable 里数据可查
  const rows = await engine.run(`SELECT count(*) AS c FROM ${big.duckTable}`)
  assert.equal(Number(rows[0].c), 3)
  // 删除联动 DROP
  await engine.dropTable(big.duckTable)
  await engine.close()
})

test('loadCsvSourceData：小 CSV（≤阈值）全量物化，不留内存表', async () => {
  const engine = new DuckDbEngine()
  const data = await loadCsvSourceData(engine, join(dir, 'poi.csv')) // 200 行 ≤ 默认 5 万
  assert.equal(data.totalCount, 200)
  assert.equal(data.small, true)
  assert.equal(data.duckTable, undefined)
  assert.equal(data.geojson.features.length, 200)
  assert.equal(data.geojson.features[0].geometry.type, 'Point')
  await engine.close()
})

test('loadCsvSourceData：大 CSV 留 duckTable + duckCoords 抽样（load_dataset 防 OOM 路径）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const data = await loadCsvSourceData(engine, join(dir, 'poi.csv')) // 200 行 > 阈值 2
  assert.equal(data.totalCount, 200)
  assert.equal(data.small, false)
  assert.ok(data.duckTable, '大文件应保留内存表')
  assert.deepEqual(data.duckCoords, { lon: 'lon_wgs84', lat: 'lat_wgs84' })
  assert.ok(data.geojson.features.length <= 2, '抽样 ≤ 阈值')
  const rows = await engine.run(`SELECT count(*) AS c FROM ${data.duckTable}`)
  assert.equal(Number(rows[0].c), 200)
  await engine.dropTable(data.duckTable)
  await engine.close()
})

// ============================================================================
// 空间分析工具（webgis_spatial_filter / webgis_spatial_aggregate）—— Phase 1+2
// ============================================================================

/** haversine 球面距离（米），与工具 SQL 同式（R=6371008.8）。 */
function havDist(lon, lat, clon, clat) {
  const R = 6371008.8
  const rad = (d) => (d * Math.PI) / 180
  const a = Math.sin(rad(lat)) * Math.sin(rad(clat))
    + Math.cos(rad(lat)) * Math.cos(rad(clat)) * Math.cos(rad(lon) - rad(clon))
  return R * Math.acos(Math.max(-1, Math.min(1, a)))
}
/** poi.csv 200 行里离 (clon,clat) ≤ r 的点数（手算对照）。 */
function expectedDwithin(clon, clat, r) {
  let n = 0
  for (let i = 1; i <= 200; i++) {
    const lon = 113.0 + (i % 100) / 100
    const lat = 23.0 + (i % 100) / 100
    if (havDist(lon, lat, clon, clat) <= r) n++
  }
  return n
}

/** 落在 (113.205..113.795, 23.205..23.795) 内的 poi 点数（0.01 格：i%100 ∈ 21..79，两轮 = 118）。 */
const INSIDE_FENCE = 118

test('webgis_spatial_filter：bbox count_only 与 layer（scope/source/result/displayed）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId // 200 行 > 阈值 20
  const bb = { west: 113.5, south: 23.5, east: 114, north: 24 } // i%100 ∈ 50..99 → 100 行
  const cnt = await run('webgis_spatial_filter', { layer: id, mode: 'bbox', bbox: bb, output: 'count_only' })
  assert.equal(cnt.ok, true)
  assert.equal(cnt.output, 'count_only')
  assert.equal(cnt.scope, 'full_table')
  assert.equal(cnt.sourceCount, 200)
  assert.equal(cnt.displayedCount, 0)
  assert.equal(cnt.count, cnt.resultCount)
  assert.equal(cnt.resultCount, 100)

  const ly = await run('webgis_spatial_filter', { layer: id, mode: 'bbox', bbox: bb })
  assert.equal(ly.ok, true)
  assert.equal(ly.status, 'ok')
  assert.equal(ly.scope, 'sample_display') // 100 > 阈值 20 → 抽样显示
  assert.equal(ly.sourceCount, 200)
  assert.equal(ly.resultCount, 100)
  assert.equal(ly.displayedCount, ly.featureCount)
  assert.ok(ly.displayedCount > 0 && ly.displayedCount <= 20)
  assert.ok(ly.table)
  assert.match(ly.note, /全表 200 行上计算/)
  assert.match(ly.note, /抽样上图/)
  assert.ok(ly.layerId)

  // resultCount ≤ 阈值 → 全量上图（filtered）：lon 113.00~113.08 → i%100 ∈ 0..8 → 18 行
  const tiny = await run('webgis_spatial_filter', {
    layer: id, mode: 'bbox', bbox: { west: 113.0, south: 23.0, east: 113.08, north: 24 },
  })
  assert.equal(tiny.ok, true)
  assert.equal(tiny.scope, 'filtered')
  assert.equal(tiny.resultCount, 18)
  assert.equal(tiny.displayedCount, 18)
  await engine.close()
})

test('webgis_spatial_filter：dwithin 命中数与手算 haversine 对照', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  for (const [lon, lat, r] of [[113.4, 23.3, 3000], [113.5, 23.5, 800], [113.0, 23.0, 50000]]) {
    const exp = expectedDwithin(lon, lat, r)
    const out = await run('webgis_spatial_filter', {
      layer: id, mode: 'dwithin', center: { lon, lat }, distanceMeters: r, output: 'count_only',
    })
    assert.equal(out.ok, true, `center ${lon},${lat} r=${r}`)
    assert.equal(out.resultCount, exp, `center ${lon},${lat} r=${r}`)
  }
  await engine.close()
})

test('webgis_spatial_filter：within_polygon（GeoJSON 面，选中已知点）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  const poly = {
    type: 'Polygon',
    coordinates: [[[113.205, 23.205], [113.795, 23.205], [113.795, 23.795], [113.205, 23.795], [113.205, 23.205]]],
  }
  const out = await run('webgis_spatial_filter', { layer: id, mode: 'within_polygon', polygon: poly, output: 'count_only' })
  assert.equal(out.ok, true)
  assert.equal(out.resultCount, INSIDE_FENCE)
  await engine.close()
})

test('webgis_spatial_filter：intersects_layer duck↔duck 与 duck↔小 GeoJSON', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { state, run } = setupDuck(engine)
  const id1 = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  const id2 = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  // duck ↔ duck：两份相同点表 → 每点坐标都有匹配 → 全 200
  const dd = await run('webgis_spatial_filter', { layer: id1, mode: 'intersects_layer', otherLayerId: id2, output: 'count_only' })
  assert.equal(dd.ok, true)
  assert.equal(dd.resultCount, 200)
  // layer 输出路径（物化结果表 + 链式）
  const ddLayer = await run('webgis_spatial_filter', { layer: id1, mode: 'intersects_layer', otherLayerId: id2 })
  assert.equal(ddLayer.ok, true)
  assert.equal(ddLayer.status, 'ok')
  assert.equal(ddLayer.resultCount, 200)
  assert.equal(ddLayer.scope, 'sample_display') // 200 > 阈值 20
  assert.ok(ddLayer.table)
  assert.ok(ddLayer.layerId)

  // duck ↔ 纯 GeoJSON 面（无 duckTable，临时灌表后即删）
  const fence = makeResultLayer({
    id: 'fencegj', name: '围栏', source: 'dataset',
    geojson: featureCollection([polygon([[[113.205, 23.205], [113.795, 23.205], [113.795, 23.795], [113.205, 23.795], [113.205, 23.205]]])]),
  })
  state.layers.push(fence)
  const dg = await run('webgis_spatial_filter', { layer: id1, mode: 'intersects_layer', otherLayerId: 'fencegj', output: 'count_only' })
  assert.equal(dg.ok, true)
  assert.equal(dg.resultCount, INSIDE_FENCE)
  // 对方临时表应已 DROP（rid 表也已删）
  assert.ok(!engine.tableNames().some((n) => n.startsWith('duckdb_') && !state.layers.some((l) => l.duckTable === n)))
  await engine.close()
})

test('webgis_spatial_filter：duckGeom(WKT 点/面) within_polygon / intersects_layer（几何列路径）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const { state, run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'wkt.csv') })).layerId // 3 行 > 阈值 2 → duck
  const layer = state.layers.find((l) => l.id === id)
  assert.ok(layer.duckGeom)
  const poly = { type: 'Polygon', coordinates: [[[113, 23], [114, 23], [114, 24], [113, 24], [113, 23]]] }
  const w = await run('webgis_spatial_filter', { layer: id, mode: 'within_polygon', polygon: poly, output: 'count_only' })
  assert.equal(w.ok, true)
  assert.equal(w.resultCount, 3)

  const fence = makeResultLayer({
    id: 'polyfence', name: 'f', source: 'dataset',
    geojson: featureCollection([polygon([[[113, 23], [114, 23], [114, 24], [113, 24], [113, 23]]])]),
  })
  state.layers.push(fence)
  const it = await run('webgis_spatial_filter', { layer: id, mode: 'intersects_layer', otherLayerId: 'polyfence', output: 'count_only' })
  assert.equal(it.ok, true)
  assert.equal(it.resultCount, 3)
  await engine.close()
})

test('webgis_spatial_filter：duckGeom 纯点层 bbox/dwithin 可用（ST_X/ST_Y 路径）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'wkt_pts.csv') })).layerId
  const out = await run('webgis_spatial_filter', {
    layer: id, mode: 'bbox', bbox: { west: 113.35, south: 23.15, east: 113.45, north: 23.25 }, output: 'count_only',
  })
  assert.equal(out.ok, true)
  assert.equal(out.resultCount, 1)
  const d = await run('webgis_spatial_filter', {
    layer: id, mode: 'dwithin', center: { lon: 113.4, lat: 23.2 }, distanceMeters: 50, output: 'count_only',
  })
  assert.equal(d.ok, true)
  assert.equal(d.resultCount, 1)
  await engine.close()
})

test('webgis_spatial_filter：线/面/混合几何源 bbox 明确拒绝（非点源错误文案）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'wkt.csv') })).layerId // point+polygon 混合
  const out = await run('webgis_spatial_filter', { layer: id, mode: 'bbox', bbox: { west: 113, south: 23, east: 114, north: 24 } })
  assert.equal(out.ok, false)
  assert.match(out.message, /仅支持点状源/)
  await engine.close()
})

test('webgis_spatial_filter：超过加载上限(>20万) → too_many 未加载', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 50 })
  const { run } = setupDuck(engine)
  const out = await run('webgis_load_csv', { path: join(dir, 'poi_big.csv') }) // 200,020 行
  assert.equal(out.ok, true)
  const id = out.layerId
  const ly = await run('webgis_spatial_filter', { layer: id, mode: 'bbox', bbox: { west: 113, south: 23, east: 114, north: 24 } })
  assert.equal(ly.ok, true)
  assert.equal(ly.status, 'too_many')
  assert.ok(ly.resultCount > 200000)
  assert.equal(ly.displayedCount, 0)
  assert.equal(ly.scope, 'full_table')
  assert.match(ly.message, /未加载/)
  await engine.close()
})

test('webgis_spatial_aggregate：attribute 分组返回 rows（count/countDistinct）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  const out = await run('webgis_spatial_aggregate', { layer: id, kind: 'attribute', groupBy: 'city' })
  assert.equal(out.ok, true)
  assert.equal(out.scope, 'full_table')
  assert.equal(out.sourceCount, 200)
  assert.equal(out.resultCount, 2)
  assert.ok(Array.isArray(out.rows))
  assert.deepEqual(Object.fromEntries(out.rows.map((r) => [r.value, r.count])), { 天河: 100, 越秀: 100 })

  const out2 = await run('webgis_spatial_aggregate', {
    layer: id, kind: 'attribute', groupBy: 'city',
    metrics: [{ type: 'count' }, { type: 'countDistinct', field: 'name' }],
  })
  assert.equal(out2.ok, true)
  assert.equal(out2.rows[0].count, 100)
  assert.equal(out2.rows[0].distinct_name, 100)
  await engine.close()
})

test('webgis_spatial_aggregate：grid 网格计数正确（cell 多边形 + metrics，scope=full_table）', async () => {
  const engine = new DuckDbEngine({ papaparseThreshold: 20 })
  const { state, run } = setupDuck(engine)
  const id = (await run('webgis_load_csv', { path: join(dir, 'poi.csv') })).layerId
  const out = await run('webgis_spatial_aggregate', { layer: id, kind: 'grid', cellSizeMeters: 30000 })
  assert.equal(out.ok, true)
  assert.equal(out.scope, 'full_table')
  assert.equal(out.sourceCount, 200)
  const layer = state.layers[state.layers.length - 1]
  assert.equal(layer.id, out.layerId)
  assert.equal(layer.geojson.features.length, out.resultCount)
  assert.ok(layer.geojson.features.length > 0)
  assert.ok(layer.geojson.features.every((f) => f.geometry.type === 'Polygon'))
  const total = layer.geojson.features.reduce((s, f) => s + Number(f.properties.count), 0)
  assert.equal(total, 200, '格内 count 之和应等于全表行数')
  assert.match(out.note, /全表 200 行/)
  await engine.close()
})

// ============================================================================
// DuckDB spatial ST_Read（GDAL）矢量直读灌表（.shp/.gdb/.gpkg/.kml/.tab/.mif）
// 实测（duckdb 1.4.4 spatial）：ST_Read(KML) 几何列是 GEOMETRY 类型（非 WKB BLOB），
// ST_GeometryType(col) 直判族即可；ST_AsWKB 出的 WKB_BLOB 列才需 geomFamiliesOfWkb（ST_GeomFromWKB）。
// ============================================================================

test('createTableFromVector：小 KML ST_Read 建表 count=2 + 几何列检出 + WKB 变体判族', async () => {
  const engine = new DuckDbEngine()
  const t = engine.nextTableName()
  const info = await engine.createTableFromVector(t, join(dir, 'pts.kml'))
  assert.equal(info.count, 2)
  assert.ok(info.geomCol, 'ST_Read 应有几何列')
  assert.ok(['geometry', 'wkb'].includes(info.geomFormat ?? ''), `geomFormat=${info.geomFormat}`)
  assert.ok(info.columns.includes('__rid'), '建表应带稳定行号 __rid')
  // KML 属性列名大写（Name/Description）照常当属性。
  assert.ok(info.columns.includes('Name'))
  assert.ok(info.columns.includes('Description'))
  const geomCol = info.geomCol
  assert.ok(geomCol, '几何列名非空')
  // GEOMETRY 列直判族（本机 duckdb ST_Read 返回 GEOMETRY 类型）。
  if (info.geomFormat === 'geometry') {
    const fams = await geomFamiliesOf(engine, t, geomCol)
    assert.deepEqual(fams, ['point'])
  }
  // WKB BLOB 变体：ST_AsWKB 出一列 → geomFamiliesOfWkb 先 ST_GeomFromWKB 判族。
  const t2 = engine.nextTableName()
  await engine.exec(`CREATE TABLE ${t2} AS SELECT ST_AsWKB("${geomCol}") AS wk FROM ${t}`)
  const famsWkb = await geomFamiliesOfWkb(engine, t2, 'wk')
  assert.deepEqual(famsWkb, ['point'])
  await engine.dropTable(t)
  await engine.dropTable(t2)
  await engine.close()
})

test('loadVectorSourceData：小 KML 全量物化 2 个 Point 要素（坐标对上，不留内存表）', async () => {
  const engine = new DuckDbEngine()
  const data = await loadVectorSourceData(engine, join(dir, 'pts.kml'))
  assert.equal(data.totalCount, 2)
  assert.equal(data.small, true)
  assert.equal(data.duckTable, undefined)
  assert.equal(data.geojson.features.length, 2)
  const f = data.geojson.features[0]
  assert.equal(f.geometry.type, 'Point')
  assert.equal(f.geometry.coordinates[0], 113.3)
  assert.equal(f.geometry.coordinates[1], 23.1)
  assert.equal(f.properties.Name, 'Point1')
  assert.ok(data.duckGeom, '应返回 duckGeom 句柄')
  assert.equal(data.duckGeom?.sourceCrs, null)
  assert.deepEqual(engine.tableNames(), [], '小文件全量物化后不应留内存表')
  await engine.close()
})

test('createTableFromVector：路径不存在的 .gdb → 中文可懂错误', async () => {
  const engine = new DuckDbEngine()
  const t = engine.nextTableName()
  await assert.rejects(engine.createTableFromVector(t, join(dir, 'missing.gdb')), (err) => {
    assert.match(err.message, /无法打开矢量文件/, `实际错误：${err.message}`)
    return true
  })
  await engine.close()
})
