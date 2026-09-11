/**
 * 从**底图矢量瓦片**里提取要素（当前视窗、当前 zoom）。
 *
 * 这是「导出地图上的河流」这类需求的实现：数据本来就在内存里 —— maplibre 已经把
 * MVT 解码成了带经纬度的 GeoJSON 要素，只是没人去问它要。
 *
 * 为什么不用像素追踪：
 * - 几何是 OSM 原始几何，**精确**；像素追踪是从颜色反推，受底图对比度限制（实测路面与背景只差 5~8 色阶）。
 * - 河流在瓦片里**本来就是分段但连续的要素**；像素分割会把它切成 15~20 个碎块还要靠方向猜连接。
 * - 道路在瓦片里**本来就是独立要素**；像素层面整个路网是一个连通块，"一条路"根本不存在。
 *
 * 边界（与"我们不是爬虫"一致）：`querySourceFeatures` 只覆盖**已加载的瓦片** = 视口 + buffer。
 * 不主动请求额外瓦片，不跨 zoom 取，所以是零网络请求的（瓦片是渲染当前画面时就已经加载的）。
 */
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry } from 'geojson'

export interface ExtractOptions {
  /** MVT 的 source-layer 名（如 'waterway' / 'transportation'）。 */
  sourceLayer: string
  /** 只保留 name 属性包含该字符串的要素（如 '白浪河'）。 */
  name?: string
  /** 只保留 class 属性命中的要素（如 ['river','canal']）。 */
  classes?: string[]
  /** 按 name 归组：每条河一个 MultiLineString 要素（默认 true）。 */
  group?: boolean
}

/** 提取结果：成功给要素集合与统计；失败给可直接展示给用户的说明。 */
export type ExtractResult =
  | {
      ok: true
      geojson: FeatureCollection
      /** 实际的矢量源 id 与 source-layer（诊断/回执用）。 */
      source: string
      /** 归组前命中的要素数。 */
      rawCount: number
      /** 去重后、归组前的要素数。 */
      dedupedCount: number
      /** 按 name 归组后的要素数（group=false 时等于 dedupedCount）。 */
      featureCount: number
      /** 命中的名字清单（去重、最多 40 个）。 */
      names: string[]
      /** 类目分布。 */
      classes: Record<string, number>
    }
  | { ok: false; message: string }

/** 几何的稳定指纹：坐标取到 6 位小数后序列化（用于没有 feature.id 时兜底去重）。 */
function geometryKey(g: Geometry | null | undefined): string {
  if (!g) return 'null'
  const round = (coords: unknown): unknown => {
    if (typeof coords === 'number') return Number(coords.toFixed(6))
    return Array.isArray(coords) ? coords.map(round) : coords
  }
  return `${g.type}:${JSON.stringify(round((g as { coordinates?: unknown }).coordinates))}`
}

/**
 * 去重：优先按 `feature.id`（实测瓦片要素 100% 带 id），没有 id 时按几何指纹。
 * 瓦片有 buffer，跨边界的要素会在相邻两块瓦片里各出现一次 —— 但实测重复率极低（约 1%）。
 */
export function dedupeFeatures(features: MapGeoJSONFeature[]): MapGeoJSONFeature[] {
  const seenId = new Set<string | number>()
  const seenGeom = new Set<string>()
  const out: MapGeoJSONFeature[] = []
  for (const f of features) {
    if (f.id != null) {
      const k = typeof f.id === 'number' ? `n${f.id}` : `s${f.id}`
      if (seenId.has(k)) continue
      seenId.add(k)
      out.push(f)
    } else {
      const k = geometryKey(f.geometry as Geometry)
      if (seenGeom.has(k)) continue
      seenGeom.add(k)
      out.push(f)
    }
  }
  return out
}

/** 要素的 name 属性（去空白）。 */
function nameOf(f: MapGeoJSONFeature): string {
  const n = (f.properties as Record<string, unknown> | null)?.name
  return typeof n === 'string' ? n.trim() : ''
}

/**
 * 按 name 归组：同名要素合并成一个 MultiLineString（或 MultiPolygon / MultiPoint）。
 * 瓦片按 z/x/y 切分，同一条河在视窗内天然是十几段 —— 用户说「导出白浪河」时想要的是一条河，
 * 不是 16 个线段。无名字的要素各自独立成要素（不强行合并）。
 */
export function groupFeaturesByName(features: MapGeoJSONFeature[]): Feature[] {
  const groups = new Map<string, MapGeoJSONFeature[]>()
  const unnamed: MapGeoJSONFeature[] = []
  for (const f of features) {
    const n = nameOf(f)
    if (!n) { unnamed.push(f); continue }
    const g = groups.get(n)
    if (g) g.push(f)
    else groups.set(n, [f])
  }
  const out: Feature[] = []
  for (const [name, feats] of groups) {
    const parts = feats.map((f) => f.geometry).filter((g): g is Geometry => !!g)
    if (parts.length === 0) continue
    const single = parts.length === 1 ? parts[0]! : multiOf(parts)
    out.push({
      type: 'Feature',
      // 归组后保留第一段的属性（同一 name 的 class 通常一致），另加段数便于核对
      properties: { ...(feats[0]!.properties ?? {}), __segments: parts.length },
      geometry: single,
    } as Feature)
  }
  for (const f of unnamed) out.push(f as unknown as Feature)
  return out
}

/** 把多个同类型几何并成一个 Multi*；类型不一致时退回 GeometryCollection。 */
function multiOf(parts: Geometry[]): Geometry {
  const t = parts[0]!.type
  const same = parts.every((p) => p.type === t)
  if (same && (t === 'LineString' || t === 'Polygon' || t === 'Point')) {
    const multi = `Multi${t}` as 'MultiLineString' | 'MultiPolygon' | 'MultiPoint'
    return { type: multi, coordinates: parts.map((p) => (p as { coordinates: unknown }).coordinates) } as Geometry
  }
  return { type: 'GeometryCollection', geometries: parts } as Geometry
}

/**
 * 从当前底图的矢量瓦片里提取要素。
 *
 * 源 id 因底图而异（Carto → 'carto'、OpenFreeMap → 'openmaptiles'），所以遍历当前样式里的
 * 矢量源逐个尝试，谁有该 source-layer 就用谁。
 */
export function extractBasemapFeatures(map: MapLibreMap, opts: ExtractOptions): ExtractResult {
  const style = map.getStyle()
  const vectorSources = Object.entries(style?.sources ?? {})
    .filter(([, s]) => (s as { type?: string }).type === 'vector')
    .map(([id]) => id)

  if (vectorSources.length === 0) {
    return {
      ok: false,
      message: '当前底图是光栅瓦片，没有可提取的矢量数据。请先切换到矢量底图'
        + '（OpenFreeMap Liberty / Carto Positron / Carto Voyager / Carto Dark），再重新导出。',
    }
  }

  let source = ''
  let hits: MapGeoJSONFeature[] = []
  for (const id of vectorSources) {
    if (!map.getSource(id)) continue
    const found = map.querySourceFeatures(id, { sourceLayer: opts.sourceLayer })
    if (found.length > 0) { source = id; hits = found; break }
  }

  if (hits.length === 0) {
    return {
      ok: false,
      message: `当前视野内没有「${opts.sourceLayer}」的矢量要素`
        + '（可能缩放级别太低该图层未生成，或视野内确实没有这类地物）。'
        + '可以放大地图后再试，或换一个图层名。',
    }
  }

  const rawCount = hits.length
  let filtered = dedupeFeatures(hits)
  if (opts.name) {
    const want = opts.name
    filtered = filtered.filter((f) => nameOf(f).includes(want))
  }
  if (opts.classes && opts.classes.length > 0) {
    const want = new Set(opts.classes)
    filtered = filtered.filter((f) => {
      const c = (f.properties as Record<string, unknown> | null)?.class
      return typeof c === 'string' && want.has(c)
    })
  }

  if (filtered.length === 0) {
    const names = [...new Set(hits.map(nameOf).filter(Boolean))].slice(0, 20)
    return {
      ok: false,
      message: `按条件筛选后没有匹配的要素（视野内共 ${rawCount} 个「${opts.sourceLayer}」要素`
        + `${names.length ? `，其中有名字的是：${names.join('、')}` : ''}）。`,
    }
  }

  const names = [...new Set(filtered.map(nameOf).filter(Boolean))].slice(0, 40)
  const classes: Record<string, number> = {}
  for (const f of filtered) {
    const c = (f.properties as Record<string, unknown> | null)?.class
    const k = typeof c === 'string' ? c : '未知'
    classes[k] = (classes[k] ?? 0) + 1
  }

  const grouped = opts.group !== false
  const features = grouped ? groupFeaturesByName(filtered) : (filtered as unknown as Feature[])

  return {
    ok: true,
    geojson: { type: 'FeatureCollection', features } as FeatureCollection,
    source,
    rawCount,
    dedupedCount: filtered.length,
    featureCount: features.length,
    names,
    classes,
  }
}
