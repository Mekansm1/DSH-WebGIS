import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFeatures,
  configFingerprint,
  detectGeometryColumn,
  effectiveCluster,
  formatSchemaText,
  normalizeColor,
  parseEwkbGeometry,
  resolveClusterMode,
  runQuery,
  sanitizeValue,
  scanSchema,
  validateSql,
} from '../lib/postgis.js'

// 真实库验证过的 EWKB（Point, SRID 4326）：select * 时几何列的值形态。
const EWKB_4326 = '0101000020E6100000A4703D0AD7A34440E17A14AE47E11A40'
// 构造的 EWKB（Point, SRID 3857），用于验证「非 4326 → 自动转换」路径。
const EWKB_3857 = '0101000020110F0000000000000000F83F0000000000000440'

// ---- 只读 SQL 校验 ----

test('validateSql: 接受 SELECT/WITH/EXPLAIN，去掉结尾分号', () => {
  assert.equal(validateSql('  select * from a '), 'select * from a')
  assert.equal(validateSql('WITH x AS (SELECT 1) SELECT * FROM x;'), 'WITH x AS (SELECT 1) SELECT * FROM x')
  assert.equal(validateSql('EXPLAIN SELECT 1'), 'EXPLAIN SELECT 1')
})

test('validateSql: 拒绝多语句/注释/非只读', () => {
  assert.throws(() => validateSql(''), /不能为空/)
  assert.throws(() => validateSql(123), /必须是字符串/)
  assert.throws(() => validateSql('SELECT 1; DROP TABLE a'), /单条查询/)
  assert.throws(() => validateSql('SELECT 1 -- comment'), /注释/)
  assert.throws(() => validateSql('SELECT /* c */ 1'), /注释/)
  assert.throws(() => validateSql('DROP TABLE a'), /只允许只读查询/)
  assert.throws(() => validateSql('INSERT INTO a VALUES (1)'), /只允许只读查询/)
  assert.throws(() => validateSql('UPDATE a SET b=1'), /只允许只读查询/)
  assert.throws(() => validateSql("SELECT '--not-comment'"), /注释/) // 字符串里也不行，安全优先
})

// ---- 几何解析 ----

test('parseEwkbGeometry: 解析 hex EWKB 得到几何与 SRID', () => {
  const g = parseEwkbGeometry(EWKB_4326)
  assert.ok(g)
  assert.equal(g.srid, 4326)
  assert.deepEqual(g.geometry, { type: 'Point', coordinates: [41.28, 6.72] })
  // SRID 3857
  const g2 = parseEwkbGeometry(EWKB_3857)
  assert.ok(g2)
  assert.equal(g2.srid, 3857)
  assert.equal(g2.geometry.type, 'Point')
  // Buffer 输入
  const g3 = parseEwkbGeometry(Buffer.from(EWKB_4326, 'hex'))
  assert.equal(g3?.srid, 4326)
})

test('parseEwkbGeometry: 拒绝非法输入', () => {
  assert.equal(parseEwkbGeometry(null), null)
  assert.equal(parseEwkbGeometry(''), null)
  assert.equal(parseEwkbGeometry('not hex at all'), null)
  assert.equal(parseEwkbGeometry('0123456789abcdef0123456789abcdef'), null) // 合法 hex 但非法 WKB
  assert.equal(parseEwkbGeometry('ABCDEF'), null) // 过短
})

// ---- 几何列检测 ----

test('detectGeometryColumn: 优先识别常用几何名列', () => {
  const fields = [{ name: 'lon' }, { name: 'geom' }]
  // geom 列是 hex EWKB
  let d = detectGeometryColumn(fields, [{ lon: 'x', geom: EWKB_4326 }])
  assert.deepEqual(d, { name: 'geom', mode: 'ewkb', srid: 4326 })
  // 无几何名匹配时，退回到任意形似几何的值
  const fields2 = [{ name: 'lon' }]
  d = detectGeometryColumn(fields2, [{ lon: EWKB_4326 }])
  assert.deepEqual(d, { name: 'lon', mode: 'ewkb', srid: 4326 })
})

test('detectGeometryColumn: 识别 ST_AsGeoJSON 输出的 JSON（字符串/对象）', () => {
  const gj = { type: 'Point', coordinates: [116, 31] }
  assert.deepEqual(
    detectGeometryColumn([{ name: 'geom' }], [{ geom: JSON.stringify(gj) }]),
    { name: 'geom', mode: 'geojson', srid: null },
  )
  // ::json 类型返回的对象
  assert.deepEqual(
    detectGeometryColumn([{ name: 'geom' }], [{ geom: gj }]),
    { name: 'geom', mode: 'geojson', srid: null },
  )
})

test('detectGeometryColumn: 无几何列返回 null（hex 形似但不合法不算）', () => {
  const fields = [{ name: 'token' }, { name: 'name' }]
  const d = detectGeometryColumn(fields, [
    { token: '0123456789abcdef0123456789abcdef', name: 'hello' },
  ])
  assert.equal(d, null)
})

// ---- FeatureCollection 构建 ----

test('buildFeatures: hex EWKB 行转要素，几何列不进属性，其余列保留', () => {
  const fc = buildFeatures(
    [
      { name: 'a', cityname: '合肥市', count: 3, geom: EWKB_4326 },
      { name: 'b', cityname: null, count: 0, geom: null }, // 无几何 → 跳过
    ],
    [{ name: 'name' }, { name: 'cityname' }, { name: 'count' }, { name: 'geom' }],
    { name: 'geom', mode: 'ewkb', srid: 4326 },
  )
  assert.equal(fc.features.length, 1)
  assert.equal(fc.features[0].geometry.type, 'Point')
  assert.deepEqual(fc.features[0].properties, { name: 'a', cityname: '合肥市', count: 3 })
})

test('buildFeatures: geojson 字符串行转要素', () => {
  const fc = buildFeatures(
    [{ name: 'x', geom: '{"type":"Point","coordinates":[116,31]}' }],
    [{ name: 'name' }, { name: 'geom' }],
    { name: 'geom', mode: 'geojson', srid: null },
  )
  assert.equal(fc.features.length, 1)
  assert.deepEqual(fc.features[0].geometry.coordinates, [116, 31])
})

test('sanitizeValue: Date/Buffer/bigint/null 规整', () => {
  assert.equal(sanitizeValue(null), null)
  assert.equal(sanitizeValue('s'), 's')
  assert.equal(sanitizeValue(1), 1)
  assert.equal(sanitizeValue(10n), 10)
  assert.equal(sanitizeValue(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z')
  assert.equal(sanitizeValue(Buffer.from('ab', 'hex')), 'ab')
  assert.deepEqual(sanitizeValue([1, 2]), [1, 2])
})

// ---- 结构扫描（假 pool） ----

function fakePool(dispatch) {
  return {
    async query(sql) {
      const lower = sql.toLowerCase()
      for (const [needle, result] of dispatch) {
        if (lower.includes(needle.toLowerCase())) return result
      }
      throw new Error(`假 pool 未匹配 SQL: ${sql.slice(0, 60)}`)
    },
  }
}

test('scanSchema: 汇总表/列/几何列', async () => {
  const pool = fakePool([
    ['FROM pg_class', {
      rows: [
        { schema: 'public', name: 'poi', kind: 'r', est_rows: '653600' },
        { schema: 'public', name: 'v_active', kind: 'v', est_rows: '0' },
      ],
    }],
    ['FROM geometry_columns', {
      rows: [
        { f_table_schema: 'public', f_table_name: 'poi', f_geometry_column: 'geom', type: 'GEOMETRY', srid: '4326', coord_dimension: '2' },
      ],
    }],
    ['format_type', { rows: [] }],
    ['FROM information_schema.columns', {
      rows: [
        { table_schema: 'public', table_name: 'poi', column_name: 'id', data_type: 'text', is_nullable: 'NO', is_pk: false },
        { table_schema: 'public', table_name: 'poi', column_name: 'geom', data_type: 'USER-DEFINED', is_nullable: 'YES', is_pk: false },
        { table_schema: 'public', table_name: 'v_active', column_name: 'name', data_type: 'character varying', is_nullable: 'YES', is_pk: false },
      ],
    }],
  ])
  const tables = await scanSchema(pool)
  assert.equal(tables.length, 2)
  const poi = tables.find((t) => t.name === 'poi')
  assert.equal(poi.estimatedRows, 653600)
  assert.equal(poi.columns.length, 2)
  assert.equal(poi.geometryColumns.length, 1)
  assert.equal(poi.geometryColumns[0].column, 'geom')
  assert.equal(poi.geometryColumns[0].srid, 4326)
  const v = tables.find((t) => t.name === 'v_active')
  assert.equal(v.kind, 'v')
  assert.equal(v.geometryColumns.length, 0)
})

test('scanSchema: 兜底识别未登记到 geometry_columns 的几何列（如 aoi.geom）', async () => {
  const pool = fakePool([
    ['FROM pg_class', { rows: [{ schema: 'public', name: 'aoi', kind: 'r', est_rows: '0' }] }],
    ['FROM geometry_columns', { rows: [] }],
    ['format_type', {
      rows: [
        { table_schema: 'public', table_name: 'aoi', column_name: 'geom', fmt_type: 'geometry(MultiPolygon,4326)' },
      ],
    }],
    ['FROM information_schema.columns', {
      rows: [
        { table_schema: 'public', table_name: 'aoi', column_name: 'geom', data_type: 'USER-DEFINED', is_nullable: 'YES', is_pk: false },
      ],
    }],
  ])
  const tables = await scanSchema(pool)
  const aoi = tables.find((t) => t.name === 'aoi')
  assert.ok(aoi)
  assert.equal(aoi.geometryColumns.length, 1)
  assert.equal(aoi.geometryColumns[0].column, 'geom')
  assert.equal(aoi.geometryColumns[0].type, 'MultiPolygon')
  assert.equal(aoi.geometryColumns[0].srid, 4326)
})

test('formatSchemaText: 包含表/列/几何列标记与查询提示', () => {
  const text = formatSchemaText([
    { schema: 'public', name: 'poi', kind: 'r', estimatedRows: 653600,
      columns: [
        { name: 'id', dataType: 'text', nullable: false, isPrimaryKey: true },
        { name: 'geom', dataType: 'USER-DEFINED', nullable: true, isPrimaryKey: false },
      ],
      geometryColumns: [{ tableSchema: 'public', tableName: 'poi', column: 'geom', type: 'Point', srid: 4326, dimension: 2 }] },
  ], { host: 'db:5432', database: 'postgres' })
  assert.match(text, /public\.poi/)
  assert.match(text, /约 653600 行/)
  assert.match(text, /id: text（主键）/)
  assert.match(text, /geom: geometry\(Point, SRID 4326\) ← 点要素·POI/)
  assert.match(text, /ST_AsGeoJSON\(ST_Transform/)
  // 语义提示：面要素=围栏 + 定位地名优先查面表
  assert.match(text, /## 使用提示/)
  assert.match(text, /面要素（Polygon\/MultiPolygon）表 = 区域\/小区\/行政区的地理围栏/)
})

// ---- 查询执行（假 pool） ----

/** 构造响应 count 先行 + 明细 +（可选）SRID 转换 三阶段查询的假 pool。 */
function makeRunPool({ count = 1, fields = [], rows = [], transform }) {
  const entries = [
    ['as __cnt', { fields: [{ name: '__cnt' }], rows: [{ __cnt: count }] }],
  ]
  if (transform) entries.push(['st_asgeojson(st_transform', transform])
  entries.push(['select', { fields, rows }])
  return fakePool(entries)
}

test('runQuery: 先 count，ST_AsGeoJSON 文本几何 → 要素', async () => {
  const gj = JSON.stringify({ type: 'Point', coordinates: [116, 31] })
  const pool = makeRunPool({
    count: 2,
    fields: [{ name: 'name' }, { name: 'geom' }],
    rows: [
      { name: 'a', geom: gj },
      { name: 'b', geom: gj },
    ],
  })
  const r = await runQuery(pool, 'select name, ST_AsGeoJSON(geom) as geom from poi')
  assert.equal(r.status, 'ok')
  assert.equal(r.count, 2)
  assert.equal(r.rowCount, 2)
  assert.equal(r.geometry.name, 'geom')
  assert.equal(r.features.features.length, 2)
  assert.deepEqual(r.features.features[0].properties, { name: 'a' })
})

test('runQuery: select * 的 hex EWKB（SRID 4326）→ 要素', async () => {
  const pool = makeRunPool({
    count: 1,
    fields: [{ name: 'name' }, { name: 'geom' }],
    rows: [{ name: 'a', geom: EWKB_4326 }],
  })
  const r = await runQuery(pool, 'select * from poi')
  assert.equal(r.geometry.mode, 'ewkb')
  assert.equal(r.geometry.srid, 4326)
  assert.equal(r.features.features.length, 1)
  assert.deepEqual(r.features.features[0].geometry.coordinates, [41.28, 6.72])
})

test('runQuery: 非 4326 EWKB → 自动包裹转换到 4326', async () => {
  const pool = makeRunPool({
    count: 1,
    // 包裹查询是 SELECT "name", ST_AsGeoJSON(ST_Transform("geom", 4326)) AS "geom" FROM (…)
    transform: { fields: [{ name: 'name' }, { name: 'geom' }], rows: [{ name: 'a', geom: '{"type":"Point","coordinates":[10,20]}' }] },
    // 原始 select * 返回 SRID 3857 的 hex
    fields: [{ name: 'name' }, { name: 'geom' }],
    rows: [{ name: 'a', geom: EWKB_3857 }],
  })
  const r = await runQuery(pool, 'select * from some_table')
  assert.match(r.note, /已自动转换到 4326/)
  assert.deepEqual(r.features.features[0].geometry.coordinates, [10, 20])
})

test('runQuery: 无几何列 → features=null，不建图层', async () => {
  const pool = makeRunPool({ count: 1, fields: [{ name: 'c' }], rows: [{ c: 42 }] })
  const r = await runQuery(pool, 'select count(*) as c from poi')
  assert.equal(r.geometry, null)
  assert.equal(r.features, null)
  assert.equal(r.rows[0].c, 42)
})

test('runQuery: 非法 SQL 抛错（count 前先校验）', async () => {
  const pool = fakePool([])
  await assert.rejects(runQuery(pool, 'delete from a'), /只允许只读查询/)
})

test('runQuery: count 超过 maxLoad → too_many，不拉数据', async () => {
  const pool = makeRunPool({ count: 300000 })
  const r = await runQuery(pool, 'select * from poi')
  assert.equal(r.status, 'too_many')
  assert.equal(r.count, 300000)
  assert.equal(r.maxLoad, 200000)
  assert.equal(r.rows.length, 0)
  assert.equal(r.features, null)
})

test('runQuery: 自定义 maxLoad 生效', async () => {
  const pool = makeRunPool({ count: 10 })
  const r = await runQuery(pool, 'select * from t', { maxLoad: 5 })
  assert.equal(r.status, 'too_many')
  assert.equal(r.maxLoad, 5)
})

// ---- 颜色归一化 ----

test('normalizeColor: 接受十六进制（带/不带 #、3/6 位）与颜色名（含中文）', () => {
  assert.equal(normalizeColor('#f97316'), '#f97316')
  assert.equal(normalizeColor('F97316'), '#f97316')
  assert.equal(normalizeColor('#f73'), '#ff7733')
  assert.equal(normalizeColor('red'), '#ef4444')
  assert.equal(normalizeColor('橙红'), '#f97316')
  assert.equal(normalizeColor('蓝'), '#3b82f6')
  assert.equal(normalizeColor('GREEN'), '#22c55e')
})

test('normalizeColor: 非法输入返回 undefined', () => {
  assert.equal(normalizeColor(''), undefined)
  assert.equal(normalizeColor(123), undefined)
  assert.equal(normalizeColor(null), undefined)
  assert.equal(normalizeColor('notacolor'), undefined)
  assert.equal(normalizeColor('#12345'), undefined) // 5 位非法
})

// ---- cluster 决策 ----

test('resolveClusterMode: 阈值驱动 auto', () => {
  const base = { askFrom: 50000, autoClusterFrom: 100000 }
  assert.deepEqual(resolveClusterMode({ count: 10000, param: 'auto', isPoint: true, ...base }), { mode: 'plain' })
  assert.deepEqual(resolveClusterMode({ count: 50000, param: 'auto', isPoint: true, ...base }), { mode: 'plain' })
  assert.deepEqual(resolveClusterMode({ count: 80000, param: 'auto', isPoint: true, ...base }), { mode: 'ask' })
  assert.deepEqual(resolveClusterMode({ count: 150000, param: 'auto', isPoint: true, ...base }), { mode: 'cluster' })
})

test('resolveClusterMode: 非点一律 plain；on/off 覆盖', () => {
  const base = { count: 150000, askFrom: 50000, autoClusterFrom: 100000 }
  assert.deepEqual(resolveClusterMode({ ...base, param: 'auto', isPoint: false }), { mode: 'plain' })
  assert.deepEqual(resolveClusterMode({ ...base, param: 'on', isPoint: false }), { mode: 'plain' })
  assert.deepEqual(resolveClusterMode({ ...base, param: 'on', isPoint: true }), { mode: 'cluster' })
  assert.deepEqual(resolveClusterMode({ ...base, param: 'off', isPoint: true }), { mode: 'plain' })
})

test('effectiveCluster: 默认值与覆盖', () => {
  assert.deepEqual(effectiveCluster(undefined), { askFrom: 50000, autoClusterFrom: 100000, maxLoad: 200000 })
  assert.deepEqual(effectiveCluster({ maxLoad: 300000 }), { askFrom: 50000, autoClusterFrom: 100000, maxLoad: 300000 })
})

test('configFingerprint: 去敏指纹不含密码，目标变则指纹变', () => {
  const base = { host: '192.168.1.252', port: 5432, database: 'postgres', user: 'admin', password: 'secret' }
  assert.equal(configFingerprint(base), configFingerprint({ ...base, password: 'other' }), '密码不应影响指纹（去敏）')
  assert.notEqual(configFingerprint(base), configFingerprint({ ...base, database: 'gis' }), '换库应改变指纹')
  assert.notEqual(configFingerprint(base), configFingerprint({ ...base, host: '10.0.0.1' }), '换主机应改变指纹')
  assert.notEqual(configFingerprint(base), configFingerprint({ ...base, port: 5433 }), '换端口应改变指纹')
})
