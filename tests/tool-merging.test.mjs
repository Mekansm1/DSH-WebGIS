import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDbEngine } from '../lib/duckdb.js'
import { makeSessionResolver, registerDuckDbTools } from '../lib/duckdb-tools.js'
import { registerGeoTools } from '../lib/geo-tools.js'
import { makeResultLayer } from '../lib/geo-processing.js'
import { summarizeFullField } from '../lib/duckdb/field-summary.js'
import { filterFullLocation } from '../lib/duckdb/location-filter.js'
import { createFullTableAttrFilter } from '../lib/duckdb/attr-filter.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'webgis-merge-test-'))
  const engine = new DuckDbEngine({ papaparseThreshold: 2 })
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }) })
  const csv = join(dir, 'data.csv')
  await writeFile(csv, 'id,lon,lat,group,value\n1,10,10,a,1\n2,11,11,a,2\n3,12,12,b,3\n4,13,13,b,4\n')
  const defs = []
  const state = { layers: [] }
  const ctx = { tools: { register: d => defs.push(d) } }
  registerDuckDbTools(ctx, () => state, { engine })
  registerGeoTools(ctx, () => state, {}, {
    attrFilterFullTable: createFullTableAttrFilter(() => engine),
    summarizeFullField: (layer, field, stat) => summarizeFullField(engine, layer, field, stat),
    filterFullLocation: (layer, relation, overlay, bbox) => filterFullLocation(engine, layer, relation, overlay, bbox),
  })
  const run = (name, args) => {
    const tool = defs.find(d => d.name === name)
    assert.ok(tool, name)
    return tool.execute(args, {})
  }
  const loaded = await run('webgis_load_dataset', { url: csv })
  assert.equal(loaded.ok, true, loaded.message)
  const full = state.layers[0]
  const fc = { type: 'FeatureCollection', features: [1,2,3,4].map(id => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [id + 9, id + 9] },
    properties: { id, lon: id + 9, lat: id + 9, group: id <= 2 ? 'a' : 'b', value: id },
  })) }
  const local = makeResultLayer({ id: 'local', name: 'local', geojson: fc, source: 'dataset' })
  state.layers.push(local)
  return { engine, dir, csv, state, defs, run, full, local }
}

test('合并注册：无退役工具，字段编辑拒绝缺参和互斥参数，不改变状态', async t => {
  const { defs, run, local } = await fixture(t)
  for (const name of ['webgis_load_csv', 'webgis_set_layer_color', 'webgis_add_column', 'webgis_add_sequence', 'webgis_set_attribute']) {
    assert.ok(!defs.some(d => d.name === name), name)
  }
  assert.equal(new Set(defs.map(d => d.name)).size, defs.length)
  const before = structuredClone(local)
  for (const args of [
    { action: 'set', field: 'tag' }, { action: 'add' },
    { action: 'add', field: 'tag', value: 1 },
    { action: 'sequence', start: 0.5 }, { action: 'set', field: 'tag', value: 1, filterValue: 'a' },
    { action: 'set', field: '__proto__', value: 'bad' },
  ]) {
    const result = await run('webgis_edit_field', { layer: 'local', ...args })
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.deepEqual(local, before)
  }
  assert.equal((await run('webgis_edit_field', { layer: 'local', action: 'set', field: 'flag', value: false })).ok, true)
  assert.equal(local.geojson.features[0].properties.flag, false)
})

test('七种字段统计：抽样全表与物化数据逐项对拍；未知字段明确失败', async t => {
  const { run, full, local } = await fixture(t)
  for (const stat of ['count','sum','avg','min','max','distinct','values']) {
    const a = await run('webgis_feature_summary', { layer: full.id, field: 'value', stat })
    const b = await run('webgis_feature_summary', { layer: local.id, field: 'value', stat })
    assert.equal(a.ok, true, a.message)
    assert.equal(b.ok, true, b.message)
    assert.deepEqual(a.value, b.value, stat)
    assert.equal(a.scope, 'full_table')
  }
  const a = await run('webgis_layer_stats', { layer: full.id, field: 'value' })
  const b = await run('webgis_layer_stats', { layer: local.id, field: 'value' })
  assert.equal(a.value.count, 4)
  for (const key of ['count','distinct','min','max','avg']) assert.deepEqual(a.value[key], b.value[key], key)
  assert.equal((await run('webgis_layer_stats', { layer: full.id, field: 'missing' })).ok, false)
  assert.equal((await run('webgis_feature_summary', { layer: full.id, field: 'missing', stat: 'sum' })).ok, false)
})

test('空间筛选和聚合：坐标表、普通点图层自动选路，对拍结果，临时表不泄漏', async t => {
  const { engine, run, full, local } = await fixture(t)
  const before = await engine.run('SHOW TABLES')
  for (const params of [
    { mode: 'bbox', bbox: { west: 9, south: 9, east: 11.5, north: 11.5 } },
    { mode: 'dwithin', center: { lon: 10, lat: 10 }, distanceMeters: 1000 },
    { mode: 'within_polygon', polygon: { type: 'Polygon', coordinates: [[[9,9],[11.5,9],[11.5,11.5],[9,11.5],[9,9]]] } },
  ]) {
    const a = await run('webgis_spatial_filter', { layer: full.id, ...params, output: 'count_only' })
    const b = await run('webgis_spatial_filter', { layer: local.id, ...params, output: 'count_only' })
    assert.equal(a.ok, true, a.message)
    assert.equal(b.ok, true, b.message)
    assert.equal(a.count, b.count)
  }
  for (const layer of [full, local]) {
    const out = await run('webgis_spatial_aggregate', { layer: layer.id, kind: 'attribute', groupBy: 'group' })
    assert.equal(out.ok, true, out.message)
    assert.deepEqual(out.rows.sort((a,b) => a.value.localeCompare(b.value)), [{ value: 'a', count: 2 }, { value: 'b', count: 2 }])
  }
  assert.deepEqual(await engine.run('SHOW TABLES'), before)
  delete full.duckCoords
  const detected = await run('webgis_spatial_filter', { layer: full.id, mode: 'bbox', bbox: { west: 9, south: 9, east: 20, north: 20 }, output: 'count_only' })
  assert.equal(detected.ok, true, detected.message)
  assert.equal(detected.count, 4)
})

test('位置筛选自动全表改道：三种关系对拍；参考层是抽样时也不漏要素', async t => {
  const { run, full, local, state } = await fixture(t)
  for (const relation of ['intersects', 'within', 'contains']) {
    const a = await run('webgis_select_by_location', { layer: full.id, relation, bbox: [9,9,11.5,11.5] })
    const b = await run('webgis_select_by_location', { layer: local.id, relation, bbox: [9,9,11.5,11.5] })
    assert.equal(a.ok, true, a.message)
    assert.equal(b.ok, true, b.message)
    const al = state.layers.find(l => l.id === a.layerId)
    const bl = state.layers.find(l => l.id === b.layerId)
    assert.equal(al.totalCount ?? al.featureCount, bl.featureCount, relation)
  }
  const matched = await run('webgis_select_by_location', { layer: local.id, overlay: full.id })
  assert.equal(matched.ok, true, matched.message)
  const layer = state.layers.find(l => l.id === matched.layerId)
  assert.equal(layer.totalCount, 4)
})

test('统一 CSV 参数：筛选后全表口径、limit 保留全表、通配、错误清理', async t => {
  const { engine, run, csv, dir, state } = await fixture(t)
  const filtered = await run('webgis_load_dataset', { url: csv, filter: { group: 'b' }, limit: 1 })
  assert.equal(filtered.ok, true, filtered.message)
  assert.equal(filtered.totalCount, 2)
  assert.equal(filtered.featureCount, 1)
  const layer = state.layers.find(l => l.id === filtered.layerId)
  assert.equal(layer.materialized, false)
  const stats = await run('webgis_feature_summary', { layer: layer.id, field: 'value', stat: 'sum' })
  assert.equal(stats.value, 7)
  const positions = await engine.readPointCoordinates(`SELECT lon,lat FROM ${layer.duckTable}`)
  assert.deepEqual([...positions], [12,12,13,13])
  const wildcard = await run('webgis_load_dataset', { url: join(dir, '*.csv') })
  assert.equal(wildcard.ok, true, wildcard.message)
  assert.equal(wildcard.totalCount, 4)
  const before = await engine.run('SHOW TABLES')
  for (const opts of [{ geometryColumn: 'missing' }, { lonField: 'no' }, { filter: { missing: 1 } }, { limit: 0 }]) {
    const out = await run('webgis_load_dataset', { url: csv, ...opts })
    assert.equal(out.ok, false, JSON.stringify(opts))
    assert.deepEqual(await engine.run('SHOW TABLES'), before)
  }
})

test('limit：小文件按源文件行序取前 N（可复现），且不丢可分析的全表', async t => {
  // 两个轴要分开钉：
  //   ① 取哪些行 —— 小文件是「取前 N 行」，由 __rid（源文件行序）定序，同一请求必须每次一致
  //      （上一版用 USING SAMPLE，三次调用给出三组不同行，预览不可复现）
  //   ② 丢不丢数据 —— limit **只截展示**，被截掉的其余行仍留在内存表里，筛选/统计仍看全量
  const { run, state, csv } = await fixture(t)
  const ids = []
  for (let i = 0; i < 3; i++) {
    const r = await run('webgis_load_dataset', { url: csv, filter: { group: 'b' }, limit: 1 })
    assert.equal(r.ok, true, r.message)
    assert.equal(r.featureCount, 1, 'limit 截展示')
    assert.equal(r.totalCount, 2, 'totalCount 仍是筛选后的全量')
    const layer = state.layers.find(l => l.id === r.layerId)
    assert.ok(layer.duckTable, '被 limit 截断时必须留表，否则其余行无法再分析')
    assert.equal(layer.materialized, false, 'geojson 只是一部分，不能算物化')
    // group=b 是源文件第 3、4 行 → 取前 1 行恒为第 3 行（id=3）
    // ⚠ 必须直接读 layer.geojson 看"显示了哪些行"：feature_summary 现在会自动改道全表
    // （T1 消除选择），它返回的是全量 2 行，不是展示的 1 行 —— 那是另一条断言（见下）。
    ids.push(layer.geojson.features.map(f => f.properties.id).join(','))
  }
  assert.deepEqual(ids, ['3', '3', '3'], `前 N 行必须可复现（按源文件行序），实际 ${JSON.stringify(ids)}`)
  // 被 limit 截掉的那一行仍参与统计（limit 只截展示，不丢可分析数据）
  const sum = await run('webgis_feature_summary', { layer: state.layers.at(-1).id, field: 'value', stat: 'sum' })
  assert.equal(sum.value, 7, 'group=b 的 3+4 都应参与统计')
})

test('坐标不可解析的行被丢弃时，不把整份小文件误判成抽样（图层仍可编辑）', async t => {
  // 旧判据 `small = ... && geojson.features.length === totalCount`：一行坐标解析失败被
  // rowsToGeoJSON 丢掉，就把普通小文件翻成"抽样"、留表、图层变成不可编辑，
  // 而守卫的报错还说"请先筛出全量再分析"——那正是它刚做的事。
  const dir = await mkdtemp(join(tmpdir(), 'webgis-merge-drop-'))
  const engine = new DuckDbEngine({ papaparseThreshold: 100 })
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }) })
  const csv = join(dir, 'bad.csv')
  await writeFile(csv, 'id,lon,lat,value\n1,10,10,1\n2,xx,yy,2\n3,12,12,3\n')
  const defs = []
  const state = { layers: [] }
  const ctx = { tools: { register: d => defs.push(d) } }
  registerDuckDbTools(ctx, () => state, { engine })
  registerGeoTools(ctx, () => state, {}, {
    attrFilterFullTable: createFullTableAttrFilter(() => engine),
    summarizeFullField: (layer, field, stat) => summarizeFullField(engine, layer, field, stat),
    filterFullLocation: (layer, relation, overlay, bbox) => filterFullLocation(engine, layer, relation, overlay, bbox),
  })
  const run = (name, args) => defs.find(d => d.name === name).execute(args, {})
  const out = await run('webgis_load_dataset', { url: csv })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.totalCount, 3)
  assert.equal(out.featureCount, 2, '1 行坐标不可解析')
  assert.match(out.message, /1 行坐标无法解析/, '丢弃行必须显式说出来，否则会被读成抽样')
  const layer = state.layers.find(l => l.id === out.layerId)
  assert.equal(layer.materialized, true, '丢弃的行本就不含信息，不是被隐藏的数据')
  assert.equal(layer.duckTable, undefined, '小文件不该因为丢行而留表')
  assert.equal(
    (await run('webgis_edit_field', { layer: layer.id, action: 'set', field: 'tag', value: 1 })).ok,
    true,
    '可编辑性不能被丢行破坏',
  )
})

test('远程 CSV 共用参数且先经过 SSRF 防护，失败不遗留图层', async t => {
  const { run, state } = await fixture(t)
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('id,x,y,group\n1,10,10,a\n2,11,11,b\n', { headers: { 'content-type': 'text/csv' } }) }
  t.after(() => { globalThis.fetch = originalFetch })
  const out = await run('webgis_load_dataset', { url: 'https://8.8.8.8/data.csv?download=1', lonField: 'x', latField: 'y', filter: { group: 'b' } })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.totalCount, 1)
  assert.equal(calls, 1)
  const before = state.layers.length
  const blocked = await run('webgis_load_dataset', { url: 'http://127.0.0.1/private.csv' })
  assert.equal(blocked.ok, false)
  assert.equal(calls, 1)
  assert.equal(state.layers.length, before)
})
test('加载 GeoJSON Feature/裸几何与投影 CSV；显式几何列优先，错误参数不被忽略', async t => {
  const { run, dir, state } = await fixture(t)
  for (const data of [
    { type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [10,10] } },
    { type: 'Point', coordinates: [11,11] },
  ]) {
    const url = join(dir, 'single.geojson')
    await writeFile(url, JSON.stringify(data))
    const out = await run('webgis_load_dataset', { url })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.featureCount, 1)
    assert.equal((await run('webgis_load_dataset', { url, limit: 1 })).ok, false)
  }
  const url = join(dir, 'projected.csv')
  await writeFile(url, 'id,x,y\n1,1113194.9079327357,1118889.9748579594\n')
  const out = await run('webgis_load_dataset', { url, lonField: 'x', latField: 'y', sourceCrs: 'EPSG:3857' })
  assert.equal(out.ok, true, out.message)
  const coordinates = state.layers.find(l => l.id === out.layerId).geojson.features[0].geometry.coordinates
  assert.ok(Math.abs(coordinates[0] - 10) < 1e-7)
  assert.ok(Math.abs(coordinates[1] - 10) < 1e-7)
})

test('普通层编辑后，组合筛选/空间聚合读取当前属性；聚合截断明确报告', async t => {
  const { run, local, full, state } = await fixture(t)
  await run('webgis_edit_field', { layer: local.id, action: 'set', field: 'group', value: 'edited' })
  const out = await run('webgis_filter_layer', { layer: local.id, where: { group: 'edited' }, limit: 1 })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.count, 4)
  const selected = state.layers.find(l => l.id === out.layerId)
  assert.equal(selected.materialized, false)
  const grid = await run('webgis_spatial_aggregate', { layer: full.id, kind: 'grid', cellSizeMeters: 100, maxCells: 1 })
  assert.equal(grid.ok, true, grid.message)
  assert.equal(grid.truncated, true)
  assert.equal(grid.totalGroups, 4)
  assert.equal(grid.featureCount, 1)
})

test('materialized 由行数推，不由 duckTable 推：留表但装着全部行 ≠ 抽样', async t => {
  // 回归守卫（旧行为：materialized = !duckTable）。
  // 筛选/围栏结果**既留表**（供链式筛选）**又把全部命中行放进 geojson** —— 用 !duckTable 推会把它
  // 误判成抽样，于是 16 个 requireMaterialized 守卫点全部拒绝，且错误消息让模型"先用
  // webgis_filter_layer 筛出全量再分析"——那正是它刚做的事。load → filter → buffer 成为死路。
  const { engine, state, run } = await fixture(t)
  const api = makeSessionResolver(engine, () => state)({})
  const fc = {
    type: 'FeatureCollection',
    features: [1, 2].map(id => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [id + 9, id + 9] },
      properties: { id, group: 'a', value: id },
    })),
  }
  // fullBbox 显式给，避免这条测试依赖真实表存在（也顺带钉住 ingestion 算过的 bbox 会被复用）
  const hit = await api.pushResult('筛选命中', fc, { duckTable: 'duckdb_x', totalCount: 2, fullBbox: null })
  const hitLayer = state.layers.find(l => l.id === hit.layerId)
  assert.equal(hitLayer.materialized, true, '全部命中行都在 geojson 里，就该算物化')
  assert.equal(hitLayer.duckTable, 'duckdb_x', '留表用于链式筛选这件事不受影响')
  assert.equal(
    (await run('webgis_edit_field', { layer: hitLayer.id, action: 'set', field: 'tag', value: 1 })).ok,
    true,
    '守卫必须放行（旧行为在这里拒绝，并把模型送回它刚做过的那一步）',
  )
  // 对照：geojson 只是抽样（表 60 万行、图上 2 行）→ 必须判为抽样并被守卫拒绝
  const sample = await api.pushResult('抽样显示', fc, { duckTable: 'duckdb_x', totalCount: 600_000, fullBbox: null })
  const sampleLayer = state.layers.find(l => l.id === sample.layerId)
  assert.equal(sampleLayer.materialized, false, '图上 2 行 / 全表 60 万行 = 抽样')
  assert.equal(
    (await run('webgis_edit_field', { layer: sampleLayer.id, action: 'set', field: 'tag', value: 1 })).ok,
    false,
    '抽样层必须继续被拒绝',
  )
})

test('空命中/非法条件清理临时表，抽样数据丢失时明确失败', async t => {
  const { run, local, full, engine, state, csv } = await fixture(t)
  const before = await engine.run('SHOW TABLES')
  for (const args of [
    { mode: 'bbox', bbox: { west: 20, south: 20, east: 0, north: 0 } },
    { mode: 'within_polygon', polygon: { type: 'Point', coordinates: [0,0] } },
    { mode: 'intersects_layer', otherLayerId: 'missing' },
  ]) {
    const out = await run('webgis_spatial_filter', { layer: local.id, ...args })
    assert.equal(out.ok, false)
    assert.deepEqual(await engine.run('SHOW TABLES'), before)
  }
  const empty = await run('webgis_load_dataset', { url: csv, filter: { group: null } })
  assert.equal(empty.ok, true, empty.message)
  assert.equal(empty.totalCount, 0)
  const single = state.layers.find(l => l.id === empty.layerId)
  assert.equal(single.featureCount, 0)
  // 回归守卫：空图层作 intersects_layer 的对方图层，必须**明确失败**。
  // 旧行为会返回一个自信的 `count:0 / scope:full_table`，模型据此向用户断言
  // 「两个图层没有任何相交要素」—— 看着正常的错答案。
  const emptyOverlay = await run('webgis_spatial_filter', {
    layer: local.id, mode: 'intersects_layer', otherLayerId: single.id, output: 'count_only',
  })
  assert.equal(emptyOverlay.ok, false, '空图层不能给出 count:0 的假全表结论')
  assert.match(emptyOverlay.message, /没有要素可相交/, '必须报"没有要素"，不能是别的失败原因')
  assert.deepEqual(await engine.run('SHOW TABLES'), before, '拦截必须发生在建临时表之前')
  // 回归守卫：0 要素图层的**列元数据已不存在**（geojson 建表只剩一列 geom），
  // 报错必须说真因「图层空」，不能是「字段 group 不存在」（其实有那列）、
  // Binder Error，或「需 spatial 扩展」（其实扩展好着）。模型会把这些错因照转给用户。
  for (const [tool, args] of [
    ['webgis_filter_layer', { where: { group: 'a' } }],
    ['webgis_layer_stats', { field: 'group' }],
    ['webgis_spatial_filter', { mode: 'bbox', bbox: { west: 0, south: 0, east: 20, north: 20 } }],
    ['webgis_feature_summary', { field: 'group', stat: 'count' }],
  ]) {
    const out = await run(tool, { layer: single.id, ...args })
    assert.equal(out.ok, false, `${tool} 应失败`)
    assert.match(out.message, /没有要素/, `${tool} 必须报真因，实际消息：${out.message}`)
  }
  delete full.duckTable
  for (const [tool, args] of [
    ['webgis_feature_summary', { field: 'value', stat: 'sum' }],
    ['webgis_layer_stats', { field: 'value' }],
    ['webgis_select_by_value', { field: 'value', operator: 'gt', value: '1' }],
    ['webgis_spatial_filter', { mode: 'bbox', bbox: { west: 0, south: 0, east: 20, north: 20 } }],
  ]) {
    assert.equal((await run(tool, { layer: full.id, ...args })).ok, false, tool)
  }
})
