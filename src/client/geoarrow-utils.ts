/**
 * GeoArrow 渲染的纯函数工具（无 @geoarrow/@deck.gl 运行时依赖，Node 可直接单测）。
 *
 * 与 geoarrow-charts.ts 拆开的原因：@geoarrow/deck.gl-geoarrow 内部用无扩展名的相对 import，
 * Node ESM 解析不了（tsc 编译产物无法直接 import 测试），但 bundler 能处理——所以图层构造放
 * geoarrow-charts.ts（走 client bundle + GUI 验证），纯逻辑放这里可单测。
 */
import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon, MultiPolygon } from 'geojson'
import type { Table } from 'apache-arrow'

/** #rrggbb / #rgb → [r, g, b]；非法输入回退默认橙红 #f97316（与 RESULT_COLORS[0] 一致）。 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return [249, 115, 22]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 坐标对是否有效（非法坐标会让 deck 渲染中断 interleaved 帧）。 */
export function validPos(p: number[] | undefined | null): boolean {
  return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

/** 只留合法 Point 要素（geojson 原始点渲染的数据源；非法坐标/非点跳过）。 */
export function rawPointData(fc: FeatureCollection): Feature<Point>[] {
  return (fc.features ?? []).filter(
    (f): f is Feature<Point> => f?.geometry?.type === 'Point' && validPos((f.geometry as Point).coordinates),
  )
}

/** 只留合法线要素（geojson 原始线渲染的数据源；顶点坐标非法整条跳过）。 */
export function rawLineData(fc: FeatureCollection): Feature<LineString | MultiLineString>[] {
  return (fc.features ?? []).filter((f): f is Feature<LineString | MultiLineString> => {
    const g = f?.geometry
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return false
    const coords = g.coordinates
    const parts = g.type === 'LineString' ? [coords] : coords
    return parts.every((line) => Array.isArray(line) && line.length > 0 && line.every((p) => validPos(p as number[])))
  })
}

/** 只留合法面要素（geojson 原始面渲染的数据源；环顶点非法跳过）。 */
export function rawPolygonData(fc: FeatureCollection): Feature<Polygon | MultiPolygon>[] {
  return (fc.features ?? []).filter((f): f is Feature<Polygon | MultiPolygon> => {
    const g = f?.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return false
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    return polys.every((rings) =>
      Array.isArray(rings) && rings.length > 0 && rings.every((ring) => ring.length > 0 && ring.every((p) => validPos(p as number[]))),
    )
  })
}

/** geojson 要素的几何类型（deck 原始数据分派用；多类型混合取首个非空）。 */
export function geojsonKindOf(fc: FeatureCollection): 'point' | 'line' | 'polygon' | 'other' {
  for (const f of fc.features ?? []) {
    const t = f?.geometry?.type
    if (t === 'Point' || t === 'MultiPoint') return 'point'
    if (t === 'LineString' || t === 'MultiLineString') return 'line'
    if (t === 'Polygon' || t === 'MultiPolygon') return 'polygon'
  }
  return 'other'
}

/** geojson 里实际出现的几何族（point/line/polygon；deck geojson 渲染一族一层，混合数据不静默丢族）。 */
export function geojsonFamilies(fc: FeatureCollection): Array<'point' | 'line' | 'polygon'> {
  const out = new Set<'point' | 'line' | 'polygon'>()
  for (const f of fc.features ?? []) {
    const t = f?.geometry?.type
    if (t === 'Point' || t === 'MultiPoint') out.add('point')
    else if (t === 'LineString' || t === 'MultiLineString') out.add('line')
    else if (t === 'Polygon' || t === 'MultiPolygon') out.add('polygon')
  }
  return [...out]
}

/** 读 GeoArrow 表几何列的扩展类型名（geoarrow.point / geoarrow.linestring / ...），用于分派渲染图层。 */
export function geometryKindOf(table: Table): 'point' | 'line' | 'polygon' | 'other' {
  for (const f of table.schema.fields) {
    const ext = f.metadata.get('ARROW:extension:name') ?? ''
    if (ext === 'geoarrow.point' || ext === 'geoarrow.multipoint') return 'point'
    if (ext === 'geoarrow.linestring' || ext === 'geoarrow.multilinestring') return 'line'
    if (ext === 'geoarrow.polygon' || ext === 'geoarrow.multipolygon') return 'polygon'
  }
  return 'other'
}
