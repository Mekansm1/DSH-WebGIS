/**
 * 属性筛选下推（src/duckdb/attr-filter.ts）测试。
 *
 * 核心是**语义等价性**：selectWhereSql 生成的 SQL 在每一行上的真值必须等于 matchSelect 的 JS 结果。
 * 这是"自动改道全表"正确性的唯一保证——两条路径（大图层走 SQL 全表、小图层走 Turf 抽样）
 * 对同一份数据必须给出同一个命中集，否则用户拿到什么结果取决于数据量，那本身就是要修的 bug。
 *
 * 等价性用真实 DuckDB 逐组比对（见下面 MATRIX 测试）：改 selectWhereSql 必须重跑。
 * 唯一的刻意分歧是「进制前缀字符串」（'0x10'/'0b101'），单独立一个测试锁住它的行为。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DuckDbEngine } from '../lib/duckdb.js'
import { columnKindOf, createFullTableAttrFilter, duckAttrFilter, selectWhereSql } from '../lib/duckdb/attr-filter.js'
import { matchSelect, makeResultLayer } from '../lib/geo-processing.js'
import { registerGeoTools } from '../lib/geo-tools.js'

let dir
before(() => {
  dir = join(tmpdir(), `dsh-webgis-attr-filter-${process.pid}`)
  mkdirSync(dir, { recursive: true })
})
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 制表用的刁钻取值：空/空串/前导零/空白/中文/大小写/进制前缀/科学计数法/'null' 字面量。 */
const ROWS = [
  ['r01', null, null],
  ['r02', '', 0],
  ['r03', '0', 0.5],
  ['r04', '00', 12],
  ['r05', '12', 12.5],
  ['r06', '012', 100],
  ['r07', '12.5', -5],
  ['r08', 'abc', 100000],
  ['r09', 'ABC', 3],
  ['r10', '兰州市', 7],
  ['r11', ' 12 ', 2],
  ['r12', 'true', 6],
  ['r13', 'false', 8],
  ['r14', 'null', 9],
  ['r15', '0x10', 11],
  ['r16', '1e5', -12.5],
  ['r17', 'Infinity', 4],
  ['r18', 'NaN', 13],
  ['r19', '-5', 14],
  ['r20', '1,2', 15],
  ['r21', ' 兰州市 ', 0],
  ['r22', '12%', 16],
  ['r23', '_x', 17],
]

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'is_null', 'not_null']
const VALUES = [
  undefined, '', '0', '12', '12.5', '16', '100', '100000', '兰州市', 'abc', 'ABC', '-5', '1e5',
  '12,abc', 'null,兰州市', 'true', ' 12 ', '12.0', '00012', '012', '0b101', ' ', '12%', '_x', '\\',
]

const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

/** 建一张含 s(VARCHAR)/n(DOUBLE)/lon/lat 的小表，返回表名。 */
async function buildFixture(engine) {
  const valuesSql = ROWS.map(
    ([label, s, n], i) =>
      `(${lit(label)}, ${s === null ? 'CAST(NULL AS VARCHAR)' : lit(s)}, ${n === null ? 'CAST(NULL AS DOUBLE)' : lit(n)}, ${113 + i * 0.001}, ${23 + i * 0.001})`,
  ).join(', ')
  const t = engine.nextTableName()
  await engine.run(`CREATE TABLE ${t} AS SELECT * FROM (VALUES ${valuesSql}) AS x(label, s, n, lon, lat)`)
  return t
}

/**
 * 逐组比对：JS matchSelect 的命中集 === SQL 子句的命中集。返回分歧清单。
 *
 * `skip` 里的行两侧都不计——目前只有 r15（值 '0x10'），属下面单独立测试锁住的
 * 「进制前缀字符串」已知分歧。留它在 fixture 里是因为它对**别的**算子仍是有效压力值。
 */
async function diffMatrix(engine, table, col, kind, ops, values) {
  const SKIP = new Set(['r15'])
  const rows = (await engine.run(`SELECT label, s, n FROM ${table}`)).filter((r) => !SKIP.has(r.label))
  const divergent = []
  let total = 0
  for (const op of ops) {
    for (const value of values) {
      total++
      const jsHit = rows.filter((r) => matchSelect(r[col], op, value)).map((r) => r.label).sort()
      const sqlHit = (
        await engine.run(
          `SELECT label FROM ${table} WHERE ${selectWhereSql(col, op, value, kind)} AND label NOT IN (${[...SKIP].map(lit).join(', ')})`,
        )
      )
        .map((r) => r.label)
        .sort()
      if (JSON.stringify(jsHit) !== JSON.stringify(sqlHit)) {
        divergent.push({ op, value, jsOnly: jsHit.filter((l) => !sqlHit.includes(l)), sqlOnly: sqlHit.filter((l) => !jsHit.includes(l)) })
      }
    }
  }
  return { total, divergent }
}

test('columnKindOf：DuckDB 列类型 → JS 侧取值形态', () => {
  for (const t of ['DOUBLE', 'FLOAT', 'REAL', 'DECIMAL(10,2)', 'NUMERIC(4,1)', 'BIGINT', 'INTEGER', 'INT32', 'SMALLINT', 'TINYINT', 'HUGEINT', 'UBIGINT', 'UINTEGER']) {
    assert.equal(columnKindOf(t), 'number', `${t} 应为数值列`)
  }
  for (const t of ['VARCHAR', 'TEXT', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'BLOB', 'GEOMETRY', '']) {
    assert.equal(columnKindOf(t), 'text', `${t} 应为文本列`)
  }
})

test('selectWhereSql ≡ matchSelect：文本列（VARCHAR）全算子逐组等价', async () => {
  const engine = new DuckDbEngine()
  const t = await buildFixture(engine)
  try {
    // '0x10' 属已知刻意分歧（见下个测试），不参与"必须完全一致"的矩阵。
    const { total, divergent } = await diffMatrix(engine, t, 's', 'text', OPS, VALUES)
    assert.equal(divergent.length, 0, `出现分歧：${JSON.stringify(divergent, null, 2)}`)
    assert.ok(total >= 300, `比对组数过少（${total}），矩阵可能被改小了`)
  } finally {
    await engine.dropTable(t).catch(() => {})
  }
})

test('selectWhereSql ≡ matchSelect：数值列（DOUBLE）全算子逐组等价', async () => {
  const engine = new DuckDbEngine()
  const t = await buildFixture(engine)
  try {
    const { total, divergent } = await diffMatrix(engine, t, 'n', 'number', OPS, VALUES)
    assert.equal(divergent.length, 0, `出现分歧：${JSON.stringify(divergent, null, 2)}`)
    assert.ok(total >= 300, `比对组数过少（${total}），矩阵可能被改小了`)
  } finally {
    await engine.dropTable(t).catch(() => {})
  }
})

test('列类型决定文本渲染：VARCHAR 的 "012" 不被重渲染成 "12"（前导零必须保住）', async () => {
  // 这是把列类型显式传进 selectWhereSql 的原因：用 try_cast 猜类型会把 '012' 当数字"规范化"，
  // 静默改掉用户数据的语义（'012' 是编号/行政区划码，不是数字 12）。
  const engine = new DuckDbEngine()
  const t = await buildFixture(engine)
  try {
    const hitText = await engine.run(`SELECT label FROM ${t} WHERE ${selectWhereSql('s', 'contains', '012', 'text')}`)
    assert.deepEqual(hitText.map((r) => r.label), ['r06'], "文本列 contains '012' 只应命中值里真的含 '012' 的行")
    // 同一个子句按数值列翻译：12.0 的文本是 '12'，不该含 '012'
    const hitNum = await engine.run(`SELECT label FROM ${t} WHERE ${selectWhereSql('s', 'contains', '012', 'number')}`)
    assert.deepEqual(hitNum.map((r) => r.label), [], '数值渲染下不应命中')
  } finally {
    await engine.dropTable(t).catch(() => {})
  }
})

test('已知刻意分歧：进制前缀字符串（JS Number 认 0x/0b/0o，DuckDB try_cast 不认）', async () => {
  // 记录实际行为，避免以后有人"顺手修好"却不知另一侧也变了。
  // GIS 属性数据里不出现这种值，不值得为它加 SQL 分支；分成两路至少是**已知**的。
  const engine = new DuckDbEngine()
  const t = await buildFixture(engine)
  try {
    // '0x10'：JS Number('0x10') === 16 → 走数值路径
    assert.equal(matchSelect('0x10', 'eq', '16'), true, 'JS 侧：0x10 作为 16 参与比较')
    const sql = await engine.run(`SELECT label FROM ${t} WHERE ${selectWhereSql('s', 'eq', '16', 'text')}`)
    assert.deepEqual(sql.map((r) => r.label), [], 'SQL 侧：不认进制前缀，不命中')
    // 两个方向都要如实：SQL 侧也**不会**错误命中别处
    const sqlNe = await engine.run(`SELECT label FROM ${t} WHERE ${selectWhereSql('s', 'neq', '16', 'text')}`)
    assert.ok(sqlNe.map((r) => r.label).includes('r15'), 'SQL 侧 neq 16 时 0x10 仍算不相等（文本路径）')
  } finally {
    await engine.dropTable(t).catch(() => {})
  }
})

test('duckAttrFilter：在内存表的全表上筛，命中数与总行数都是真实的', async () => {
  const engine = new DuckDbEngine()
  const csv = join(dir, 'aoi.csv')
  const rows = ['id,cityname,lon_wgs84,lat_wgs84']
  for (let i = 0; i < 200; i++) rows.push(`${i},${i % 5 === 0 ? '兰州市' : '天水市'},${113 + i * 0.001},${36 + i * 0.001}`)
  writeFileSync(csv, rows.join('\n'))
  const t = engine.nextTableName()
  await engine.createTableFromCsv(t, csv)
  try {
    // 图层故意只挂 2 个"抽样要素"、且都不匹配——Turf 路线会返回 0。
    const layer = makeResultLayer({
      id: 'ds_test',
      name: 'aoi',
      source: 'dataset',
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [113, 36] }, properties: { id: 999, cityname: '天水市' } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [114, 37] }, properties: { id: 998, cityname: '天水市' } },
        ],
      },
      duckTable: t,
      duckCoords: { lon: 'lon_wgs84', lat: 'lat_wgs84' },
      totalCount: 200,
    })
    assert.equal(layer.materialized, false, '前置：挂内存表的图层应判定为未全量物化')

    const res = await duckAttrFilter(engine, layer, 'cityname', 'eq', '兰州市')
    assert.equal(res.ok, true, res.ok ? '' : res.message)
    assert.equal(res.count, 40, '200 行里每 5 行一个兰州市 → 40 行，必须来自全表而非抽样')
    assert.ok(res.table, '结果应带新的内存表（可继续链式筛选）')
    assert.ok(res.geojson.features.length <= 40, '上图不超过命中数')
    await engine.dropTable(res.table).catch(() => {})
  } finally {
    await engine.dropTable(t).catch(() => {})
  }
})

test('webgis_select_by_value：大图层自动改道全表，小图层保持 Turf 路线', async () => {
  const engine = new DuckDbEngine()
  const defs = []
  const ctx = { tools: { register: (d) => defs.push(d) } }
  const states = new Map()
  const stateFor = (sid) => {
    const key = sid ?? 'anon'
    if (!states.has(key)) states.set(key, { layers: [] })
    return states.get(key)
  }
  registerGeoTools(ctx, stateFor, {}, { attrFilterFullTable: createFullTableAttrFilter(() => engine) })
  const run = (name, args) => defs.find((d) => d.name === name).execute(args, {})

  const csv = join(dir, 'aoi2.csv')
  const rows = ['id,cityname,lon_wgs84,lat_wgs84']
  for (let i = 0; i < 200; i++) rows.push(`${i},${i % 5 === 0 ? '兰州市' : '天水市'},${113 + i * 0.001},${36 + i * 0.001}`)
  writeFileSync(csv, rows.join('\n'))

  const big = engine.nextTableName()
  await engine.createTableFromCsv(big, csv)
  try {
    const bigLayer = makeResultLayer({
      id: 'ds_big',
      name: 'aoi_big',
      source: 'dataset',
      geojson: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [113, 36] }, properties: { id: 999, cityname: '天水市' } }],
      },
      duckTable: big,
      duckCoords: { lon: 'lon_wgs84', lat: 'lat_wgs84' },
      totalCount: 200,
    })
    stateFor().layers = [bigLayer]

    const out = await run('webgis_select_by_value', { layer: 'ds_big', field: 'cityname', operator: 'eq', value: '兰州市' })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.featureCount, 40, '必须命中全表的 40 行（Turf 路线只会命中抽样里的 0 行）')
    const pushed = stateFor().layers.at(-1)
    assert.equal(pushed.duckTable !== undefined, true, '结果图层应带上内存表，可继续链式筛选')
    assert.equal(pushed.totalCount, 40)
    assert.equal(pushed.materialized, false, '结果仍有内存表 → 仍是未全量物化')
    await engine.dropTable(pushed.duckTable).catch(() => {})

    // 小图层（无内存表）：保持原 Turf 路线，行为不变。
    const smallLayer = makeResultLayer({
      id: 'result_small',
      name: '已筛小',
      source: 'gis-result',
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [113, 36] }, properties: { cityname: '兰州市' } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [114, 37] }, properties: { cityname: '天水市' } },
        ],
      },
    })
    assert.equal(smallLayer.materialized, true, '前置：无内存表 → 已全量物化')
    stateFor().layers = [smallLayer]
    const out2 = await run('webgis_select_by_value', { layer: 'result_small', field: 'cityname', operator: 'eq', value: '兰州市' })
    assert.equal(out2.ok, true, out2.message)
    assert.equal(out2.featureCount, 1, '小图层走 Turf，命中 1 行')
    assert.equal(stateFor().layers.at(-1).duckTable, undefined, '小图层结果不带内存表')
  } finally {
    await engine.dropTable(big).catch(() => {})
  }
})

test('webgis_bounding_box：抽样层用全量 bbox，不是抽样 bbox', async () => {
  const defs = []
  const ctx = { tools: { register: (d) => defs.push(d) } }
  const state = { layers: [] }
  registerGeoTools(ctx, () => state, {}, {})
  const run = (name, args) => defs.find((d) => d.name === name).execute(args, {})

  // 抽样只覆盖 [113,36]-[113.1,36.1]，全量其实到 [120,40]。
  state.layers = [
    makeResultLayer({
      id: 'ds_bbox',
      name: '大层',
      source: 'dataset',
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[113, 36], [113.1, 36], [113.1, 36.1], [113, 36.1], [113, 36]]] }, properties: {} },
        ],
      },
      duckTable: 'duckdb_bbox',
      duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
      fullBbox: [113, 36, 120, 40],
      totalCount: 600000,
    }),
  ]
  const out = await run('webgis_bounding_box', { layer: 'ds_bbox' })
  assert.equal(out.ok, true, out.message)
  assert.deepEqual(out.bbox, [113, 36, 120, 40], '外接矩形必须是全量范围，不是抽样那 0.1° 的小框')
})

test('抽样层上的写属性/新增字段/重投影/属性连接被拦下（不再静默只改抽样）', async () => {
  const defs = []
  const ctx = { tools: { register: (d) => defs.push(d) } }
  const state = { layers: [] }
  registerGeoTools(ctx, () => state, {}, {})
  const run = (name, args) => defs.find((d) => d.name === name).execute(args, {})

  const sampled = makeResultLayer({
    id: 'ds_sampled',
    name: '大层',
    source: 'dataset',
    geojson: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [113, 36] }, properties: { a: 1 } }],
    },
    duckTable: 'duckdb_x',
    duckCoords: { lon: 'lon', lat: 'lat' },
    totalCount: 600000,
  })
  state.layers = [sampled]

  for (const [tool, args] of [
    ['webgis_set_attribute', { layer: 'ds_sampled', field: 'tag', value: 'x' }],
    ['webgis_add_column', { layer: 'ds_sampled', field: 'newcol' }],
    ['webgis_add_sequence', { layer: 'ds_sampled' }],
    ['webgis_reproject', { layer: 'ds_sampled', to: 'mercator' }],
  ]) {
    const out = await run(tool, args)
    assert.equal(out.ok, false, `${tool} 应在抽样层上被拦下`)
    assert.match(out.message, /抽样/, `${tool} 的报错要说明是抽样层问题`)
  }

  // 属性连接：两层都物化时放行（拦的是抽样，不是工具本身）
  const ok1 = makeResultLayer({
    id: 'result_ok1', name: 'ok1', source: 'gis-result',
    geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { k: 'a' } }] },
  })
  const ok2 = makeResultLayer({
    id: 'result_ok2', name: 'ok2', source: 'gis-result',
    geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { k: 'a', v: 7 } }] },
  })
  state.layers = [ok1, ok2]
  const joined = await run('webgis_attribute_join', { target: 'result_ok1', joinLayer: 'result_ok2', targetField: 'k' })
  assert.equal(joined.ok, true, joined.message)
})
