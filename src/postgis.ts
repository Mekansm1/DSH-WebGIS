/**
 * PostgreSQL / PostGIS 访问层：只读查询 + 数据库结构扫描 + 几何列 → GeoJSON。
 *
 * 纯函数部分（validateSql / 几何检测 / FeatureCollection 构建 / schema 文本格式化）
 * 不依赖真实连接，便于 node 单测；连接相关函数（createPool / scanSchema / runQuery）
 * 接收 pool 参数，测试可用假 pool 注入。
 *
 * 关键设计：
 * - 查询强制只读：连接层 `-c default_transaction_read_only=on`（写操作在数据库层被拒），
 *   工具层再白名单 SELECT/WITH/EXPLAIN + 禁分号/注释，双层防御；
 * - 几何列识别靠「列名 + 值」启发式（不依赖固定 OID——实测不同 PostGIS 实例 geometry OID
 *   可能不同，如 16384 / 16394）：值可为 ST_AsGeoJSON 输出的 JSON（字符串/对象），
 *   或 PostGIS 文本协议返回的十六进制 EWKB（select * 常见）；
 * - EWKB 的 SRID 非 4326 时，用包裹子查询 `SELECT ST_AsGeoJSON(ST_Transform(col,4326)) FROM (原SQL) __w`
 *   自动转换到 WGS84（失败则提示用 ST_AsGeoJSON 显式转换）。
 */
import { Pool } from 'pg'
import wkx from 'wkx'
import type { Feature, FeatureCollection, Geometry as GeoGeometry } from 'geojson'

export interface PostgisConfig {
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  /** 连接超时毫秒，默认 5000。 */
  connectionTimeoutMs?: number
  /** 结果行数驱动的加载/聚合阈值。 */
  cluster?: PostgisClusterConfig
}

/** 加载阈值：结果行数决定「直接上图 / 询问是否聚合 / 自动聚合 / 拒绝」。 */
export interface PostgisClusterConfig {
  /** 结果行数 ≤ 此值直接加载（普通图层）。默认 50000。 */
  askFrom?: number
  /** 结果行数 > askFrom 且 ≤ 此值：询问用户是否聚合；> 此值且 ≤ maxLoad：自动聚合。默认 100000。 */
  autoClusterFrom?: number
  /** 结果行数超过此值不加载，返回建议。默认 200000。 */
  maxLoad?: number
}

export const DEFAULT_CLUSTER = { askFrom: 50000, autoClusterFrom: 100000, maxLoad: 200000 } as const

export function effectiveCluster(cfg: PostgisClusterConfig | undefined): Required<PostgisClusterConfig> {
  return {
    askFrom: cfg?.askFrom ?? DEFAULT_CLUSTER.askFrom,
    autoClusterFrom: cfg?.autoClusterFrom ?? DEFAULT_CLUSTER.autoClusterFrom,
    maxLoad: cfg?.maxLoad ?? DEFAULT_CLUSTER.maxLoad,
  }
}

export type ClusterParam = 'auto' | 'on' | 'off'
export type ClusterDecision = { mode: 'plain' } | { mode: 'cluster' } | { mode: 'ask' }

/** 按行数 + 参数 + 几何类型决定渲染方式。supercluster 只支持点要素，非点一律普通图层。 */
export function resolveClusterMode(opts: {
  count: number
  param: ClusterParam
  isPoint: boolean
  askFrom: number
  autoClusterFrom: number
}): ClusterDecision {
  if (!opts.isPoint) return { mode: 'plain' }
  if (opts.param === 'on') return { mode: 'cluster' }
  if (opts.param === 'off') return { mode: 'plain' }
  // auto
  if (opts.count <= opts.askFrom) return { mode: 'plain' }
  if (opts.count <= opts.autoClusterFrom) return { mode: 'ask' }
  return { mode: 'cluster' }
}

export interface DbColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
}

export interface DbGeometryColumn {
  tableSchema: string
  tableName: string
  column: string
  /** PostGIS 类型名：Point / LineString / Polygon / GEOMETRY / ... */
  type: string
  srid: number
  dimension: number
}

export interface DbTableInfo {
  schema: string
  name: string
  /** r=表 v=视图 m=物化视图 p=分区表 f=外部表 */
  kind: string
  estimatedRows: number
  columns: DbColumnInfo[]
  geometryColumns: DbGeometryColumn[]
}

const GEOMETRY_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon', 'GeometryCollection',
])

// ---- 连接 ----

/** 连接配置的稳定指纹，用于检测配置变更后重建 pool。含密码（重建 pool 时配置变了就重建）。 */
export function configKey(cfg: PostgisConfig): string {
  return JSON.stringify([cfg.host, cfg.port, cfg.database, cfg.user, cfg.password])
}

/**
 * 连接目标指纹（**去敏**，不含密码）：仅 host/port/database/user。
 * 用于库结构缓存的身份标识——不同库/账号/端口即视为不同结构，避免串用旧库缓存；
 * 密码变更不视为目标变化（同一库结构仍有效），也不把密码写进缓存文件。
 */
export function configFingerprint(cfg: PostgisConfig): string {
  return JSON.stringify([cfg.host ?? '', cfg.port ?? 5432, cfg.database ?? '', cfg.user ?? ''])
}

export function isConfigured(cfg: PostgisConfig): boolean {
  return Boolean(cfg.host && cfg.database)
}

export function createPool(cfg: PostgisConfig): Pool {
  return new Pool({
    host: cfg.host || 'localhost',
    port: cfg.port ?? 5432,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5000,
    // 只读 + 语句超时：任何写操作（INSERT/UPDATE/DELETE/DDL）都会在数据库层被拒绝
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    application_name: 'dsh-webgis',
  })
}

/** 测试连接：返回版本信息 + PostGIS 版本。 */
export async function testConnection(
  pool: Pool,
): Promise<{ ok: true; version: string; postgis: string } | { ok: false; message: string }> {
  try {
    const v = await pool.query('SELECT version() AS v')
    let postgis = ''
    try {
      const p = await pool.query('SELECT postgis_full_version() AS v')
      postgis = String((p.rows[0]?.v ?? '') ?? '').slice(0, 120)
    } catch {
      postgis = '（未安装 PostGIS）'
    }
    return { ok: true, version: String((v.rows[0]?.v ?? '') ?? '').slice(0, 120), postgis }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ---- 结构扫描 ----

/** 解析 format_type 输出的几何类型串：`geometry(MultiPolygon,4326)` → { type, srid }。 */
function parseGeometryFmt(fmt: string): { type: string; srid: number } | null {
  const s = fmt.trim()
  const m = /^geometry\((.*?)(?:,\s*(\d+))?\)$/i.exec(s)
  if (m) return { type: m[1] || 'GEOMETRY', srid: m[2] ? Number(m[2]) : 0 }
  const g = /^geography\((.*?)(?:,\s*(\d+))?\)$/i.exec(s)
  if (g) return { type: g[1] || 'GEOMETRY', srid: g[2] ? Number(g[2]) : 4326 }
  if (/^geometry$/i.test(s)) return { type: 'GEOMETRY', srid: 0 }
  if (/^geography$/i.test(s)) return { type: 'GEOMETRY', srid: 4326 }
  return null
}

/** 扫描数据库结构：用户表/视图 + 列 + 几何列。 */
export async function scanSchema(pool: Pool): Promise<DbTableInfo[]> {
  const tablesRes = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
           COALESCE(s.n_live_tup, 0) AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind IN ('r','v','m','p','f')
      AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY n.nspname, c.relname`)
  const tables: DbTableInfo[] = (tablesRes.rows as Array<{
    schema: string; name: string; kind: string; est_rows: string | number
  }>).map((r) => ({
    schema: r.schema,
    name: r.name,
    kind: r.kind,
    estimatedRows: Number(r.est_rows) || 0,
    columns: [],
    geometryColumns: [],
  }))

  // PostGIS 几何列（未装 PostGIS 时 geometry_columns 视图不存在，静默跳过）
  let geomCols: DbGeometryColumn[] = []
  try {
    const g = await pool.query(
      `SELECT f_table_schema, f_table_name, f_geometry_column, type, srid, coord_dimension FROM geometry_columns`,
    )
    geomCols = (g.rows as Array<{
      f_table_schema: string; f_table_name: string; f_geometry_column: string
      type: string; srid: string | number; coord_dimension: string | number
    }>).map((r) => ({
      tableSchema: r.f_table_schema,
      tableName: r.f_table_name,
      column: r.f_geometry_column,
      type: r.type,
      srid: Number(r.srid) || 0,
      dimension: Number(r.coord_dimension) || 0,
    }))
  } catch {
    /* no PostGIS */
  }

  // 兜底：geometry_columns 视图只登记了用 AddGeometryColumn/带 typmod 的几何列，
  // 裸 geometry/geography 列（如 aoi.geom）不在其中。用 format_type 从 pg_attribute 取真实类型。
  try {
    const fb = await pool.query(`
      SELECT c.table_schema, c.table_name, c.column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS fmt_type
      FROM information_schema.columns c
      JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name
      JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = c.table_schema
      JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attname = c.column_name
      WHERE c.udt_name IN ('geometry', 'geography')
        AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND a.attnum > 0 AND NOT a.attisdropped`)
    const known = new Set(geomCols.map((g) => `${g.tableSchema}.${g.tableName}.${g.column}`))
    for (const r of fb.rows as Array<{
      table_schema: string; table_name: string; column_name: string; fmt_type: string
    }>) {
      const key = `${r.table_schema}.${r.table_name}.${r.column_name}`
      if (known.has(key)) continue
      const p = parseGeometryFmt(r.fmt_type)
      if (!p) continue
      geomCols.push({
        tableSchema: r.table_schema,
        tableName: r.table_name,
        column: r.column_name,
        type: p.type,
        srid: p.srid,
        dimension: 0,
      })
      known.add(key)
    }
  } catch {
    /* 查询失败（无权限等）则跳过兜底 */
  }

  const colsRes = await pool.query(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
      EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name
          AND kcu.column_name = c.column_name
      ) AS is_pk
    FROM information_schema.columns c
    WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY c.table_schema, c.table_name, c.ordinal_position`)
  const colByTable = new Map<string, DbColumnInfo[]>()
  for (const r of colsRes.rows as Array<{
    table_schema: string; table_name: string; column_name: string
    data_type: string; is_nullable: string; is_pk: boolean
  }>) {
    const key = `${r.table_schema}.${r.table_name}`
    const item: DbColumnInfo = {
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === 'YES',
      isPrimaryKey: Boolean(r.is_pk),
    }
    const arr = colByTable.get(key)
    if (arr) arr.push(item)
    else colByTable.set(key, [item])
  }
  const geomByTable = new Map<string, DbGeometryColumn[]>()
  for (const g of geomCols) {
    const key = `${g.tableSchema}.${g.tableName}`
    const arr = geomByTable.get(key)
    if (arr) arr.push(g)
    else geomByTable.set(key, [g])
  }
  for (const t of tables) {
    const key = `${t.schema}.${t.name}`
    t.columns = colByTable.get(key) ?? []
    t.geometryColumns = geomByTable.get(key) ?? []
  }
  return tables
}

/** 几何类型 → 用途语义（帮模型理解点/线/面的业务含义）。 */
function geometryKindLabel(type: string): string {
  const t = type.toLowerCase()
  if (t.includes('polygon')) return '面要素·区域围栏（小区/行政区等）'
  if (t.includes('linestring')) return '线要素·道路/边界'
  if (t.includes('point')) return '点要素·POI'
  return '几何要素'
}

/** schema 文本末尾的使用提示：引导模型在"定位地名"场景选对面表。 */
const GEOM_HINTS = [
  '- 面要素（Polygon/MultiPolygon）表 = 区域/小区/行政区的地理围栏。用户说「缩放到某小区/某地/某范围」时，应先在面要素表按名称查围栏并加载（如 SELECT name, geom FROM aoi WHERE name LIKE \'%关键词%\'），加载围栏会自动缩放到其边界；点要素（POI）表只有点、没有围栏。',
  '- 地名可能跨城市重名（同名多行），用城市字段（cityname/pname/adname 等）+ 名称一起过滤，或先 count 确认再加载。',
  '- 同一地名可能同时有 POI 点（点表）与 AOI 围栏（面表）：要围栏查面表，要点位查点表。',
]

/** 把结构格式化成给模型参考的文本。 */
export function formatSchemaText(tables: DbTableInfo[], opts?: { host?: string; database?: string }): string {
  const kindLabel: Record<string, string> = { r: '表', v: '视图', m: '物化视图', p: '分区表', f: '外部表' }
  const lines: string[] = []
  const where = opts?.database ? `库 ${opts.database}` : ''
  lines.push(`# 数据库结构（PostgreSQL${opts?.host ? ` @ ${opts.host}` : ''}${where ? `，${where}` : ''}）`)
  lines.push(
    `共 ${tables.length} 个表/视图。查询提示：返回几何用 ST_AsGeoJSON(ST_Transform(几何列, 4326)) AS geom；`
    + '表名/列名含大写、中文或保留字时用双引号包裹；只读查询。',
  )
  for (const t of tables) {
    const kind = kindLabel[t.kind] ?? t.kind
    const est = t.estimatedRows > 0 ? `（约 ${t.estimatedRows} 行）` : t.estimatedRows === 0 ? '（行数未统计）' : ''
    lines.push(`\n## ${t.schema}.${t.name} [${kind}]${est}`)
    if (t.columns.length === 0) {
      lines.push('- (无列信息)')
      continue
    }
    for (const c of t.columns) {
      const geom = t.geometryColumns.find((g) => g.column === c.name)
      const pk = c.isPrimaryKey ? '（主键）' : ''
      const nullable = c.nullable ? '' : ' 非空'
      if (geom) {
        const srid = geom.srid ? `SRID ${geom.srid}` : 'SRID 未知'
        lines.push(`- ${c.name}: geometry(${geom.type}, ${srid})${pk} ← ${geometryKindLabel(geom.type)}${nullable}`)
      } else {
        lines.push(`- ${c.name}: ${c.dataType}${pk}${nullable}`)
      }
    }
  }
  lines.push('', '## 使用提示', ...GEOM_HINTS)
  return lines.join('\n')
}

// ---- 只读 SQL 校验 ----

/** 校验 SQL 只读且为单条查询，返回去掉结尾分号的规范化语句；非法抛错。 */
export function validateSql(sql: unknown): string {
  if (typeof sql !== 'string') throw new Error('sql 必须是字符串')
  let s = sql.trim()
  if (!s) throw new Error('sql 不能为空')
  s = s.replace(/;+\s*$/, '')
  if (/;/.test(s)) throw new Error('只允许单条查询（不允许分号分隔的多语句）')
  if (s.includes('--')) throw new Error('SQL 里不允许使用注释（--）')
  if (/\/\*/.test(s)) throw new Error('SQL 里不允许使用注释（/* */）')
  if (!/^\s*(select|with|explain)\b/i.test(s)) throw new Error('只允许只读查询（SELECT / WITH / EXPLAIN）')
  return s
}

// ---- 几何列检测与解析 ----

/** 检测出的几何列。mode：'geojson'=值已是 GeoJSON；'ewkb'=PostGIS 十六进制 EWKB。 */
export interface DetectedGeometry {
  name: string
  mode: 'geojson' | 'ewkb'
  /** EWKB 头里的 SRID；geojson 模式为 null。 */
  srid: number | null
}

const GEOM_FIELD_NAMES = new Set(['geom', 'the_geom', 'geography', 'geog', 'shape', 'geometry', 'wkb_geometry'])
const GEOM_NAME_RE = /\b(the_geom|geom|geog|geography|shape|geometry|wkb)\b/i

function isGeomName(name: string): boolean {
  const n = name.toLowerCase()
  return GEOM_FIELD_NAMES.has(n) || GEOM_NAME_RE.test(n)
}

function isGeoJsonGeometry(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false
  const g = o as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  if (typeof g.type !== 'string' || !GEOMETRY_TYPES.has(g.type)) return false
  if (g.type === 'GeometryCollection') return Array.isArray(g.geometries)
  return Array.isArray(g.coordinates)
}

/** 解析 PostGIS 十六进制 EWKB → GeoJSON 几何 + SRID；非法返回 null。 */
export function parseEwkbGeometry(
  v: unknown,
): { geometry: GeoGeometry; srid: number | null } | null {
  let hex: string | null = null
  if (typeof v === 'string') hex = v.trim()
  else if (Buffer.isBuffer(v)) hex = v.toString('hex')
  else if (v instanceof Uint8Array) hex = Buffer.from(v).toString('hex')
  if (!hex) return null
  // EWKB 首字节是字节序标记（00=大端 / 01=小端），后面至少 15 位十六进制
  if (!/^[01][0-9a-fA-F]{15,}$/.test(hex)) return null
  try {
    const g = wkx.Geometry.parse(Buffer.from(hex, 'hex'))
    // wkx 自带类型把 toGeoJSON 声明为 {}，实际可能是 null（非法/空几何）
    const gj = g.toGeoJSON() as { type?: unknown } | null
    if (!gj || typeof gj.type !== 'string') return null
    // wkx 的 srid 是 number；无 SRID 标记时为 0
    return { geometry: gj as GeoGeometry, srid: g.srid || null }
  } catch {
    return null
  }
}

/** 从若干行中检测几何列（几何名/常用名列优先，其次任一列的值形似几何）。 */
export function detectGeometryColumn(
  fields: Array<{ name: string }>,
  rows: Array<Record<string, unknown>>,
): DetectedGeometry | null {
  const ordered = fields
    .map((f) => f.name)
    .sort((a, b) => (isGeomName(a) ? 0 : 1) - (isGeomName(b) ? 0 : 1))
  const sample = rows.slice(0, 10)
  for (const name of ordered) {
    let ewkb: DetectedGeometry | null = null
    for (const row of sample) {
      const v = row?.[name]
      if (v && typeof v === 'object' && isGeoJsonGeometry(v)) {
        return { name, mode: 'geojson', srid: null }
      }
      if (typeof v === 'string' && v.trim().startsWith('{')) {
        try {
          const o = JSON.parse(v)
          if (isGeoJsonGeometry(o)) return { name, mode: 'geojson', srid: null }
        } catch {
          /* not json */
        }
      }
      if (!ewkb) {
        const parsed = parseEwkbGeometry(v)
        if (parsed) ewkb = { name, mode: 'ewkb', srid: parsed.srid }
      }
    }
    if (ewkb) return ewkb
  }
  return null
}

// ---- 查询执行与 GeoJSON 构建 ----

export interface RunQueryResult {
  /** 'ok'=正常；'too_many'=行数超过 maxLoad，未拉取数据。 */
  status: 'ok' | 'too_many'
  /** 查询将返回的行数（count 先行统计；EXPLAIN 为实际行数）。 */
  count: number
  /** 行数上限（too_many 时为触发的上限）。 */
  maxLoad: number
  rows: Array<Record<string, unknown>>
  fields: Array<{ name: string }>
  rowCount: number
  /** 检测到的几何列；无几何列时为 null。 */
  geometry: DetectedGeometry | null
  /** 转换出的 FeatureCollection；无几何或全部为空时为 null。 */
  features: FeatureCollection | null
  /** 说明文字（SRID 转换等）。 */
  note: string
}

/**
 * 执行只读查询，几何列自动转 FeatureCollection。
 * count 先行：先统计将返回的行数，超过 maxLoad 则不拉数据（防 `select * from 大表` 拉爆宿主内存/地图）。
 */
export async function runQuery(pool: Pool, rawSql: string, opts?: { maxLoad?: number }): Promise<RunQueryResult> {
  const sql = validateSql(rawSql)
  const maxLoad = opts?.maxLoad ?? DEFAULT_CLUSTER.maxLoad
  const isExplain = /^\s*explain\b/i.test(sql)

  // count 先行（EXPLAIN 不适用，跳过）：超限直接返回，不拉数据
  let count = 0
  if (!isExplain) {
    count = await countRows(pool, sql)
    if (count > maxLoad) {
      return {
        status: 'too_many',
        count,
        maxLoad,
        rows: [],
        fields: [],
        rowCount: 0,
        geometry: null,
        features: null,
        note: `结果 ${count} 行超过加载上限 ${maxLoad}`,
      }
    }
  }

  const res = await pool.query(sql)
  const fields = (res.fields ?? []).map((f) => ({ name: f.name }))
  const rows = (res.rows ?? []) as Array<Record<string, unknown>>
  if (isExplain) count = rows.length
  const geometry = detectGeometryColumn(fields, rows)
  if (!geometry) {
    return { status: 'ok', count, maxLoad, rows, fields, rowCount: rows.length, geometry: null, features: null, note: '' }
  }

  let sourceRows = rows
  let note = ''
  // 原始 EWKB 且 SRID 非 4326 → 用包裹子查询自动转换到 WGS84
  if (geometry.mode === 'ewkb' && geometry.srid != null && geometry.srid !== 4326 && geometry.srid !== 0) {
    try {
      sourceRows = await transformToWgs84(pool, sql, fields, geometry.name)
      geometry.mode = 'geojson'
      note = `几何列 ${geometry.name} 的 SRID=${geometry.srid}，已自动转换到 4326`
    } catch {
      note = `几何列 ${geometry.name} 的 SRID=${geometry.srid} 非 4326 且自动转换失败，`
        + `建议改用 ST_AsGeoJSON(ST_Transform(${geometry.name}, 4326)) 重新查询`
    }
  }

  const features = buildFeatures(sourceRows, fields, geometry)
  return { status: 'ok', count, maxLoad, rows, fields, rowCount: rows.length, geometry, features, note }
}

/** 统计查询将返回的行数：`SELECT count(*) FROM (<sql>) __t`。 */
async function countRows(pool: Pool, sql: string): Promise<number> {
  const res = await pool.query(`SELECT count(*) AS __cnt FROM (${sql}) __t`)
  const v = (res.rows?.[0] as Record<string, unknown> | undefined)?.__cnt
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 包裹原查询，把几何列用 ST_AsGeoJSON(ST_Transform(col,4326)) 输出。失败抛错（上层回退）。 */
async function transformToWgs84(
  pool: Pool,
  originalSql: string,
  fields: Array<{ name: string }>,
  geomName: string,
): Promise<Array<Record<string, unknown>>> {
  const cols = fields.map((f) =>
    f.name === geomName
      ? `ST_AsGeoJSON(ST_Transform(${quoteIdent(geomName)}, 4326)) AS ${quoteIdent(geomName)}`
      : quoteIdent(f.name),
  )
  const wrapped = `SELECT ${cols.join(', ')} FROM (${originalSql}) __w`
  const res = await pool.query(wrapped)
  return (res.rows ?? []) as Array<Record<string, unknown>>
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** 把查询行转换为 FeatureCollection（几何列 → geometry，其余列 → 属性）。 */
export function buildFeatures(
  rows: Array<Record<string, unknown>>,
  fields: Array<{ name: string }>,
  geometry: DetectedGeometry,
): FeatureCollection {
  const features: Feature[] = []
  for (const row of rows) {
    const v = row[geometry.name]
    let geomObj: GeoGeometry | null = null
    if (geometry.mode === 'geojson') {
      if (typeof v === 'string') {
        try {
          const o = JSON.parse(v)
          if (isGeoJsonGeometry(o)) geomObj = o as GeoGeometry
        } catch {
          /* skip */
        }
      } else if (v && typeof v === 'object' && isGeoJsonGeometry(v)) {
        geomObj = v as GeoGeometry
      }
    } else {
      geomObj = parseEwkbGeometry(v)?.geometry ?? null
    }
    if (!geomObj) continue
    const properties: Record<string, unknown> = {}
    for (const f of fields) {
      if (f.name === geometry.name) continue
      properties[f.name] = sanitizeValue(row[f.name])
    }
    features.push({ type: 'Feature', geometry: geomObj, properties })
  }
  return { type: 'FeatureCollection', features }
}

/** 把非 JSON 原生的列值规整成可序列化值（Date/Buffer/bigint → 字符串）。 */
export function sanitizeValue(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.toString('hex')
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex')
  if (typeof v === 'object') return v
  return String(v)
}

/** 常见颜色名 → 十六进制（AI/用户可能给颜色名而不是 hex）。 */
const COLOR_NAMES: Record<string, string> = {
  red: '#ef4444', 红: '#ef4444',
  orange: '#f97316', 橙: '#f97316', 橙红: '#f97316',
  blue: '#3b82f6', 蓝: '#3b82f6',
  green: '#22c55e', 绿: '#22c55e',
  yellow: '#f59e0b', 黄: '#f59e0b',
  purple: '#8b5cf6', 紫: '#8b5cf6', 紫红: '#8b5cf6',
  pink: '#ec4899', 粉: '#ec4899',
  cyan: '#06b6d4', 青: '#06b6d4',
  teal: '#14b8a6',
  brown: '#a16207', 棕: '#a16207', 棕褐: '#a16207',
  black: '#111827', 黑: '#111827',
  white: '#ffffff', 白: '#ffffff',
  gray: '#6b7280', grey: '#6b7280', 灰: '#6b7280',
}

/**
 * 把用户/AI 给的显示颜色归一化为 `#rrggbb`。
 * 接受 3/6 位十六进制（`#f73` / `f97316` / `#f97316`）或常见颜色名（含中文）。
 * 非法输入返回 undefined，调用方回退默认色。
 */
export function normalizeColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (!s) return undefined
  const named = COLOR_NAMES[s.toLowerCase()]
  if (named) return named
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (!m || !m[1]) return undefined
  const hex = m[1].length === 3
    ? m[1].split('').map((c) => c + c).join('')
    : m[1]
  return `#${hex.toLowerCase()}`
}
