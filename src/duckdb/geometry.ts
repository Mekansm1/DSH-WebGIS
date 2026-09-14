/**
 * DuckDB 几何与行转换（纯函数）：坐标/几何列探测、几何表达式与 CRS 归一、Arrow 视口 WHERE、
 * 行 → GeoJSON 转换、值归一化、错误友好化，以及 SQL 标识符引用与保留行号列常量。
 * 拆分自 src/duckdb.ts；无引擎实例依赖，可被 tools 层与单测直接引用。
 */
import type { BBox, Feature, FeatureCollection } from 'geojson'
import type {
  ArrowBbox, ArrowViewportShape, CoordColumns, DuckColumn, DuckDbRow, DuckGeomFormat,
  DuckGeomSource, DuckGeomSpec,
} from './types.js'
// 仅类型引用（编译期擦除）：engine 反向 import 本模块的纯函数，运行时无循环。
import type { DuckDbEngine } from './engine.js'

const COORD_PAIRS: Array<[string, string]> = [
  ['lon', 'lat'],
  ['longitude', 'latitude'],
  ['lng', 'lat'],
  ['lon_wgs84', 'lat_wgs84'],
  ['lon_gcj02', 'lat_gcj02'],
  ['lon_bd09', 'lat_bd09'],
]

// ---------------------------------------------------------------- 源坐标系：检出结论与如实上报

/**
 * 源坐标系的检出结论。
 *
 * ⚠ **`crs === null` 有三种完全不同的原因，绝不能混为一谈**：
 * 「明确声明了 4326」是事实，「SRID=0 未声明」和「ST_SRID 探不出来」都只是**假设**按 WGS84 解释。
 * 后者若猜错（原数据其实是投影坐标），距离/面积/缓冲会全错，而**结果看上去完全正常** ——
 * 这是本插件最危险的一类静默失败，所以必须把 status 一路带到给模型看的话里。
 */
export type SourceCrsStatus =
  /** 几何列明确声明了 SRID（4326，或已识别出的其他 EPSG） */
  | 'declared'
  /** 未声明（SRID=0）→ 按 WGS84 解释，但这是假设 */
  | 'assumed-undefined'
  /** 探测本身失败（ST_SRID 不可用）→ 同样只能假设 WGS84 */
  | 'assumed-probe-failed'
  /** 列内混有多个 SRID → 拒绝自动重投影 */
  | 'mixed'

export interface SourceCrsInfo {
  /** 需重投影时用的源 CRS（`EPSG:n`）；null = 无需重投影或未确认，看 status。 */
  crs: string | null
  mixed: boolean
  srids: number[]
  status: SourceCrsStatus
}

/** 检出结论 → 给模型看的一句话。**永远不返回空串** —— 沉默正是问题所在。 */
export function crsReport(info: Pick<SourceCrsInfo, 'crs' | 'srids' | 'status'>): string {
  switch (info.status) {
    case 'declared':
      return info.crs ? `坐标系：源为 ${info.crs}，已自动转换到 4326` : '坐标系：已声明 4326'
    case 'assumed-undefined':
      return '⚠ 坐标系：数据**未声明 CRS**（SRID=0），已按 WGS84 解释 —— 这是假设，不是事实。'
        + '若原数据其实是投影坐标，位置、距离、面积、缓冲会**全部错误且看不出异常**。'
        + '请与用户确认；确为投影数据请重载并显式传 sourceCrs。'
    case 'assumed-probe-failed':
      return '⚠ 坐标系：**无法探测源 CRS**（ST_SRID 不可用），已按 WGS84 解释 —— 同样是假设。'
        + '若原数据是投影坐标，量算结果会全错而不报错；请与用户确认后重载并传 sourceCrs。'
    case 'mixed':
      return `坐标系：列内混有多个 SRID（${info.srids.join(', ')}），已拒绝自动重投影`
  }
}

/**
 * 经纬度范围自检：真实经纬度必然落在 lon∈[-180,180]、lat∈[-90,90]。
 *
 * **越界 = 极可能是投影坐标被当成了经纬度。** 这是把上面那种静默错误变成响亮错误的
 * 最便宜抓手 —— 只用一个 bbox，不依赖任何 CRS 元数据。
 */
export function looksProjected(bbox: number[] | null | undefined): boolean {
  if (!bbox || bbox.length < 4) return false
  const [w, s, e, n] = bbox as [number, number, number, number]
  if (![w, s, e, n].every((v) => Number.isFinite(v))) return false
  return Math.abs(w) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90
}

/** 坐标越界时的告警（给模型看）。bbox 正常返回空串。 */
export function crsRangeWarning(bbox: number[] | null | undefined, status: SourceCrsStatus): string {
  if (!looksProjected(bbox)) return ''
  const [w, s, e, n] = bbox as [number, number, number, number]
  const assumed = status === 'assumed-undefined' || status === 'assumed-probe-failed'
  return `🚨 坐标范围异常：bbox=[${w}, ${s}, ${e}, ${n}] 超出经纬度取值范围（lon±180 / lat±90）。`
    + (assumed
      ? '这与「数据未声明 CRS、已按 WGS84 解释」的假设**相互印证为假** —— 原数据几乎可以肯定是投影坐标。'
        + '**请立刻告诉用户：当前图层的位置与所有量算结果都不可信**，需要重载并显式传 sourceCrs（如 EPSG:3857 / EPSG:32650）。'
      : '请检查源坐标系设置是否正确，量算结果可能不可信。')
}

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

/**
 * 几何列 → 可被 ST_* 包裹的解析表达式（只做格式解析，不做 CRS 变换）。
 * 从 duckdb-tools 上移到几何层：抽样/族判定等下游模块共用（避免 tools 内部互相 import）。
 */
/** 几何列 → 可被 ST_* 包裹的解析表达式（只做格式解析，不做 CRS 变换）。 */
export function geomExprOfCol(col: string, format: DuckGeomFormat): string {
  const id = quoteIdent(col)
  if (format === 'geometry') return id
  if (format === 'wkt') return `ST_GeomFromText(regexp_replace(${id}, '^SRID=\\\\d+;', ''))`
  return `ST_GeomFromWKB(${id})`
}

// ---- 图层几何源表达式与表级 bbox（从 duckdb-tools 上移：抽样/筛选/聚合/ingestion 共用） ----
/** SQL 标识符（列/表）引用：可选表限定（JOIN 消歧）。 */
export function qref(name: string, qual?: string): string {
  return qual ? `${quoteIdent(qual)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** 几何列 → ST_* 表达式（含可选表限定 + CRS 归一化到 4326）。与 duckdb.buildGeomExpr 对齐。 */
export function geomExprFor(spec: DuckGeomSpec, qual?: string): string {
  const id = qref(spec.column, qual)
  let g: string
  if (spec.format === 'geometry') g = id
  else if (spec.format === 'wkt') g = `ST_GeomFromText(regexp_replace(${id}, '^SRID=\\\\d+;', ''))`
  else g = `ST_GeomFromWKB(${id})`
  const src = spec.sourceCrs
  if (src && src !== 'EPSG:4326' && src !== '4326') {
    g = `ST_Transform(${g}, '${src.replace(/'/g, '')}', 'EPSG:4326', true)`
  }
  return g
}

/** 图层一行 → 4326 几何表达式（duckCoords → ST_Point(lon,lat)；duckGeom → 几何列）。 */
export function rowGeomExprOf(src: DuckGeomSource, qual?: string): string {
  if (src.coords) return `ST_Point(${qref(src.coords.lon, qual)}, ${qref(src.coords.lat, qual)})`
  if (src.geom) return geomExprFor(src.geom, qual)
  throw new Error('图层没有可用的几何（缺 duckCoords/duckGeom 句柄）')
}

/** 点化源的行经纬度表达式：duckCoords → 列；duckGeom 点 → ST_X/ST_Y（几何已归一 4326）。 */
export function pointLonLatExprOf(src: DuckGeomSource, qual?: string): { lon: string; lat: string } {
  if (src.coords) return { lon: qref(src.coords.lon, qual), lat: qref(src.coords.lat, qual) }
  if (src.geom) {
    const g = geomExprFor(src.geom, qual)
    return { lon: `ST_X(${g})`, lat: `ST_Y(${g})` }
  }
  throw new Error('图层没有可用的几何（缺 duckCoords/duckGeom 句柄）')
}

/** 拼 WHERE 文本：若干（可空）片段求 AND；空 → ''。 */
export function combineWhereText(parts: string[]): string {
  const active = parts.filter((p) => p && p.trim() !== '')
  return active.length > 0 ? `WHERE ${active.map((p) => `(${p})`).join(' AND ')}` : ''
}

/** bbox 经纬度区间谓词。 */
export function bboxPredText(lonExpr: string, latExpr: string, bb: { west: number; south: number; east: number; north: number }): string {
  return `${lonExpr} BETWEEN ${bb.west} AND ${bb.east} AND ${latExpr} BETWEEN ${bb.south} AND ${bb.north}`
}

/** haversine 大圆距离（米）≤ radius 谓词。 */
export function haversinePredText(lonExpr: string, latExpr: string, clon: number, clat: number, radius: number): string {
  return `(6371008.8 * acos(least(1.0, greatest(-1.0, `
    + `sin(radians(${latExpr})) * sin(radians(${clat})) + `
    + `cos(radians(${latExpr})) * cos(radians(${clat})) * cos(radians(${lonExpr}) - radians(${clon}))`
    + `)))) <= ${radius}`
}

/** 源表 bbox（西/南/东/北；空表返回 null）。等值条件可选（作用于 where 子集）。 */
export async function tableBBoxOf(
  engine: DuckDbEngine,
  table: string,
  lonExpr: string,
  latExpr: string,
  whereText: string,
): Promise<{ west: number; south: number; east: number; north: number } | null> {
  const rows = await engine.run(
    `SELECT min(${lonExpr}) AS w, min(${latExpr}) AS s, max(${lonExpr}) AS e, max(${latExpr}) AS n FROM ${table} ${whereText}`,
  )
  const r = rows[0] ?? {}
  const w = Number(r.w); const s = Number(r.s); const e = Number(r.e); const n = Number(r.n)
  if (![w, s, e, n].every((v) => Number.isFinite(v))) return null
  return { west: w, south: s, east: e, north: n }
}

/** duck 表全量 bbox（[w,s,e,n]，已归一 4326）；空表/算不出 → null。
 *  duckCoords → 经纬度列 min/max；duckGeom → ST_XMin/XMax/YMin/YMax（几何列按 buildGeomExpr 同款 4326 归一）。
 *  图层 geojson 只是抽样时用它算「全量真实范围」，避免 viewport 裁剪/工具消息/导出被抽样 bbox 误导。 */
export async function duckTableFullBBox(
  engine: DuckDbEngine,
  table: string,
  src: DuckGeomSource,
  whereText = '',
): Promise<BBox | null> {
  let sql: string
  if (src.coords) {
    sql = `SELECT min(${quoteIdent(src.coords.lon)}) AS w, min(${quoteIdent(src.coords.lat)}) AS s, `
      + `max(${quoteIdent(src.coords.lon)}) AS e, max(${quoteIdent(src.coords.lat)}) AS n FROM ${table} ${whereText}`
  } else if (src.geom) {
    const g = geomExprFor(src.geom)
    sql = `SELECT min(ST_XMin(${g})) AS w, min(ST_YMin(${g})) AS s, max(ST_XMax(${g})) AS e, max(ST_YMax(${g})) AS n `
      + `FROM ${table} ${whereText}`
  } else {
    return null
  }
  let rows: Awaited<ReturnType<DuckDbEngine['run']>>
  try {
    rows = await engine.run(sql)
  } catch {
    // 几何列需 spatial / 个别行几何非法：拿不到全量 bbox 就回退抽样 bbox，不影响加载。
    return null
  }
  const r = rows[0] ?? {}
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))
  const w = num(r.w); const s = num(r.s); const e = num(r.e); const n = num(r.n)
  if (![w, s, e, n].every(Number.isFinite)) return null
  return [w, s, e, n]
}
