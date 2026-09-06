import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tableFromIPC } from 'apache-arrow'
import { DUCK_RID, arrowViewportWhere, getDuckDb } from '../lib/duckdb.js'
import { handleArrow } from '../lib/routes-state.js'

// ============================================================================
// /webgis/arrow 视口裁剪（bbox）单测：arrowViewportWhere 文本 + handleArrow 真 DuckDB 行为。
// duckCoords 路径免 spatial；duckGeom 路径需 DuckDB spatial（可用则测，缺失跳过）。
// ============================================================================

/** res mock：捕获 writeHead 状态与 end 体（arrow 二进制 / JSON 错误串）。 */
function makeRes() {
  const out = { status: 0, headers: null, body: null }
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers ?? null },
    end(body) { out.body = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body) },
  }
  return { res, out }
}

/** 轮询等 handleArrow 写响应（handleArrow 内部是 `return void (async…)()`，不向外抛 promise）。 */
function waitWritten(out) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (out.body != null) { clearInterval(timer); resolve() }
      else if (Date.now() - t0 > 10_000) { clearInterval(timer); reject(new Error('handleArrow 超时未写响应')) }
    }, 5)
  })
}

/** 直呼 handleArrow（state 只带一个 id 图层）；返回 { status, body(Buffer) }。 */
async function runArrow(params, layer) {
  const { res, out } = makeRes()
  const url = new URL(`http://local/webgis/arrow?${params}`)
  handleArrow({ method: 'GET', url: url.href }, res, url, '/webgis/arrow', undefined, { layers: [layer] }, undefined)
  await waitWritten(out)
  if (out.body && out.headers?.['content-type']?.includes('application/json')) {
    out.message = JSON.parse(out.body.toString('utf8')).message
  }
  return out
}

/** 把 arrow IPC 字节解码成表；非 200 返回 null。 */
function arrowTable(out) {
  if (out.status !== 200) return null
  return tableFromIPC(new Uint8Array(out.body))
}

/** 读出 geoarrow.point 表的所有坐标对（__geometry 子列），每行 [lon, lat]。 */
function pointCoords(table) {
  const g = table.getChild('__geometry')
  if (!g) return []
  const out = []
  for (let i = 0; i < table.numRows; i++) {
    const v = g.get(i)
    const arr = v && typeof v[Symbol.iterator] === 'function' ? Array.from(v) : [Number(v?.get(0)), Number(v?.get(1))]
    out.push(arr)
  }
  return out
}

const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]

let dir
let engine
/** duckCoords 点图层（duckTable 已建，8 行；bbox [0,0,10,10] 内 3 行：(0.1,0.1)/(5,5)/(9.9,9.9)）。 */
let coordsLayer
/** duckGeom 几何图层（duckTable 已建，5 个 POINT；bbox [0,0,10,10] 内 2 行：(1,1)/(5,5)）。 */
let geomLayer

before(async () => {
  dir = join(tmpdir(), `dsh-webgis-arrow-vp-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'pts.csv'),
    'lon,lat\n0.1,0.1\n5,5\n9.9,9.9\n-5,5\n15,5\n5,-5\n5,15\n12,12\n',
    'utf8',
  )
  engine = getDuckDb()
  const ct = engine.nextTableName()
  await engine.createTableFromCsv(ct, join(dir, 'pts.csv'))
  coordsLayer = { id: 'vp-coords', duckTable: ct, duckCoords: { lon: 'lon', lat: 'lat' } }
  // duckGeom 几何表（需 spatial；建表时首列 __rid，列 geom 为 GEOMETRY）。
  const hasSpatial = await engine.ensureSpatial()
  if (hasSpatial) {
    const gt = engine.nextTableName()
    await engine.exec(
      `CREATE TABLE ${gt} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, geom FROM (VALUES `
      + `(ST_GeomFromText('POINT(1 1)')), (ST_GeomFromText('POINT(5 5)')), (ST_GeomFromText('POINT(12 12)')), `
      + `(ST_GeomFromText('POINT(-5 5)')), (ST_GeomFromText('POINT(5 -5)'))) v(geom)`,
    )
    geomLayer = { id: 'vp-geom', duckTable: gt, duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null } }
  }
})

after(async () => {
  if (coordsLayer) await engine.dropTable(coordsLayer.duckTable).catch(() => {})
  if (geomLayer) await engine.dropTable(geomLayer.duckTable).catch(() => {})
  await engine.close()
})

// ---- ① arrowViewportWhere：duckCoords 与 duckGeom 的文本形态 ----

test('arrowViewportWhere：duckCoords → lon/lat BETWEEN（列名 quoteIdent）', () => {
  const sql = arrowViewportWhere({ coords: { lon: 'lon', lat: 'lat' } }, { west: 1, south: 2, east: 3, north: 4 })
  assert.equal(sql, '"lon" BETWEEN 1 AND 3 AND "lat" BETWEEN 2 AND 4')
  // 中文列名走双引号转义
  const cn = arrowViewportWhere({ coords: { lon: '经度', lat: '纬度' } }, { west: 0, south: 0, east: 10, north: 10 })
  assert.equal(cn, '"经度" BETWEEN 0 AND 10 AND "纬度" BETWEEN 0 AND 10')
})

test('arrowViewportWhere：duckGeom → ST_Intersects + ST_MakeEnvelope(xmin ymin xmax ymax)', () => {
  const sql = arrowViewportWhere(
    { geom: { column: 'geom', format: 'geometry', sourceCrs: null } },
    { west: 1, south: 2, east: 3, north: 4 },
  )
  assert.equal(sql, 'ST_Intersects("geom", ST_MakeEnvelope(1, 2, 3, 4))')
})

test('arrowViewportWhere：duckGeom sourceCrs≠4326 → buildGeomExpr 已包 ST_Transform', () => {
  const sql = arrowViewportWhere(
    { geom: { column: 'geom', format: 'wkt', sourceCrs: 'EPSG:3857' } },
    { west: 0, south: 0, east: 10, north: 10 },
  )
  assert.match(sql, /^ST_Intersects\(ST_Transform\(/)
  assert.match(sql, /ST_MakeEnvelope\(0, 0, 10, 10\)\)$/)
})

// ---- 非法 bbox：可行动 400 文案 ----

test('handleArrow：bbox 非法 → 400 可行动文案（缺数/超界/NaN/逗号格式）', async () => {
  const bad = [
    ['bbox=1,2,3', /bbox 参数需为 west,south,east,north 四个数值/],
    ['bbox=1,2,3,4,5', /bbox 参数需为 west,south,east,north 四个数值/],
    ['bbox=1,abc,3,4', /bbox 参数需为四个数值/],
    ['bbox=1,,3,4', /bbox 参数需为四个数值/],
    ['bbox=3,0,2,10', /west 需 ≤ east/],
    ['bbox=0,5,10,1', /south 需 ≤ north/],
  ]
  for (const [qs, re] of bad) {
    const out = await runArrow(`id=vp-coords&${qs}`, coordsLayer)
    assert.equal(out.status, 400, qs)
    assert.match(out.message, re, qs)
  }
})

// ---- duckCoords：bbox 视野内 + cap + 无 bbox 旧行为 ----

test('handleArrow duckCoords：bbox 只返回视野内点，cap 生效', async () => {
  const BOX = [0, 0, 10, 10]
  // cap=2（视野内 3 个 > 2 → 只出 2 个且都在框内）
  const capped = arrowTable(await runArrow('id=vp-coords&bbox=0,0,10,10&max=2', coordsLayer))
  assert.ok(capped, '应返回 200 arrow')
  assert.ok(capped.numRows >= 1 && capped.numRows <= 2, `cap 应限制 ≤2，实际 ${capped.numRows}`)
  for (const p of pointCoords(capped)) assert.ok(inBox(p, BOX), `视野外点泄漏：${JSON.stringify(p)}`)
  // cap=100 > 视野内 3 → DuckDB 自然返回全部视野内点
  const all = arrowTable(await runArrow('id=vp-coords&bbox=0,0,10,10&max=100', coordsLayer))
  assert.equal(all.numRows, 3, 'filtered<cap 时返回全部视野内点')
  for (const p of pointCoords(all)) assert.ok(inBox(p, BOX), `视野外点泄漏：${JSON.stringify(p)}`)
  // 不传 max（cap=0）→ 只按视野过滤、不抽样，仍返回全部视野内点
  const noCap = arrowTable(await runArrow('id=vp-coords&bbox=0,0,10,10', coordsLayer))
  assert.equal(noCap.numRows, 3)
})

test('handleArrow duckCoords：视野内无要素 → 合法空 arrow（200，0 行，不崩）', async () => {
  const out = await runArrow('id=vp-coords&bbox=50,50,60,60&max=2', coordsLayer)
  assert.equal(out.status, 200)
  const table = arrowTable(out)
  assert.ok(table, '应返回可解析 arrow')
  assert.equal(table.numRows, 0)
})

test('handleArrow duckCoords：无 bbox 行为不变（max=0 全表；max=n 抽样；跨 bbox 差异）', async () => {
  // max=0：抽全表 8 行
  const full = arrowTable(await runArrow('id=vp-coords&max=0', coordsLayer))
  assert.equal(full.numRows, 8)
  // 无 bbox + max=2：从全表抽样，可能有视野外点（旧路径语义）
  const sample = arrowTable(await runArrow('id=vp-coords&max=2', coordsLayer))
  assert.ok(sample.numRows >= 1 && sample.numRows <= 2)
})

// ---- duckGeom：bbox 视野裁剪（spatial）；spatial 缺失 → 可行动 500 ----

test('handleArrow duckGeom：spatial 未加载 → 500 可行动文案', async () => {
  // TS private 编译为普通属性：把单例临时标记 spatial 不可用，确定性触发 500 分支。
  // duckTable 用假名即可——ensureSpatial 在碰表之前就失败，不会真查。
  const fakeGeomLayer = { id: 'vp-geom-nospatial', duckTable: '__no_such_table__', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null } }
  const e = getDuckDb()
  const savedLoaded = e.spatialLoaded
  const savedTried = e.spatialTried
  try {
    e.spatialLoaded = false
    e.spatialTried = true
    const out = await runArrow('id=vp-geom-nospatial&bbox=0,0,10,10&max=2', fakeGeomLayer)
    assert.equal(out.status, 500)
    assert.match(out.message, /几何列 Arrow 需要 DuckDB spatial 扩展/)
  } finally {
    e.spatialLoaded = savedLoaded
    e.spatialTried = savedTried
  }
})

test('handleArrow duckGeom：bbox 只返回视野内几何，cap 生效；空视野合法空 arrow', async (t) => {
  if (!geomLayer) return t.skip('DuckDB spatial 不可用（离线且未缓存），跳过 duckGeom 用例')
  const capped = arrowTable(await runArrow('id=vp-geom&bbox=0,0,10,10&max=1', geomLayer))
  assert.ok(capped, '应返回 200 arrow')
  assert.ok(capped.numRows >= 1 && capped.numRows <= 1, `cap=1 应恰 1 行，实际 ${capped.numRows}`)
  // no max（cap=0）→ 视野内 2 个全部返回
  const all = arrowTable(await runArrow('id=vp-geom&bbox=0,0,10,10', geomLayer))
  assert.equal(all.numRows, 2, '视野内 [0,0,10,10] 应恰 (1,1)/(5,5) 两个')
  // 空视野 → 合法空 arrow（200，0 行）
  const empty = await runArrow('id=vp-geom&bbox=50,50,60,60&max=2', geomLayer)
  assert.equal(empty.status, 200)
  const emptyTable = arrowTable(empty)
  assert.ok(emptyTable, '空视野也应返回可解析 arrow')
  assert.equal(emptyTable.numRows, 0)
  // 无 bbox 旧路径 → 全表 5 个
  const full = arrowTable(await runArrow('id=vp-geom&max=0', geomLayer))
  assert.equal(full.numRows, 5)
})
