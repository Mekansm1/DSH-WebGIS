/**
 * DuckDB 筛选子句构造（纯函数）：等值/bbox/半径/围栏条件的 SQL 文本拼装与几何 → WKT。
 * 拆分自 src/duckdb-tools.ts；供 filter_layer / spatial_filter / spatial_aggregate 共用。
 */
import type { GisLayer } from '../geo-processing.js'
import { bboxPredText, haversinePredText, normalizeValue } from './geometry.js'

/** 数值化；非法返回 null。 */
export function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 正整数化；非法返回 null。 */
export function finiteInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** SQL 字符串字面量（单引号翻倍转义）——engine 侧不绑定参数，DDL 场景内联更稳。 */
export function inlineValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

/** SQL 标识符（列名）双引号转义，兼容中文/大写/保留字列名。 */
export function escIdent(k: string): string {
  return `"${k.replace(/"/g, '""')}"`
}

/** 等于筛选子句（where/filter JSON 对象，多字段取交集，返回不带 WHERE 的列等条件；空则 ''）。几何图层（无经纬度列）也能用。 */
export function buildEqualityClause(args: Record<string, unknown>): string {
  const parts: string[] = []
  // 等于筛选：filter_layer 用 where，load_csv 用 filter（同一个 JSON 对象形状）。
  const eq = args.where ?? args.filter
  if (eq && typeof eq === 'object' && !Array.isArray(eq)) {
    for (const [k, v] of Object.entries(eq as Record<string, unknown>)) {
      if (v === undefined || v === null) continue
      parts.push(`${escIdent(k)} = ${inlineValue(v)}`)
    }
  }
  return parts.join(' AND ')
}

/**
 * 把筛选参数（where 等于 / bbox 范围 / radius 半径）拼成内联 WHERE 子句（无则返回 ''）。
 * 值全部转义 + 列名双引号转义，无注入面；半径用 haversine 大圆距离 SQL。bbox/radius 需要经纬度列。
 */
export function buildFilterClause(args: Record<string, unknown>, coords: { lon: string; lat: string }): string {
  const parts: string[] = []
  const eq = buildEqualityClause(args)
  if (eq) parts.push(`(${eq})`)
  const bb = args.bbox as { west?: unknown; south?: unknown; east?: unknown; north?: unknown } | undefined
  if (bb && typeof bb === 'object') {
    const west = num(bb.west); const south = num(bb.south)
    const east = num(bb.east); const north = num(bb.north)
    if (west == null || south == null || east == null || north == null) {
      throw new Error('bbox 需提供 west/south/east/north 四个数值')
    }
    parts.push(`${escIdent(coords.lon)} BETWEEN ${west} AND ${east}`)
    parts.push(`${escIdent(coords.lat)} BETWEEN ${south} AND ${north}`)
  }
  const center = args.center as { lon?: unknown; lat?: unknown } | undefined
  const radius = num(args.radius)
  if (center != null || radius != null) {
    const clon = num(center?.lon); const clat = num(center?.lat)
    if (clon == null || clat == null || radius == null) {
      throw new Error('radius 需配 center={lon,lat} 和米制半径')
    }
    const latQ = escIdent(coords.lat); const lonQ = escIdent(coords.lon)
    parts.push(
      `(6371008.8 * acos(least(1.0, greatest(-1.0, `
      + `sin(radians(${latQ})) * sin(radians(${clat})) + `
      + `cos(radians(${latQ})) * cos(radians(${clat})) * cos(radians(${lonQ}) - radians(${clon}))`
      + `)))) <= ${radius}`,
    )
  }
  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
}

/** 预览行 JSON 安全化（复用 duckdb.normalizeValue：BigInt/Date/二进制/Interval/List/Struct 归一化）。 */
export function sanitizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) out[k] = normalizeValue(v)
    return out
  })
}

/** GeoJSON Polygon / MultiPolygon → WKT（坐标转 [lon lat] 对）。不支持返回 null。 */
export function geojsonToWkt(geom: unknown): string | null {
  if (!geom || typeof geom !== 'object') return null
  const g = geom as { type?: string; coordinates?: unknown }
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const rings = (g.coordinates as unknown[][]).map((ring) =>
      `(${(ring as number[][]).map((p) => `${p[0]} ${p[1]}`).join(', ')})`,
    )
    return `POLYGON(${rings.join(', ')})`
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const polys = (g.coordinates as unknown[][][]).map((poly) =>
      `(${(poly as unknown[][]).map((ring) =>
        `(${(ring as number[][]).map((p) => `${p[0]} ${p[1]}`).join(', ')})`,
      ).join(', ')})`,
    )
    return `MULTIPOLYGON(${polys.join(', ')})`
  }
  return null
}

/** 构造围栏（in-polygon）筛选子句：polygon=GeoJSON 面；polygonLayer=取该图层首个面要素作围栏。 */
export function buildPolygonClause(
  args: Record<string, unknown>,
  coords: { lon: string; lat: string },
  resolve: (id: unknown) => GisLayer | string,
): string {
  let geom: unknown
  const raw = args.polygon
  if (raw && typeof raw === 'object') geom = raw
  const layerId = typeof args.polygonLayer === 'string' && args.polygonLayer ? args.polygonLayer : ''
  if (layerId) {
    const layer = resolve(layerId)
    if (typeof layer === 'string') throw new Error(layer)
    const g = layer.geojson.features
      .find((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')?.geometry
    if (!g) throw new Error(`图层 ${layerId} 没有面要素可作围栏`)
    geom = g
  }
  if (geom === undefined) return ''
  const wkt = geojsonToWkt(geom)
  if (!wkt) throw new Error('polygon 需要是 GeoJSON 的 Polygon / MultiPolygon 几何')
  return `ST_Within(ST_Point(${escIdent(coords.lon)}, ${escIdent(coords.lat)}), ST_GeomFromText(${inlineValue(wkt)})::GEOMETRY)`
}

/** 等值子句（无 WHERE 前缀的列条件串；空串无）——复用现有 where/filter 形状。 */
export function eqClauseText(args: Record<string, unknown>): string {
  return buildEqualityClause(args)
}
