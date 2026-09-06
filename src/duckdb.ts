/**
 * DuckDB host 引擎：本地 CSV 的秒级加载 / 筛选 / 列式分析（方案见 D:\dsh webgis\DuckDB实现方案.md）。
 *
 * - 懒建 `:memory:` 库：首次真正查询才初始化，插件未用 DuckDB 时不占任何资源。
 * - 原生模块经 createRequire 加载（与阶段 0 基准脚本一致，避免 ESM/CJS 互操作坑）。
 * - 单条查询 Promise.race 兜底超时，防乱写 SQL 卡死宿主。
 * - LRU 总行数清理：超出 maxTotalRows 自动 DROP 最久未用的表。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureCollection } from 'geojson'

const require = createRequire(import.meta.url)
// duckdb npm 包导出带 .Database 属性的构造函数（CJS）。用结构类型最小化依赖其 .d.ts 形状。
interface DuckDbRow {
  [column: string]: unknown
}
interface DuckDbConn {
  all(sql: string, cb: (err: Error | null, rows: DuckDbRow[]) => void): void
  all(sql: string, params: unknown[], cb: (err: Error | null, rows: DuckDbRow[]) => void): void
  exec(sql: string, cb: (err: Error | null) => void): void
  /** DuckDB 原生 Arrow IPC 导出（需 LOAD arrow FROM community；见 ensureArrow）。 */
  arrowIPCAll?(sql: string, cb: (err: Error | null, buffers: Uint8Array[] | undefined) => void): void
  close(cb: (err: Error | null) => void): void
}
interface DuckDbHandle {
  connect(): DuckDbConn
  close(cb: (err: Error | null) => void): void
}
interface DuckDbCtor {
  Database: new (path: string) => DuckDbHandle
}
const duckdb = require('duckdb') as DuckDbCtor

export interface DuckDbOptions {
  /** 小文件「常规加载」行数阈值：count ≤ 此值的 CSV 不保留内存表，全部物化上图。默认 50000。 */
  papaparseThreshold?: number
  /** DuckDB 内存表总行数上限：超出自动 DROP 最久未用的表（LRU）。默认 2000 万。 */
  maxTotalRows?: number
  /** DuckDB 进程级内存上限（SET memory_limit）。默认 '2GB'。 */
  memoryLimit?: string
  /** 单条查询超时（毫秒）。默认 30s。 */
  timeoutMs?: number
}

interface TableRef {
  rows: number
  lastUsed: number
}

/** CSV 行 → GeoJSON 的经纬度列探测结果。 */
export interface CoordColumns {
  lon: string | null
  lat: string | null
}

const COORD_PAIRS: Array<[string, string]> = [
  ['lon', 'lat'],
  ['longitude', 'latitude'],
  ['lng', 'lat'],
  ['lon_wgs84', 'lat_wgs84'],
  ['lon_gcj02', 'lat_gcj02'],
  ['lon_bd09', 'lat_bd09'],
]

/**
 * 从列名表探测经纬度列：显式传入优先（lonField/latField 必须都在列里，否则返回 null）；
 * 否则按 lon/lat、longitude/latitude、lng/lat、lon_ / lat_ 前缀的优先级找。
 */
export function detectCoordColumns(columns: string[], lonField?: string, latField?: string): CoordColumns {
  const has = (c?: string): boolean => typeof c === 'string' && c.length > 0 && columns.includes(c)
  if (lonField || latField) {
    if (!has(lonField) || !has(latField)) return { lon: null, lat: null }
    return { lon: lonField as string, lat: latField as string }
  }
  for (const [lo, la] of COORD_PAIRS) {
    if (columns.includes(lo) && columns.includes(la)) return { lon: lo, lat: la }
  }
  const lon = columns.find((c) => /^lon/i.test(c))
  const lat = columns.find((c) => /^lat/i.test(c))
  return lon && lat ? { lon, lat } : { lon: null, lat: null }
}

/** DESCRIBE 得到的列定义。 */
export interface DuckColumn {
  name: string
  type: string
}

export type DuckGeomFormat = 'geometry' | 'wkb' | 'wkt'

/** 检测出的几何列句柄。 */
export interface DuckGeomSpec {
  column: string
  format: DuckGeomFormat
  /** 显式 sourceCrs 或 ST_SRID 自动检出；null = 按 WGS84 处理。 */
  sourceCrs: string | null
}

/** createTableFromVector 的产出：本地矢量 ST_Read 建表后信息。 */
export interface VectorTableInfo {
  count: number
  columns: string[]
  /** 几何列名（GEOMETRY/WKB/WKT，detectGeomColumn 检出）；无几何列返回 null。 */
  geomCol: string | null
  /** 几何列格式（与 geomCol 配对；无几何列返回 null）。 */
  geomFormat: DuckGeomFormat | null
}

/** SQL 标识符双引号转义（兼容中文列名）。 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** 保留行号列名：duck 建表时自动首列加稳定行号（源序），arrow 几何列点击回查属性用；
 *  属「内部保留列」——所有用户可见的属性/列清单（popup/导出/图层信息）都要排除它。 */
export const DUCK_RID = '__rid'

/**
 * 从列定义打分识别几何列（借鉴 opengeo/maplibre-gl-duckdb 思路，对 DESCRIBE 结果判断）：
 * GEOMETRY 类型 +100 / 列名 geometry|geom +60 / 列名含 wkb|wkt +50 / BLOB|BINARY|WKB 类型 +20 /
 * VARCHAR|TEXT|STRING 类型 +10 / detectGeomFormat 命中 +5。0 分返回 null；requested 显式命中即返回。
 */
export function detectGeomColumn(columns: DuckColumn[], requested?: string): string | null {
  if (requested) return columns.some((c) => c.name === requested) ? requested : null
  let best: { name: string; score: number } | null = null
  for (const col of columns) {
    const upper = col.type.toUpperCase()
    let score = 0
    if (upper.startsWith('GEOMETRY')) score += 100
    if (col.name === 'geometry' || col.name === 'geom') score += 60
    if (/wkb|wkt/i.test(col.name)) score += 50
    if (/BLOB|BINARY|WKB/.test(upper)) score += 20
    if (/VARCHAR|TEXT|STRING/.test(upper)) score += 10
    if (detectGeomFormat(col) != null) score += 5
    if (score > 0 && (!best || score > best.score)) best = { name: col.name, score }
  }
  return best ? best.name : null
}

/** 几何列格式判定：GEOMETRY* → geometry；BLOB/BINARY/WKB 类型 → wkb；字符串类型且列名含 wkt/geom → wkt。 */
export function detectGeomFormat(col: DuckColumn): DuckGeomFormat | null {
  const upper = col.type.toUpperCase()
  if (upper.startsWith('GEOMETRY')) return 'geometry'
  if (/BLOB|BINARY|WKB/.test(upper)) return 'wkb'
  if (/VARCHAR|TEXT|STRING/.test(upper) && /wkt|geom|geometry/i.test(col.name)) return 'wkt'
  return null
}

/**
 * 几何列 → 可被 ST_* 包裹的几何表达式（ST_Transform 处理 CRS）。
 * sourceCrs 已知且 ≠4326 时包 ST_Transform(..., 'SRC', 'EPSG:4326', true)（make_valid 容错投影数据）。
 * WKT 文本若带 `SRID=...;` 前缀（EWKT）先剥掉——SRID 只信任显式 sourceCrs / ST_SRID 检出。
 */
export function buildGeomExpr(col: string, format: DuckGeomFormat, sourceCrs: string | null): string {
  const id = quoteIdent(col)
  let geom: string
  if (format === 'geometry') geom = id
  else if (format === 'wkt') geom = `ST_GeomFromText(regexp_replace(${id}, '^SRID=\\\\d+;', ''))`
  else geom = `ST_GeomFromWKB(${id})`
  if (sourceCrs && sourceCrs !== 'EPSG:4326' && sourceCrs !== '4326') {
    geom = `ST_Transform(${geom}, '${sourceCrs.replace(/'/g, '')}', 'EPSG:4326', true)`
  }
  return geom
}

/** 几何列 → `ST_AsGeoJSON(<geomExpr>) AS __geometry` 的 SELECT 片段（上图用）。 */
export function buildGeomSelect(col: string, format: DuckGeomFormat, sourceCrs: string | null): string {
  return `ST_AsGeoJSON(${buildGeomExpr(col, format, sourceCrs)}) AS __geometry`
}

/** Arrow 视口裁剪的图层几何形态：duckCoords（经纬度点表）或 duckGeom（几何列表）。 */
export type ArrowViewportShape =
  | { coords: { lon: string; lat: string } }
  | { geom: { column: string; format: DuckGeomFormat; sourceCrs: string | null } }

/** Arrow 视口 bbox（经度/纬度区间；west≤east、south≤north）。 */
export interface ArrowBbox {
  west: number
  south: number
  east: number
  north: number
}

/**
 * 视口裁剪 → WHERE 文本（/webgis/arrow 的 bbox 参数落成 DuckDB 过滤子句）。
 * - duckCoords（经纬度点表）：`lon BETWEEN west AND east AND lat BETWEEN south AND north`（4326 经纬度直接区间）。
 * - duckGeom（几何列表）：`ST_Intersects(<buildGeomExpr>, ST_MakeEnvelope(west,south,east,north))`
 *   （两方都在 4326；sourceCrs≠4326 时 buildGeomExpr 已 ST_Transform 到 4326）。
 * 仅供 handleArrow / 单测使用；bbox 已在路由层校验过（west≤east、south≤north、有限数）。
 */
export function arrowViewportWhere(shape: ArrowViewportShape, bbox: ArrowBbox): string {
  const { west, south, east, north } = bbox
  if ('coords' in shape && shape.coords) {
    const lon = quoteIdent(shape.coords.lon)
    const lat = quoteIdent(shape.coords.lat)
    return `${lon} BETWEEN ${west} AND ${east} AND ${lat} BETWEEN ${south} AND ${north}`
  }
  const g = (shape as { geom: { column: string; format: DuckGeomFormat; sourceCrs: string | null } }).geom
  const geom = buildGeomExpr(g.column, g.format, g.sourceCrs)
  return `ST_Intersects(${geom}, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}))`
}

/** DuckDB 行 → GeoJSON 点要素（非法/越界坐标行跳过；坐标列不进 properties）。 */
export function rowsToGeoJSON(rows: DuckDbRow[], lonCol: string, latCol: string): FeatureCollection {
  const features: Feature[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const lonRaw = row[lonCol]
    const latRaw = row[latCol]
    // 空值/空串跳过（Number(null)/Number('') 都会变 0，不能当合法坐标）。
    if (lonRaw == null || latRaw == null) continue
    if (typeof lonRaw === 'string' && lonRaw.trim() === '') continue
    if (typeof latRaw === 'string' && latRaw.trim() === '') continue
    const lon = Number(lonRaw)
    const lat = Number(latRaw)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
    const properties: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === lonCol || k === latCol || k === DUCK_RID) continue
      properties[k] = normalizeValue(v)
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties })
  }
  return { type: 'FeatureCollection', features }
}

/** 几何坐标是否全部有限数（防 NaN/undefined 顶点让 deck/maplibre 渲染崩，仿 deck-charts validPos）。 */
function validGeometry(geom: unknown): boolean {
  if (!geom || typeof geom !== 'object') return false
  const g = geom as { type?: unknown; coordinates?: unknown; geometries?: unknown[] }
  if (typeof g.type !== 'string' || g.type === '') return false
  if (g.type === 'GeometryCollection') return Array.isArray(g.geometries) && g.geometries.every((c) => validGeometry(c))
  if (!Array.isArray(g.coordinates)) return false
  const walk = (arr: unknown[]): boolean => arr.every((v) => (Array.isArray(v) ? walk(v) : Number.isFinite(v)))
  return walk(g.coordinates)
}

/**
 * 几何行 → FeatureCollection（`__geometry` 是 ST_AsGeoJSON 字符串）。
 * 非法/空几何行跳过；只采 attrsColumns（几何列本身不进 properties，与 rowsToGeoJSON 剔除坐标列一致）。
 */
export function geometryRowsToGeoJSON(rows: DuckDbRow[], attrsColumns: string[]): FeatureCollection {
  const features: Feature[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = row.__geometry
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue
    let geometry: unknown
    try {
      geometry = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      continue
    }
    if (!validGeometry(geometry)) continue
    const properties: Record<string, unknown> = {}
    for (const k of attrsColumns) {
      const v = row[k]
      if (v == null) continue
      properties[k] = normalizeValue(v)
    }
    features.push({ type: 'Feature', geometry: geometry as Feature['geometry'], properties })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 把 duckdb 返回值归一化为 JSON 友好值（BigInt/Date/二进制/Interval/List/Struct 等非 JSON 安全类型）。
 * 数组/对象保留形状逐值归一化（避免把合法 JSON 误字符串化），循环引用兜底转 String。
 */
export function normalizeValue(v: unknown): unknown {
  // BigInt：安全整数范围（Number.isSafeInteger 对 BigInt 恒 false，需显式范围比较）内转 number 保 JSON 数值，超界转字符串保精度。
  if (typeof v === 'bigint') {
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v)
    return v.toString()
  }
  if (v instanceof Date) return v.toISOString()
  if (ArrayBuffer.isView(v)) return `[binary ${v.byteLength}B]` // BLOB
  if (v instanceof ArrayBuffer) return `[binary ${v.byteLength}B]`
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x))
  if (typeof v === 'object' && v !== null) {
    try {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = normalizeValue(x)
      return out
    } catch {
      return String(v)
    }
  }
  return v
}

/**
 * 工具层错误分类（借鉴 opengeo/maplibre-gl-duckdb 的 friendlyError 思路）：按消息正则归类，
 * 返回「原文。建议：...」。只在工具层叠加到返回 message，不改 engine 抛的原始错误。
 */
export function friendlyDuckError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const advice = (tip: string): string => `${msg}。建议：${tip}`
  if (/超时|timeout/i.test(msg)) return advice('加 WHERE 缩小范围、减小 LIMIT，或把查询拆小。')
  if (/parser error|syntax error/i.test(msg)) return advice('检查表名/列名/括号/关键字拼写。')
  if (/binder error|catalog error|does not exist/i.test(msg)) return advice('用 webgis_layer_stats 或 DESCRIBE 核对列名/表名是否存在。')
  if (/spatial|ST_/i.test(msg)) return advice('需要 DuckDB spatial 扩展（首次需联网 INSTALL，之后本地缓存）；或几何函数用法有误。')
  if (/out of memory|memory_limit|malloc/i.test(msg)) return advice('数据集过大：先筛选缩小范围，或调大插件配置 duckdb.memoryLimit。')
  if (/no such file|io error|could not open/i.test(msg)) return advice('检查路径与文件编码（CSV 可改用 webgis_load_dataset 走常规导入）。')
  return msg
}

/** 大表建表/灌表（read_csv/ST_Read/子集 CTAS）的内部超时：千万级 × 几十列可能远超 30s 默认，放宽到 5 分钟。 */
const INGEST_TIMEOUT_MS = 300_000

export class DuckDbEngine {
  private db: DuckDbHandle | null = null
  private conn: DuckDbConn | null = null
  private readonly tables = new Map<string, TableRef>()
  private seq = 0
  private ingestSeq = 0
  private readonly opts: Required<DuckDbOptions>
  private spatialLoaded = false
  private spatialTried = false
  /** arrow 扩展（community 仓）：惰性加载；arrowIpc 失败回退调用方（JS 行路径）。 */
  private arrowLoaded = false
  private arrowTried = false

  constructor(opts: DuckDbOptions = {}) {
    this.opts = {
      papaparseThreshold: opts.papaparseThreshold ?? 50000,
      maxTotalRows: opts.maxTotalRows ?? 20_000_000,
      memoryLimit: opts.memoryLimit ?? '2GB',
      timeoutMs: opts.timeoutMs ?? 30_000,
    }
  }

  /** 小文件「常规加载」阈值（工具用它决定是否保留内存表）。 */
  get threshold(): number {
    return this.opts.papaparseThreshold
  }

  /** spatial 扩展是否已加载（in-polygon 等几何函数可用）。 */
  get hasSpatial(): boolean {
    return this.spatialLoaded
  }

  private init(): void {
    if (this.conn) return
    this.db = new duckdb.Database(':memory:')
    this.conn = this.db.connect()
    // 可写 temp 目录：DuckDB 超出 memory_limit 需要 spill 落盘时，默认写到进程 CWD——宿主 CWD 常不可写，
    // 大表建表（如 168 万×22 列 union）会报「无法创建 .tmp」。显式指到 OS temp 并确保目录存在。
    const tmpDir = join(tmpdir(), 'dsh-webgis-duckdb').replace(/\\/g, '/')
    try { mkdirSync(tmpDir, { recursive: true }) } catch { /* 失败则交给 DuckDB 默认行为 */ }
    void this.exec(`SET temp_directory='${tmpDir}'`).catch(() => {})
    // 内存兜底防 OOM；失败不影响后续（继续尝试真实查询）。
    void this.exec(`SET memory_limit='${this.opts.memoryLimit.replace(/'/g, '')}'`).catch(() => {})
  }

  /**
   * 惰性加载 spatial 扩展（`INSTALL spatial` 首次需联网下载，之后本地缓存）。
   * 离线失败不抛（hasSpatial=false），由调用方决定降级；只试一次。
   */
  async ensureSpatial(): Promise<boolean> {
    if (this.spatialLoaded) return true
    if (this.spatialTried) return false
    this.spatialTried = true
    try {
      await this.exec('INSTALL spatial')
      await this.exec('LOAD spatial')
      this.spatialLoaded = true
      return true
    } catch {
      return false
    }
  }

  /** arrow 扩展是否已加载（原生 Arrow IPC 导出可用）。 */
  get hasArrow(): boolean {
    return this.arrowLoaded
  }

  /**
   * 惰性加载 arrow 扩展（community 仓：`INSTALL arrow FROM community`，1.2+ 起 arrow 从核心迁出）。
   * 首次需联网，之后本地缓存；离线/缺失失败不抛（arrowIpc 回退 null → 调用方走 JS 行路径），只试一次。
   */
  async ensureArrow(): Promise<boolean> {
    if (this.arrowLoaded) return true
    if (this.arrowTried) return false
    this.arrowTried = true
    try {
      await this.exec('INSTALL arrow FROM community')
      await this.exec('LOAD arrow')
      this.arrowLoaded = true
      return true
    } catch {
      return false
    }
  }

  /**
   * DuckDB 原生 Arrow IPC 导出：SQL → 单个 IPC 字节流（不经 JS 行对象）。
   * 供大点图层 /webgis/arrow 的 duckCoords 路径提速（省掉 conn.all 的 N 行 JS 物化）。
   * arrow 扩展不可用 / 超时 / 失败一律返回 null，调用方回退现有路径。
   */
  async arrowIpc(sql: string): Promise<Uint8Array | null> {
    if (!(await this.ensureArrow())) return null
    const conn = this.conn as DuckDbConn | null
    if (!conn?.arrowIPCAll) return null
    return new Promise<Uint8Array | null>((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(null) // 超时视作不可用，回退调用方
      }, this.opts.timeoutMs)
      try {
        conn.arrowIPCAll!(sql, (err, buffers) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (err || !buffers || buffers.length === 0) return resolve(null)
          if (buffers.length === 1) return resolve(buffers[0]!)
          const total = buffers.reduce((s, b) => s + b.byteLength, 0)
          const out = new Uint8Array(total)
          let offset = 0
          for (const b of buffers) {
            out.set(b, offset)
            offset += b.byteLength
          }
          resolve(out)
        })
      } catch {
        if (!done) {
          done = true
          clearTimeout(timer)
        }
        resolve(null)
      }
    })
  }

  /** 下一个表名（进程内递增，跨会话全局唯一）。 */
  nextTableName(): string {
    return `duckdb_${++this.seq}`
  }

  /** 当前引擎里还活着的表名（诊断/测试用）。 */
  tableNames(): string[] {
    return [...this.tables.keys()]
  }

  /** 单条 SQL → 行数组。Promise.race 兜底超时。 */
  run(sql: string, params?: unknown[]): Promise<DuckDbRow[]> {
    this.init()
    const conn = this.conn as DuckDbConn
    return new Promise<DuckDbRow[]>((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new Error(`DuckDB 查询超时（>${this.opts.timeoutMs}ms）：${sql.slice(0, 120)}`))
      }, this.opts.timeoutMs)
      const cb = (err: Error | null, rows: DuckDbRow[]): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(rows)
      }
      if (params && params.length > 0) conn.all(sql, params, cb)
      else conn.all(sql, cb)
    })
  }

  /** 执行无结果语句（CREATE/DROP/SET），用默认超时兜底。 */
  exec(sql: string): Promise<void> {
    return this.execTimed(sql, this.opts.timeoutMs)
  }

  /** 带指定超时（ms）的无结果语句；大表建表/灌表（read_csv/ST_Read/子集 CTAS）用长超时防误掐。 */
  private execTimed(sql: string, timeoutMs: number): Promise<void> {
    this.init()
    const conn = this.conn as DuckDbConn
    return new Promise<void>((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new Error(`DuckDB 语句超时（>${timeoutMs}ms）：${sql.slice(0, 120)}`))
      }, timeoutMs)
      const cb = (err: Error | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      conn.exec(sql, cb)
    })
  }

  /**
   * 从 CSV 建内存表（read_csv 一次扫描，之后查询走内存表毫秒级）。
   * table 必须是 nextTableName() 产出的新名字。返回总行数 + 列名。
   */
  async createTableFromCsv(table: string, csvPath: string): Promise<{ count: number; columns: string[] }> {
    // 首列加稳定行号 __rid（源文件行序，row_number 一次定序，表生命周期内不变）：
    // arrow 几何列点击回查属性靠它（DuckDB 无 rowid() 伪列）；用户列里若恰好叫 __rid 会撞名，视为保留名。
    await this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM read_csv(${sqlString(csvPath)}, header=true, auto_detect=true, sample_size=-1, union_by_name=true)`, INGEST_TIMEOUT_MS)
    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return info
  }

  /**
   * 从 JS 解析的 GeoJSON 要素灌内存表（SHP/GeoJSON/上传共用：统一走 DuckDB + arrow 管道）。
   * 写临时 .geojson → spatial `ST_Read`（GEOMETRY 列自动识别，attrs 保类型），读完删临时文件。
   * 返回行数 + 列名 + 几何列名。table 必须是 nextTableName() 产出的新名字。
   */
  async createTableFromGeoJson(
    table: string,
    fc: FeatureCollection,
  ): Promise<{ count: number; columns: string[]; geomColumn: string | null }> {
    const path = join(tmpdir(), `dsh-webgis-import-${process.pid}-${++this.ingestSeq}.geojson`)
    try {
      writeFileSync(path, JSON.stringify(fc), 'utf8')
      if (!(await this.ensureSpatial())) throw new Error('空间扩展未加载（ST_Read 需要 DuckDB spatial）')
      await this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM ST_Read(${sqlString(path)})`, INGEST_TIMEOUT_MS)
    } finally {
      try { rmSync(path, { force: true }) } catch { /* 清理失败忽略 */ }
    }
    const desc = await this.describe(table)
    const geomColumn = desc.find((c) => c.type.startsWith('GEOMETRY'))?.name ?? null
    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return { count: info.count, columns: desc.map((c) => c.name), geomColumn }
  }

  /**
   * 从本地矢量文件（.shp/.gdb/.gpkg/.kml/.tab/.mif，GDAL 支持）直接建内存表：spatial `ST_Read` 一次扫描，
   * 之后查询走内存表。不再先经 shpjs 把全量要素物化成 JS geojson（超大 .shp 优化路径）。
   * opts.layer：GDB/GPKG 等多图层源可选 GDAL 图层名（duckdb ≥1.4 命名参数 `layer =>`）；找不到该图层抛中文错误。
   * 几何列经 detectGeomColumn/detectGeomFormat 判定（GEOMETRY 或 WKB BLOB），列名常见 geom/wkb_geometry。
   * 返回总行数 + 列名 + 几何列名 + 格式。table 必须是 nextTableName() 产出的新名字。
   */
  async createTableFromVector(
    table: string,
    path: string,
    opts: { layer?: string } = {},
  ): Promise<VectorTableInfo> {
    if (!(await this.ensureSpatial())) {
      throw new Error('矢量文件（shp/gdb/gpkg/kml/tab/mif）读取需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）')
    }
    const layer = typeof opts.layer === 'string' && opts.layer.trim() ? opts.layer.trim() : ''
    const plainSrc = `ST_Read(${sqlString(path)})`
    const createFrom = (src: string): Promise<void> =>
      this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM ${src}`, INGEST_TIMEOUT_MS)

    if (layer) {
      const withLayer = `ST_Read(${sqlString(path)}, layer => '${layer.replace(/'/g, "''")}')`
      try {
        await createFrom(withLayer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/could not be found in dataset|layer\s*'[^']*'\s*could not be found/i.test(msg)) {
          throw new Error(
            `矢量数据源「${path}」中找不到图层「${layer}」（多图层如 .gdb/.gpkg 需传 GDAL 图层名，缺省读第一层）`,
          )
        }
        if (/parser error|syntax error|unexpected token/i.test(msg)) {
          // 旧版 duckdb 不支持 layer => 命名参数：退化读默认层。
          await createFrom(plainSrc)
        } else {
          throw this.vectorOpenError(err, path)
        }
      }
    } else {
      try {
        await createFrom(plainSrc)
      } catch (err) {
        throw this.vectorOpenError(err, path)
      }
    }

    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    const desc = await this.describe(table)
    const geomName = detectGeomColumn(desc)
    const geomCol = geomName ? desc.find((c) => c.name === geomName) ?? null : null
    const geomFormat = geomCol ? detectGeomFormat(geomCol) : null
    return {
      count: info.count,
      columns: desc.map((c) => c.name),
      geomCol: geomCol ? geomCol.name : null,
      geomFormat,
    }
  }

  /** ST_Read 打开失败的 IO 错误 → 中文可懂（.shp/.tab 需兄弟文件，.gdb 是目录）。 */
  private vectorOpenError(err: unknown, path: string): Error {
    const msg = err instanceof Error ? err.message : String(err)
    if (/IO Error|Cannot open|could not open|No such file|not found|无法打开|系统找不到/i.test(msg)) {
      return new Error(
        `无法打开矢量文件「${path}」：请确认路径存在且文件完整（.shp/.tab 需同目录的 .dbf/.shx/.prj 等配套文件；.gdb 是文件夹需指到目录本身）`,
      )
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  /**
   * 从 base 表 + WHERE 子句物化新表（筛选结果，链式筛选用）。whereClause 已内联转义
   * （engine 侧不绑定参数，DDL 场景 exec 不支持参数化）。返回新表行数。
   */
  async createFilterTable(newTable: string, baseTable: string, whereClause: string): Promise<number> {
    await this.execTimed(`CREATE TABLE ${newTable} AS SELECT * FROM ${baseTable} ${whereClause}`, INGEST_TIMEOUT_MS)
    const info = await this.tableInfo(newTable)
    this.tables.set(newTable, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return info.count
  }

  /** 表的信息：总行数 + 列名（DESCRIBE）。 */
  async tableInfo(table: string): Promise<{ count: number; columns: string[] }> {
    const rows = await this.run(`SELECT count(*) AS count FROM ${table}`)
    const desc = await this.describe(table)
    return {
      count: Number(rows[0]?.count ?? 0),
      columns: desc.map((c) => c.name),
    }
  }

  /** DESCRIBE 列定义（含类型文本，几何列识别用）。 */
  async describe(table: string): Promise<DuckColumn[]> {
    const desc = await this.run(`DESCRIBE ${table}`)
    return desc.map((r) => ({
      name: String(r.column_name ?? r.name),
      type: String(r.column_type ?? r.type ?? ''),
    }))
  }

  /** 检出 GEOMETRY 列里全部非零 SRID（去重）；ST_SRID 不可用/出错返回 []。 */
  async detectSrids(table: string, column: string): Promise<number[]> {
    try {
      const rows = await this.run(
        `SELECT DISTINCT ST_SRID(${quoteIdent(column)}) AS srid FROM ${table} `
        + `WHERE ${quoteIdent(column)} IS NOT NULL AND ST_SRID(${quoteIdent(column)}) <> 0`,
      )
      const out: number[] = []
      for (const r of rows) {
        const s = Number(r.srid)
        if (Number.isFinite(s) && s > 0) out.push(s)
      }
      return [...new Set(out)]
    } catch {
      return [] // ST_SRID 不可用 → 按 WGS84 处理
    }
  }

  /** 自动检出 GEOMETRY 列的源坐标系：混合 SRID（>1 个非零）→ mixed=true 且 crs=null（拒绝整列自动重投影）。
   *  单一非 4326 → crs=`EPSG:n`；0/4326/无 → crs=null。 */
  async detectSourceCrs(table: string, column: string): Promise<{ crs: string | null; mixed: boolean; srids: number[] }> {
    const srids = await this.detectSrids(table, column)
    if (srids.length === 0) return { crs: null, mixed: false, srids }
    if (srids.length > 1) return { crs: null, mixed: true, srids }
    const srid = srids[0]!
    return { crs: srid === 4326 ? null : `EPSG:${srid}`, mixed: false, srids }
  }

  /** 触摸表（更新 LRU 时间戳；后续筛选工具使用前调用）。 */
  touch(table: string): void {
    const ref = this.tables.get(table)
    if (ref) {
      ref.lastUsed = Date.now()
      this.tables.set(table, ref)
    }
  }

  /** 随机抽样 n 行（reservoir，DuckDB `USING SAMPLE`，大文件显示子集用）。 */
  async sampleRows(table: string, n: number, where?: { clause: string; params: unknown[] }): Promise<DuckDbRow[]> {
    this.touch(table)
    const src = where?.clause ? `(SELECT * FROM ${table} ${where.clause})` : table
    return this.run(`SELECT * FROM ${src} USING SAMPLE ${Math.max(1, Math.floor(n))} ROWS`, where?.params)
  }

  /** 普通查询：SELECT * FROM <table> <suffix>（suffix 如 "WHERE ... LIMIT n"）。 */
  async query(table: string, suffix: string, params?: unknown[]): Promise<DuckDbRow[]> {
    this.touch(table)
    return this.run(`SELECT * FROM ${table} ${suffix}`, params)
  }

  /** 删除表并释放内存。表不存在时静默。 */
  async dropTable(table: string): Promise<void> {
    this.tables.delete(table)
    if (!this.conn) return
    try {
      await this.exec(`DROP TABLE IF EXISTS ${table}`)
    } catch {
      // 表可能已被清/不存在，忽略。
    }
  }

  /** 关闭引擎（插件卸载/进程退出）。 */
  async close(): Promise<void> {
    this.tables.clear()
    if (this.db) {
      const db = this.db
      this.db = null
      this.conn = null
      await new Promise<void>((resolve) => db.close(() => resolve()))
    }
  }

  /** LRU：总行数超上限时按最久未用优先 DROP，直到达标。 */
  private async evictLru(): Promise<void> {
    let total = 0
    for (const ref of this.tables.values()) total += ref.rows
    if (total <= this.opts.maxTotalRows) return
    const order = [...this.tables.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [name, ref] of order) {
      if (total <= this.opts.maxTotalRows) break
      await this.dropTable(name)
      total -= ref.rows
    }
  }
}

/** 进程级懒单例（插件多次加载共享同一引擎）。测试注入独立引擎走 registerDuckDbTools 的 opts.engine。 */
let engine: DuckDbEngine | null = null

export function getDuckDb(opts?: DuckDbOptions): DuckDbEngine {
  if (!engine) engine = new DuckDbEngine(opts)
  return engine
}

/** SQL 字符串字面量：反斜杠归一化为正斜杠 + 单引号翻倍转义。 */
function sqlString(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`
}
